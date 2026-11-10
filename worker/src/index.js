/**
 * Bounty Radar API (Cloudflare Worker)
 *
 *   GET  /v1/listings, /v1/listings/{id}, /v1/sources, /v1/stats, /v1/diff   metered
 *   GET  /v1/keys/me               key status: plan, usage, limit (metered)
 *   POST /v1/keys                  create a free key (max 5/day per IP)
 *   POST /v1/webhooks/stripe       Stripe events -> paid plan (signature-verified, unmetered)
 *   GET  /, /openapi.json, /v1/launch                                        unmetered
 *
 * Bindings (wrangler.toml): KV namespaces KEYS and SNAPSHOTS.
 * Vars:    FEED_URL, SITE_URL, CACHE_TTL_MS, FREE_DAILY_LIMIT,
 *          CHECKOUT_URL_AGENT, CHECKOUT_URL_TEAM, QUOTA_FLUSH_MS, QUOTA_SYNC_MS
 * Secrets: STRIPE_SECRET (the webhook endpoint's signing secret, whsec_...)
 *
 * Quota and Workers KV limits
 * ---------------------------
 * KV has no atomic increment or compare-and-swap, is eventually consistent
 * (a write can take 60s or more to show up elsewhere, and reading your own
 * write back is not guaranteed even in the same location), accepts at most
 * one write per second to the same key, and on the free plan 1,000 writes
 * per day. A read-check-write against KV per request is therefore both racy
 * and unable to keep up with a burst.
 *
 * So the counter that decides is in memory, one per id per isolate. The
 * check-and-increment runs without an `await` in between, which makes it
 * atomic inside an isolate: N parallel requests against a limit of L let
 * exactly L through. KV is used to seed that counter (so a new isolate picks
 * up where the last one left off) and receives coalesced write-behind
 * updates, at most one per key per QUOTA_FLUSH_MS.
 *
 * What this does not give you: a single global counter. Two isolates (or two
 * Cloudflare locations) each enforce the limit against their own view and
 * only learn about each other through KV, so a client spread across isolates
 * can overshoot by roughly (isolates x requests made within the flush/sync
 * window). Increments not yet flushed are lost if an isolate is killed. Exact
 * global enforcement needs a Durable Object or the Rate Limiting binding.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining",
};

const PLANS = {
  free: { limit: null },                 // FREE_DAILY_LIMIT per IP, 10x that per key
  agent: { limit: 5000 },                // $15/mo
  team: { limit: 25000 },                // $79/mo
};
const PAID_PLANS = ["agent", "team"];

const DAY_MS = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const posInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** An error that maps to a specific HTTP status; anything else is a 500. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ponytail: duplicate of mcp-server.mjs filter logic (~40 lines, stable); extract
// to a shared module only if both start drifting.
const inferType = (b) =>
  ({ "algora-jobs": "job", "algora-challenge": "challenge", "algora-mention": "discussion" }[b.source] ?? "bounty");

const listingId = (b) => b.id ?? (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`);

const ESCROW_OK = (e) =>
  e === "algora-escrow" || e === "opire-stripe" ||
  (e ?? "").startsWith("algora challenge") || (e ?? "").startsWith("direct employment");

function summarize(b) {
  return {
    id: listingId(b),
    title: b.title,
    url: b.url,
    amount_usd: b.amountUsd ?? null,
    score: b.score ?? null,
    source: b.source,
    type: inferType(b),
    escrow: b.escrow ?? null,
    age_days: b.ageDays ?? null,
    open_competing_prs: b.openCompetingPrs ?? null,
    claim_count: b.claimCount ?? null,
    desc: b.desc ?? undefined,
  };
}

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;

/** `limit` query value -> integer in [1, LIMIT_MAX]; missing or non-numeric -> default. */
function clampLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(n), 1), LIMIT_MAX);
}

/**
 * Normalize the query into the parameters that actually shape the response.
 * Used both to filter and as the ETag input, so two requests share an ETag
 * exactly when they are the same effective query.
 */
function parseListingQuery(searchParams) {
  const p = Object.fromEntries(searchParams);
  const num = (v) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const list = (v) => {
    const items = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return items.length ? [...new Set(items)].sort() : null;
  };
  return {
    min_score: num(p.min_score),
    min_amount: num(p.min_amount),
    max_age_days: num(p.max_age_days),
    source: list(p.source),
    type: list(p.type),
    escrow_only: p.escrow_only === "1" || p.escrow_only === "true",
    q: p.q ? p.q.toLowerCase() : null,
    sort: ["amount", "freshness"].includes(p.sort) ? p.sort : "score",
    limit: clampLimit(p.limit),
  };
}

function applyFilters(items, p) {
  let out = [...items];
  if (p.min_score != null) out = out.filter((b) => (b.score ?? 0) >= p.min_score);
  if (p.min_amount != null) out = out.filter((b) => (b.amountUsd ?? 0) >= p.min_amount);
  if (p.max_age_days != null) out = out.filter((b) => b.ageDays == null || b.ageDays <= p.max_age_days);
  if (p.source) out = out.filter((b) => p.source.includes(b.source));
  if (p.type) out = out.filter((b) => p.type.includes(inferType(b)));
  if (p.escrow_only) out = out.filter((b) => ESCROW_OK(b.escrow));
  if (p.q) {
    out = out.filter((b) =>
      [b.title, b.org, b.repo, b.desc].some((s) => (s ?? "").toLowerCase().includes(p.q)));
  }
  const cmp = {
    amount: (a, b) => (b.amountUsd ?? -1) - (a.amountUsd ?? -1),
    freshness: (a, b) => (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9),
  }[p.sort] ?? ((a, b) => (b.score ?? 0) - (a.score ?? 0));
  out.sort(cmp);
  return out;
}

// --- API keys ----------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

function bearer(request) {
  const h = request.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function getKeyRecord(env, key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return null;
  return JSON.parse((await env.KEYS.get(`key:${key}`)) ?? "null");
}

const freeIpLimit = (env) => posInt(env.FREE_DAILY_LIMIT, 100);
const freeKeyLimit = (env) => freeIpLimit(env) * 10;
const planLimit = (env, plan) => PLANS[plan]?.limit ?? freeKeyLimit(env);

/**
 * The plan a key is entitled to right now. A paid plan only counts while
 * `paid_until` is in the future; a missing or unparseable `paid_until` fails
 * closed to free.
 */
function effectivePlan(rec, now = Date.now()) {
  if (!PAID_PLANS.includes(rec?.plan)) return "free";
  const until = Date.parse(rec.paid_until ?? "");
  return Number.isFinite(until) && until > now ? rec.plan : "free";
}

/** Payment Link with the buyer's key attached, so the webhook can find the key. */
function checkoutUrl(base, key) {
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set("client_reference_id", key);
    return url.toString();
  } catch {
    return null;
  }
}
const checkoutUrls = (env, key) => ({
  agent: checkoutUrl(env.CHECKOUT_URL_AGENT, key),
  team: checkoutUrl(env.CHECKOUT_URL_TEAM, key),
});

// --- quota (see the file header for the model and its limits) ----------------

const USAGE_TTL_S = 2 * 86400;
const USAGE_MAX_ENTRIES = 5000;
const FLUSH_LOST_AFTER_MS = 15_000; // a scheduled flush this overdue is assumed dead
const KEYS_PER_IP_PER_DAY = 5;

/** id -> { day, count, dirty, syncedAt, flushDueAt, flushing } for this isolate. */
const usageMem = new Map();

const usageKey = (id, day) => `usage:${id}:${day}`;

function usageState(id, day) {
  let st = usageMem.get(id);
  if (!st || st.day !== day) {
    st = { day, count: 0, dirty: 0, syncedAt: 0, flushDueAt: 0, flushing: false };
    usageMem.set(id, st);
    if (usageMem.size > USAGE_MAX_ENTRIES) pruneUsage(id);
  }
  return st;
}

/** Drop the oldest entries whose count is fully persisted; they re-seed from KV. */
function pruneUsage(keepId) {
  const target = Math.floor(USAGE_MAX_ENTRIES * 0.9);
  for (const [id, st] of usageMem) {
    if (usageMem.size <= target) break;
    if (id !== keepId && st.dirty === 0 && !st.flushing) usageMem.delete(id);
  }
}

async function readUsage(env, id, day) {
  const raw = await env.KEYS.get(usageKey(id, day));
  if (raw == null) return 0;
  const parsed = JSON.parse(raw);
  const n = Number(typeof parsed === "object" && parsed !== null ? parsed.count : parsed);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Count one request against `limit` for `id`. Returns { ok, used }.
 * Everything after the last `await` is synchronous, so the check and the
 * increment cannot interleave with another request in this isolate.
 */
async function consumeQuota(env, ctx, id, limit, floor = 0) {
  const day = today();
  let st = usageState(id, day);
  const now = Date.now();
  if (now - st.syncedAt >= posInt(env.QUOTA_SYNC_MS, 60_000)) {
    // A counter that has never been seeded must wait for KV. One that is only
    // due a refresh is claimed here so concurrent requests keep serving from
    // memory. Each request does its own read: none waits on another's I/O.
    if (st.syncedAt > 0) st.syncedAt = now;
    let stored = null;
    try {
      stored = await readUsage(env, id, day);
    } catch (e) {
      console.warn(`[quota] KV read failed for ${id}; using the in-memory count: ${e.message}`);
    }
    if (today() !== day) return consumeQuota(env, ctx, id, limit, 0); // crossed midnight mid-read
    st = usageState(id, day);
    if (stored != null) {
      st.count = Math.max(st.count, stored + st.dirty);
      st.syncedAt = Date.now();
    }
  }
  // ---- synchronous from here: check, increment, schedule ----
  if (floor > st.count) st.count = floor;
  const ok = st.count < limit;
  if (ok) {
    st.count++;
    st.dirty++;
  }
  scheduleUsageFlush(env, ctx, id, st);
  return { ok, used: st.count };
}

/** One write-behind flush per id per QUOTA_FLUSH_MS, however many requests arrive. */
function scheduleUsageFlush(env, ctx, id, st) {
  if (st.dirty === 0) return;
  const now = Date.now();
  if (st.flushDueAt && now < st.flushDueAt + FLUSH_LOST_AFTER_MS) return;
  const delay = posInt(env.QUOTA_FLUSH_MS, 2000);
  st.flushDueAt = now + delay;
  const task = sleep(delay)
    .then(() => flushUsage(env, id, st))
    .catch((e) => console.warn(`[quota] flush failed for ${id}: ${e.message}`));
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

async function flushUsage(env, id, st) {
  st.flushDueAt = 0;
  // Never let two writes for one key race: an older value could land last.
  for (let waited = 0; st.flushing && waited < 5000; waited += 25) await sleep(25);
  if (st.dirty === 0) return;
  st.flushing = true;
  let taken = 0;
  try {
    let stored = 0;
    try {
      stored = await readUsage(env, id, st.day);
    } catch {
      // KV read failed: still persist what this isolate knows.
    }
    taken = st.dirty;
    st.dirty = 0;
    st.count = Math.max(st.count, stored + taken);
    await env.KEYS.put(usageKey(id, st.day), JSON.stringify({ count: st.count }), { expirationTtl: USAGE_TTL_S });
    st.syncedAt = Date.now();
  } catch (e) {
    st.dirty += taken; // keep it for the next flush
    throw e;
  } finally {
    st.flushing = false;
  }
}

async function checkQuota(env, ctx, request, key) {
  if (key) {
    const rec = await getKeyRecord(env, key);
    if (!rec || rec.status === "disabled") return { ok: false, status: 401, error: "invalid or disabled API key" };
    const plan = effectivePlan(rec);
    const limit = planLimit(env, plan);
    // Usage used to live inside the key record; honour today's value once.
    const legacy = rec.usage?.day === today() ? Number(rec.usage.count) || 0 : 0;
    const q = await consumeQuota(env, ctx, `key:${key}`, limit, legacy);
    return q.ok
      ? { ok: true, limit, used: q.used, plan, rec }
      : { ok: false, status: 429, error: `daily limit ${limit} reached`, limit, used: q.used, plan };
  }
  const limit = freeIpLimit(env);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const q = await consumeQuota(env, ctx, `ip:${ip}`, limit);
  return q.ok
    ? { ok: true, limit, used: q.used, plan: "anonymous" }
    : { ok: false, status: 429, error: `daily limit ${limit} reached — create a free key for 10x`, limit, used: q.used, plan: "anonymous" };
}

/** Seconds until the daily counters reset (next UTC midnight). */
const secondsToReset = () => Math.max(1, Math.ceil((DAY_MS - (Date.now() % DAY_MS)) / 1000));

function withRateHeaders(res, quota) {
  if (quota.limit == null) return res;
  res.headers.set("X-RateLimit-Limit", String(quota.limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, quota.limit - quota.used)));
  if (!quota.ok && quota.status === 429) res.headers.set("Retry-After", String(secondsToReset()));
  return res;
}

async function handleCreateKey(env, ctx, request) {
  // abuse guard: a handful of keys per IP per day, counted like any other quota
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const guard = await consumeQuota(env, ctx, `keycreate:${ip}`, KEYS_PER_IP_PER_DAY);
  if (!guard.ok) {
    return json({ error: "too many keys created today" },
      { status: 429, request, headers: { "Retry-After": String(secondsToReset()) } });
  }

  const key = "brk_" + crypto.randomUUID().replace(/-/g, "");
  const rec = { key, plan: "free", status: "active", created: new Date().toISOString(), email: null };
  await env.KEYS.put(`key:${key}`, JSON.stringify(rec));
  return json(
    { data: { key, plan: "free", daily_limit: freeKeyLimit(env), upgrade_urls: checkoutUrls(env, key) } },
    { status: 201, request },
  );
}

function handleKeyMe(env, request, key, quota) {
  const { rec, plan, limit, used } = quota;
  return json(
    {
      data: {
        plan,
        status: rec.status,
        usage_today: used,
        daily_limit: limit,
        paid_until: rec.paid_until ?? null,
        plan_expired: PAID_PLANS.includes(rec.plan) && plan === "free",
        checkout_urls: checkoutUrls(env, key),
      },
    },
    { request },
  );
}

// --- Stripe webhook ----------------------------------------------------------
// Signature scheme v1: HMAC-SHA256 over `${t}.${rawBody}` with the endpoint's
// signing secret. Three independent protections against replays:
//   1. the signed timestamp must be within STRIPE_TOLERANCE_S of now;
//   2. each event id is processed once (memory claim + KV marker);
//   3. the grant is absolute, derived from the event's own time, so applying
//      the same event twice (possible across isolates, KV being eventually
//      consistent) leaves the record unchanged.

const STRIPE_TOLERANCE_S = 300;
const GRANT_MS = 31 * DAY_MS;          // one billing month, longest case
const RENEWAL_GRACE_MS = DAY_MS;       // slack for the next invoice to be paid
const EVENT_TTL_S = 35 * 86400;        // Stripe allows manual resends for 30 days
const HANDLED_EVENTS = ["checkout.session.completed", "invoice.paid"];
const EVENTS_MEM_MAX = 1000;

/** Event ids this isolate has processed or is processing. */
const eventsSeen = new Map();

function parseStripeSignature(header) {
  let t = null;
  const v1 = [];
  for (const part of String(header ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name === "t") t = value;
    else if (name === "v1") v1.push(value); // several during a secret roll; other schemes ignored
  }
  return { t, v1 };
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True if any v1 signature matches. `subtle.verify` compares in constant time. */
async function verifyStripeSignature(secret, t, body, signatures) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = enc.encode(`${t}.${body}`);
  let ok = false;
  for (const sig of signatures) {
    const bytes = hexToBytes(sig);
    if (bytes && bytes.length === 32 && (await crypto.subtle.verify("HMAC", key, bytes, data))) ok = true;
  }
  return ok;
}

/** Set plan and expiry. Expiry only ever moves forward within the same plan. */
function applyGrant(rec, plan, untilMs) {
  const prev = Date.parse(rec.paid_until ?? "");
  const keepPrev = rec.plan === plan && Number.isFinite(prev) && prev > untilMs;
  rec.plan = plan;
  rec.paid_until = new Date(keepPrev ? prev : untilMs).toISOString();
  delete rec.usage; // usage no longer lives in the key record
  return rec;
}

/** When the event happened, in ms: the event's `created`, else the signed timestamp. */
function eventTimeMs(event, t) {
  const created = Number(event.created);
  return (Number.isFinite(created) && created > 0 ? created : Number(t)) * 1000;
}

async function onCheckoutCompleted(env, event, t) {
  const session = event.data?.object ?? {};
  const key = session.client_reference_id ?? session.metadata?.key;
  const plan = session.metadata?.plan ?? "agent";
  if (!PAID_PLANS.includes(plan)) throw new HttpError(400, `unknown plan: ${plan}`);
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new HttpError(400, "checkout session carries no API key (client_reference_id)");
  }
  const rec = await getKeyRecord(env, key);
  if (!rec) throw new HttpError(404, "unknown API key");

  let until = eventTimeMs(event, t) + GRANT_MS;
  const sub = typeof session.subscription === "string" ? session.subscription : null;
  if (sub) {
    // The first invoice.paid can arrive before this event; it parks its period end here.
    const parked = Number(await env.KEYS.get(`stripe_sub_pending:${sub}`));
    if (Number.isFinite(parked) && parked > until) until = parked;
    rec.stripe_subscription = sub;
  }
  if (typeof session.customer === "string") rec.stripe_customer = session.customer;
  applyGrant(rec, plan, until);
  await env.KEYS.put(`key:${key}`, JSON.stringify(rec));
  if (sub) await env.KEYS.put(`stripe_sub:${sub}`, JSON.stringify({ key, plan }));
  return { plan, paid_until: rec.paid_until };
}

async function onInvoicePaid(env, event, t) {
  const inv = event.data?.object ?? {};
  // `subscription` moved under `parent.subscription_details` in newer API versions.
  const sub = [inv.subscription, inv.parent?.subscription_details?.subscription].find((v) => typeof v === "string");
  if (!sub) return { ignored: "invoice is not for a subscription" };

  const periodEnds = (inv.lines?.data ?? []).map((l) => Number(l?.period?.end)).filter((n) => Number.isFinite(n) && n > 0);
  const until = periodEnds.length
    ? Math.max(...periodEnds) * 1000 + RENEWAL_GRACE_MS
    : eventTimeMs(event, t) + GRANT_MS;

  const link = JSON.parse((await env.KEYS.get(`stripe_sub:${sub}`)) ?? "null");
  if (!link?.key) {
    // Events are not ordered: park the period for the checkout event to pick up.
    await env.KEYS.put(`stripe_sub_pending:${sub}`, String(until), { expirationTtl: EVENT_TTL_S });
    return { pending: "subscription not linked to a key yet" };
  }
  const rec = await getKeyRecord(env, link.key);
  if (!rec) throw new HttpError(404, "unknown API key");
  const plan = PAID_PLANS.includes(link.plan) ? link.plan : rec.plan;
  if (!PAID_PLANS.includes(plan)) throw new HttpError(400, `unknown plan: ${plan}`);
  applyGrant(rec, plan, until);
  await env.KEYS.put(`key:${link.key}`, JSON.stringify(rec));
  return { plan, paid_until: rec.paid_until };
}

async function handleStripeWebhook(env, request) {
  if (!env.STRIPE_SECRET) return json({ error: "stripe not configured" }, { status: 501, request });
  const body = await request.text();
  const { t, v1 } = parseStripeSignature(request.headers.get("Stripe-Signature"));
  if (!t || !/^\d{1,12}$/.test(t) || v1.length === 0) {
    return json({ error: "missing or malformed Stripe-Signature header" }, { status: 400, request });
  }
  if (!(await verifyStripeSignature(env.STRIPE_SECRET, t, body, v1))) {
    return json({ error: "invalid signature" }, { status: 400, request });
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > STRIPE_TOLERANCE_S) {
    return json({ error: `timestamp outside the ${STRIPE_TOLERANCE_S}s tolerance` }, { status: 400, request });
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "malformed JSON body" }, { status: 400, request });
  }
  if (typeof event?.id !== "string" || !event.id || typeof event.type !== "string") {
    return json({ error: "not a Stripe event (snapshot payload with id and type expected)" }, { status: 400, request });
  }
  if (!HANDLED_EVENTS.includes(event.type)) return json({ received: true, ignored: event.type }, { request });

  // Claim the event id before the first await, so a concurrent duplicate in
  // this isolate sees the claim. Released again if processing fails, so that
  // Stripe's retry gets a real attempt.
  if (eventsSeen.has(event.id)) return json({ received: true, duplicate: true }, { request });
  eventsSeen.set(event.id, Date.now());
  if (eventsSeen.size > EVENTS_MEM_MAX) eventsSeen.delete(eventsSeen.keys().next().value);
  try {
    if (await env.KEYS.get(`stripe_event:${event.id}`)) return json({ received: true, duplicate: true }, { request });
    const result = event.type === "invoice.paid"
      ? await onInvoicePaid(env, event, t)
      : await onCheckoutCompleted(env, event, t);
    try {
      await env.KEYS.put(`stripe_event:${event.id}`, new Date().toISOString(), { expirationTtl: EVENT_TTL_S });
    } catch (e) {
      // The grant is applied and is idempotent; a missing marker only costs a re-apply.
      console.warn(`[stripe] could not record event ${event.id}: ${e.message}`);
    }
    return json({ received: true, ...result }, { request });
  } catch (e) {
    eventsSeen.delete(event.id);
    throw e;
  }
}

// --- feed --------------------------------------------------------------------

let cache = { data: null, at: 0, inflight: null };
let momentumCache = { data: null, at: 0 };

async function getMomentum(env) {
  const ttl = Number(env.CACHE_TTL_MS ?? 600000);
  if (momentumCache.data && Date.now() - momentumCache.at < ttl) return momentumCache.data;
  try {
    const res = await fetch(`${env.SITE_URL}hn-momentum.json`, { headers: { "User-Agent": "bounty-radar-api/1.0" } });
    if (!res.ok) throw new Error(`momentum fetch ${res.status}`);
    const data = await res.json();
    momentumCache = { data, at: Date.now() };
    return data;
  } catch {
    return momentumCache.data ?? { samples: [] }; // chart may not exist yet pre-launch
  }
}

async function getFeed(env) {
  const ttl = Number(env.CACHE_TTL_MS ?? 600000);
  if (cache.data && Date.now() - cache.at < ttl) return { ...cache.data, cached: true };
  cache.inflight ??= (async () => {
    const res = await fetch(env.FEED_URL, { headers: { "User-Agent": "bounty-radar-api/1.0" } });
    if (!res.ok) throw new HttpError(502, `feed fetch ${res.status}`);
    return JSON.parse(await res.text());
  })();
  try {
    const data = await cache.inflight;
    cache = { data, at: Date.now(), inflight: null };
    return { ...data, cached: false };
  } catch (e) {
    cache.inflight = null;
    throw e instanceof HttpError ? e : new HttpError(502, `feed unavailable: ${e.message}`);
  }
}

// --- responses ---------------------------------------------------------------

/** RFC 9110 If-None-Match: a list of validators (weak comparison) or `*`. */
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((v) => v.trim().replace(/^W\//, "") === etag);
}

function json(obj, { status = 200, etag = null, request = null, headers: extra = null } = {}) {
  const body = JSON.stringify(obj, null, 2);
  const headers = { "Content-Type": "application/json", ...CORS, ...extra };
  if (etag) {
    headers.ETag = etag;
    if (etagMatches(request?.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status, headers });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- handlers ---------------------------------------------------------------

async function listing(request, env, id) {
  const feed = await getFeed(env);
  const b = (feed.bounties ?? []).find((x) => listingId(x) === id);
  if (!b) return json({ error: `listing not found: ${id}` }, { status: 404, request });
  return json({ data: { ...summarize(b), org: b.org, repo: b.repo, issue: b.issue }, meta: meta(feed) }, { request });
}

async function listings(request, env) {
  const feed = await getFeed(env);
  const query = parseListingQuery(new URL(request.url).searchParams);
  const items = applyFilters(feed.bounties ?? [], query);
  const data = items.slice(0, query.limit).map(summarize);
  // The validator covers the sweep and the effective query, so it can never
  // confirm a cached copy of a different query's results.
  const etag = `"l-${(await sha256Hex(`${feed.generatedAt}\n${JSON.stringify(query)}`)).slice(0, 32)}"`;
  return json(
    { data, meta: { ...meta(feed), total_matched: items.length, returned: data.length } },
    { request, etag },
  );
}

function meta(feed) {
  return { generated_at: feed.generatedAt, cached: feed.cached };
}

async function sources(env) {
  const feed = await getFeed(env);
  const bySource = {};
  for (const b of feed.bounties ?? []) bySource[b.source] = (bySource[b.source] ?? 0) + 1;
  return json({ data: { by_source: bySource, sweep_freshness: feed.generatedAt }, meta: meta(feed) }, {});
}

async function stats(env) {
  const feed = await getFeed(env);
  const items = feed.bounties ?? [];
  const scores = items.map((b) => b.score ?? 0).sort((a, b) => a - b);
  return json({
    data: {
      live_listings: items.length,
      total_known_usd: items.reduce((s, b) => s + (b.amountUsd ?? 0), 0),
      median_score: scores.length ? scores[Math.floor(scores.length / 2)] : null,
      by_type: items.reduce((m, b) => { const t = inferType(b); m[t] = (m[t] ?? 0) + 1; return m; }, {}),
    },
    meta: meta(feed),
  }, {});
}

// /v1/diff — cheap agent polling with per-listing granularity.
// "since" = meta.generated_at from a prior response. The worker stores each
// sweep's listings in KV; against the stored snapshot it reports added (new
// ids), removed (ids gone), and changed (amount/score/escrow/PR/claim moves).
// Unknown or evicted 'since' ⇒ graceful fallback: everything reports as added.
let snapshotStoredFor = null; // sweep this isolate has already written to KV

async function diff(request, env) {
  const p = Object.fromEntries(new URL(request.url).searchParams);
  const feed = await getFeed(env);
  const since = p.since ? new Date(p.since) : null;
  if (p.since && (Number.isNaN(since.getTime()) || since.getTime() > Date.now())) {
    return json({ error: "invalid 'since' (expect ISO timestamp from meta.generated_at)" }, { status: 400, request });
  }

  const current = (feed.bounties ?? []).map(summarize);
  const currentById = new Map(current.map((b) => [b.id, b]));

  let prevById = new Map();
  let snapshotFound = false;
  if (since && env.SNAPSHOTS) {
    const prev = await env.SNAPSHOTS.get(`sweep:${since.toISOString()}`, "json");
    if (prev) {
      snapshotFound = true;
      prevById = new Map(prev.map((b) => [b.id, b]));
    }
  }

  const FIELDS = ["amount_usd", "score", "escrow", "open_competing_prs", "claim_count"];
  const added = [];
  const changed = [];
  for (const [id, b] of currentById) {
    const prev = prevById.get(id);
    if (!prev) { added.push(b); continue; }
    const changes = {};
    for (const f of FIELDS) if (prev[f] !== b[f]) changes[f] = [prev[f] ?? null, b[f] ?? null];
    if (Object.keys(changes).length) changed.push({ ...b, _changes: changes });
  }
  const removed = [...prevById.keys()].filter((id) => !currentById.has(id));

  // Store this sweep for future diffs (30d TTL covers any realistic 'since').
  // Once per sweep per isolate: KV takes one write per second per key, so
  // writing on every request would start failing under any real traffic.
  if (env.SNAPSHOTS && snapshotStoredFor !== feed.generatedAt) {
    snapshotStoredFor = feed.generatedAt;
    try {
      await env.SNAPSHOTS.put(`sweep:${feed.generatedAt}`, JSON.stringify(current), { expirationTtl: 30 * 86400 });
    } catch (e) {
      snapshotStoredFor = null;
      console.warn(`[diff] snapshot write failed: ${e.message}`);
    }
  }

  return json(
    {
      data: { added, changed, removed },
      meta: {
        ...meta(feed),
        since: since ? since.toISOString() : null,
        snapshot_found: snapshotFound,
        counts: { added: added.length, changed: changed.length, removed: removed.length },
        note: snapshotFound
          ? "per-listing diff against stored sweep"
          : "no stored snapshot for 'since' — all current listings reported as added",
        next_poll_hint: "pass meta.generated_at as ?since= next time",
      },
    },
    { request },
  );
}

// --- launch dashboard --------------------------------------------------------
// API request counter for /v1/launch. KV free tier allows only 1k writes/day, so
// each isolate buffers counts in memory and flushes every 20 requests or 60s.
// Isolate races lose a few counts at the margins — fine for telemetry (this is a
// dashboard, not billing). ponytail: switch to Durable Objects if it ever needs
// to be exact.
let launchBuf = { day: today(), n: 0, lastFlush: 0 };

async function flushLaunch(env) {
  if (!launchBuf.n || !env.KEYS) return;
  const day = launchBuf.day;
  const n = launchBuf.n;
  launchBuf = { day: today(), n: 0, lastFlush: Date.now() };
  const k = `launch:api:${day}`;
  const prev = Number((await env.KEYS.get(k)) ?? 0);
  await env.KEYS.put(k, String(prev + n), { expirationTtl: 31 * 86400 });
}

function countRequest(env, ctx) {
  if (launchBuf.day !== today()) launchBuf = { day: today(), n: 0, lastFlush: launchBuf.lastFlush };
  launchBuf.n++;
  // Flush every 20 requests or 60s. If an isolate is evicted before flushing,
  // those counts are lost — accepted, this is telemetry not billing.
  if (launchBuf.n >= 20 || Date.now() - launchBuf.lastFlush > 60_000) {
    const task = flushLaunch(env).catch((e) => console.warn(`[launch] counter flush failed: ${e.message}`));
    if (ctx?.waitUntil) ctx.waitUntil(task);
  }
}

async function launch(request, env) {
  const [momentum, apiDays] = await Promise.all([
    getMomentum(env),
    (async () => {
      const byDay = {};
      if (env.KEYS) {
        const list = await env.KEYS.list({ prefix: "launch:api:" });
        for (const k of list.keys) byDay[k.name.slice("launch:api:".length)] = Number((await env.KEYS.get(k.name)) ?? 0);
      }
      return byDay;
    })(),
  ]);
  const samples = momentum.samples ?? [];
  const last = samples[samples.length - 1] ?? null;
  const total = Object.values(apiDays).reduce((s, n) => s + n, 0);
  return json(
    {
      data: {
        hn: {
          latest: last ? { pts: last.pts, comments: last.comments, stars: last.stars ?? null } : null,
          samples,
        },
        api: { requests_by_day: apiDays, total_tracked: total, note: "buffered counters — approximate (±few requests per isolate)" },
      },
      meta: { ...meta((await getFeed(env))), sample_count: samples.length },
    },
    { request },
  );
}

const RATE_LIMITED = { description: "Daily limit reached (Retry-After = seconds until the UTC-midnight reset)" };

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Bounty Radar API", version: "2.2.0",
    description: "Verified, machine-readable feed of payable open-source work. Anonymous use is rate-limited per IP; " +
      "send `Authorization: Bearer brk_…` for a higher daily limit. Metered responses carry X-RateLimit-Limit and X-RateLimit-Remaining." },
  servers: [{ url: "/" }],
  components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "Key from POST /v1/keys" } } },
  security: [{}, { apiKey: [] }],
  paths: {
    "/v1/listings": { get: { summary: "Search verified listings",
      parameters: [
        { name: "min_score", in: "query", schema: { type: "number" } },
        { name: "min_amount", in: "query", schema: { type: "number" } },
        { name: "max_age_days", in: "query", schema: { type: "number" } },
        { name: "source", in: "query", schema: { type: "string" }, description: "csv: algora,opire,github-label,algora-jobs,algora-challenge,algora-mention" },
        { name: "type", in: "query", schema: { type: "string" }, description: "csv: bounty,job,challenge,discussion" },
        { name: "escrow_only", in: "query", schema: { type: "boolean" } },
        { name: "q", in: "query", schema: { type: "string" } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["score", "amount", "freshness"] } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: LIMIT_MAX, default: LIMIT_DEFAULT },
          description: "Out-of-range values are clamped; non-numeric values fall back to the default." },
      ],
      responses: { "200": { description: "Listings + meta, with an ETag specific to this query and sweep" },
        "304": { description: "Not modified (send If-None-Match)" }, "429": RATE_LIMITED } } },
    "/v1/listings/{id}": { get: { summary: "One listing",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "URL-encoded listing id, e.g. acme%2Fwidgets%2312" }],
      responses: { "200": { description: "Listing" }, "400": { description: "Malformed id (invalid percent-encoding)" },
        "404": { description: "Not found" }, "429": RATE_LIMITED } } },
    "/v1/sources": { get: { summary: "Per-source counts + freshness", responses: { "200": { description: "OK" }, "429": RATE_LIMITED } } },
    "/v1/diff": { get: { summary: "New listings since your last poll (cheap polling)",
      parameters: [{ name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" },
        description: "meta.generated_at from your previous call. Omit on first call." }],
      responses: { "200": { description: "Listings newer than 'since' (empty if your last poll was after the latest sweep)" }, "429": RATE_LIMITED } } },
    "/v1/stats": { get: { summary: "Market pulse", responses: { "200": { description: "OK" }, "429": RATE_LIMITED } } },
    "/v1/launch": { get: { summary: "Launch dashboard: HN momentum + API usage", responses: { "200": { description: "Points/comments/stars samples + per-day API request counts" } } } },
    "/v1/keys": { post: { summary: "Create a free API key", security: [{}],
      responses: { "201": { description: "Key, daily limit and upgrade links" }, "429": { description: "Too many keys created from this IP today" } } } },
    "/v1/keys/me": { get: { summary: "Plan, usage and limit for the calling key", security: [{ apiKey: [] }],
      responses: { "200": { description: "Key status; a paid plan past paid_until reports as free" }, "401": { description: "Missing, invalid or disabled key" }, "429": RATE_LIMITED } } },
  },
};

const ROOT = {
  name: "bounty-radar-api", version: "2.2.0", docs: "/openapi.json",
  endpoints: ["/v1/listings", "/v1/listings/{id}", "/v1/diff", "/v1/sources", "/v1/stats", "/v1/launch", "/v1/keys (POST)", "/v1/keys/me"],
};

/** Metered routes. Returns null for anything else. */
function matchRoute(pathname) {
  if (pathname === "/v1/keys/me") return { name: "me" };
  if (pathname === "/v1/listings") return { name: "listings" };
  if (pathname.startsWith("/v1/listings/")) return { name: "listing", raw: pathname.slice("/v1/listings/".length) };
  if (pathname === "/v1/sources") return { name: "sources" };
  if (pathname === "/v1/diff") return { name: "diff" };
  if (pathname === "/v1/stats") return { name: "stats" };
  return null;
}

async function handle(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const read = request.method === "GET" || request.method === "HEAD";

  // Un-metered: Stripe (authenticated by signature), key creation (own
  // per-IP cap), spec and marketing endpoints.
  if (pathname === "/v1/webhooks/stripe") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, { status: 405, request, headers: { Allow: "POST" } });
    return handleStripeWebhook(env, request);
  }
  if (pathname === "/v1/keys") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, { status: 405, request, headers: { Allow: "POST" } });
    return handleCreateKey(env, ctx, request);
  }
  if (pathname === "/openapi.json") return json(OPENAPI, { request });
  if (pathname === "/v1/launch") return launch(request, env); // public: the launch dashboard
  if (pathname === "/") {
    const perIp = freeIpLimit(env);
    return json({ ...ROOT, auth: `Authorization: Bearer brk_… (optional; anonymous = ${perIp} req/day per IP, free key = ${perIp * 10}/day)` }, { request });
  }

  // Resolve and validate the route before spending any quota on it.
  const route = matchRoute(pathname);
  if (!route) return json({ error: "not found" }, { status: 404, request });
  if (!read) return json({ error: "method not allowed" }, { status: 405, request, headers: { Allow: "GET, HEAD" } });
  let id = null;
  if (route.name === "listing") {
    try {
      id = decodeURIComponent(route.raw);
    } catch {
      throw new HttpError(400, "malformed listing id: invalid percent-encoding");
    }
  }
  const key = bearer(request);
  if (route.name === "me" && !key) return json({ error: "API key required (Authorization: Bearer brk_…)" }, { status: 401, request });

  const quota = await checkQuota(env, ctx, request, key);
  if (!quota.ok) {
    const res = json({ error: quota.error, limit: quota.limit, usage: quota.used, create_key: "/v1/keys" }, { status: quota.status, request });
    return withRateHeaders(res, quota);
  }
  countRequest(env, ctx);

  let res;
  if (route.name === "me") res = handleKeyMe(env, request, key, quota);
  else if (route.name === "listings") res = await listings(request, env);
  else if (route.name === "listing") res = await listing(request, env, id);
  else if (route.name === "sources") res = await sources(env);
  else if (route.name === "diff") res = await diff(request, env);
  else res = await stats(env);
  return withRateHeaders(res, quota);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status, request });
      console.error("[worker] unhandled error:", e);
      return json({ error: "internal error" }, { status: 500, request });
    }
  },
};
