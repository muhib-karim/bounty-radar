// Shared scaffolding for the Worker tests: an in-memory KV namespace, a
// waitUntil collector, request/feed builders and a Stripe signing helper.
// No test in here; importing it has no side effects.

const WORKER_URL = new URL("../../worker/src/index.js", import.meta.url).href;
let isolates = 0;

/**
 * Import the Worker as a brand-new module instance. Module-level state (quota
 * counters, feed cache, seen Stripe events) is what an isolate owns, so each
 * call behaves like a fresh isolate. Pass the same env to share "KV".
 */
export async function newIsolate() {
  isolates += 1;
  return (await import(`${WORKER_URL}?isolate=${process.pid}-${isolates}`)).default;
}

/** Map-backed stand-in for a Workers KV namespace, with optional async lag. */
export class MockKV {
  constructor({ jitterMs = 0 } = {}) {
    this.store = new Map();
    this.puts = [];
    this.jitterMs = jitterMs;
    this.failPuts = false;
    this.failGets = false;
  }

  async #lag() {
    if (this.jitterMs) await new Promise((resolve) => setTimeout(resolve, Math.random() * this.jitterMs));
  }

  async get(key, type) {
    await this.#lag();
    if (this.failGets) throw new Error("KV GET failed: 500");
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value, options = {}) {
    await this.#lag();
    if (this.failPuts) throw new Error("KV PUT failed: 429 Too Many Requests");
    this.store.set(key, String(value));
    this.puts.push({ key, value: String(value), options });
  }

  async delete(key) {
    this.store.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  json(key) {
    const value = this.store.get(key);
    return value === undefined ? null : JSON.parse(value);
  }

  putsTo(prefix) {
    return this.puts.filter((p) => p.key.startsWith(prefix));
  }
}

/** ExecutionContext stand-in: collects waitUntil promises so tests can await them. */
export function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

export const FEED_URL = "https://feed.test/bounties.json";
export const STRIPE_SECRET = "whsec_testtesttesttest";
export const API_KEY = `brk_${"a".repeat(32)}`;

export function makeEnv(overrides = {}) {
  return {
    KEYS: new MockKV({ jitterMs: 2 }),
    SNAPSHOTS: new MockKV(),
    FEED_URL,
    SITE_URL: "https://site.test/",
    CACHE_TTL_MS: "600000",
    FREE_DAILY_LIMIT: "100",
    QUOTA_FLUSH_MS: "5",
    ...overrides,
  };
}

/** A feed with `n` listings across sources, scores 0..n-1 and distinct amounts. */
export function makeFeed(n = 12, generatedAt = "2026-11-10T00:00:00.000Z") {
  const bounties = Array.from({ length: n }, (_, i) => {
    if (i % 4 === 3) {
      return {
        source: "algora-jobs", org: `org${i}`, repo: null, issue: null, title: `Engineer ${i}`,
        url: `https://algora.io/org${i}/jobs`, amountUsd: null, ageDays: null,
        escrow: "direct employment/contract — negotiate directly", score: i,
      };
    }
    return {
      source: i % 2 ? "github-label" : "algora", org: "acme", repo: "widgets", issue: i + 1, title: `Task ${i}`,
      url: `https://github.com/acme/widgets/issues/${i + 1}`, amountUsd: (n - i) * 100, ageDays: i,
      escrow: i % 2 ? "unknown — verify escrow before investing time" : "algora-escrow", score: i,
    };
  });
  return { generatedAt, bounties };
}

/** Replace global fetch for one test; `feed` may be an object or a function returning a Response. */
export function stubFeed(t, feed = makeFeed()) {
  return t.mock.method(globalThis, "fetch", async (url) => {
    if (typeof feed === "function") return feed(String(url));
    if (String(url) === FEED_URL) return new Response(JSON.stringify(feed), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

export function req(path, { ip = "203.0.113.7", key = null, method = "GET", headers = {}, body = undefined } = {}) {
  const h = { "CF-Connecting-IP": ip, ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  return new Request(`https://api.test${path}`, { method, headers: h, body });
}

export const countStatus = (responses, status) => responses.filter((r) => r.status === status).length;
export const utcDay = () => new Date().toISOString().slice(0, 10);
export const nowSeconds = () => Math.floor(Date.now() / 1000);

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A Stripe-Signature header value for `body`, signed at time `t` (seconds). */
export async function stripeSignature(body, { t = nowSeconds(), secret = STRIPE_SECRET } = {}) {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)},v0=${"0".repeat(64)}`;
}

/** A signed webhook delivery, as Stripe would send it. */
export async function stripeRequest(event, { t = nowSeconds(), secret = STRIPE_SECRET, signature, ip = "198.51.100.20" } = {}) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  return req("/v1/webhooks/stripe", {
    method: "POST",
    ip,
    body,
    headers: { "Stripe-Signature": signature ?? (await stripeSignature(body, { t, secret })), "Content-Type": "application/json" },
  });
}

export function checkoutEvent({ id = "evt_checkout_1", key = API_KEY, plan = "agent", created = nowSeconds(), subscription = null } = {}) {
  return {
    id,
    type: "checkout.session.completed",
    created,
    data: { object: { id: "cs_test_1", client_reference_id: key, metadata: plan ? { plan } : {}, subscription, customer: "cus_test_1" } },
  };
}

export function seedKey(env, key = API_KEY, fields = {}) {
  env.KEYS.store.set(`key:${key}`, JSON.stringify({ key, plan: "free", status: "active", created: "2026-10-01T00:00:00.000Z", email: null, ...fields }));
}
