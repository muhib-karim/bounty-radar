// Regression tests for the Stripe webhook. The audited failures: a delivery
// signed with an ancient timestamp was accepted, replaying an event extended
// paid access every time, and paid_until was never checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newIsolate, makeEnv, makeCtx, stubFeed, req, seedKey, API_KEY, STRIPE_SECRET,
  stripeRequest, stripeSignature, checkoutEvent, nowSeconds, countStatus,
} from "./helpers/worker-harness.mjs";

const DAY_MS = 86_400_000;
const record = (env, key = API_KEY) => env.KEYS.json(`key:${key}`);

async function setup(t, envOverrides = {}) {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ STRIPE_SECRET, ...envOverrides });
  const ctx = makeCtx();
  seedKey(env);
  return { worker, env, ctx };
}

test("a fresh, correctly signed checkout upgrades the key for 31 days from the event time", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const created = nowSeconds() - 20;

  const res = await worker.fetch(await stripeRequest(checkoutEvent({ created, plan: "team" })), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.received, true);
  assert.equal(body.plan, "team");
  assert.equal(JSON.stringify(body).includes(API_KEY), false, "the response must not echo the API key");

  const rec = record(env);
  assert.equal(rec.plan, "team");
  assert.equal(Date.parse(rec.paid_until), created * 1000 + 31 * DAY_MS);

  const me = await (await worker.fetch(req("/v1/keys/me", { key: API_KEY }), env, ctx)).json();
  assert.deepEqual([me.data.plan, me.data.daily_limit], ["team", 25000]);
  await ctx.settle();
});

test("timestamps outside the 300s tolerance are rejected, even with a valid signature", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const now = nowSeconds();
  // The clock keeps running between here and the Worker's check, which only
  // makes an old timestamp older. A future one gets closer, so it needs margin.
  const cases = [
    ["from 2001", 1_000_000_000],
    ["301s old", now - 301],
    ["330s in the future", now + 330],
  ];
  for (const [label, ts] of cases) {
    const res = await worker.fetch(await stripeRequest(checkoutEvent({ id: `evt_${ts}`, created: ts }), { t: ts }), env, ctx);
    assert.equal(res.status, 400, label);
    assert.match((await res.json()).error, /tolerance/, label);
  }
  assert.equal(record(env).plan, "free");
  assert.equal(env.KEYS.putsTo("key:").length, 0);
});

test("timestamps just inside the tolerance are accepted", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const ts = nowSeconds() - 290;
  const res = await worker.fetch(await stripeRequest(checkoutEvent({ created: ts }), { t: ts }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(record(env).plan, "agent");
});

test("bad, missing and malformed signatures are rejected", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const event = checkoutEvent();
  const body = JSON.stringify(event);
  const good = await stripeSignature(body);
  const now = nowSeconds();
  const signatures = {
    "wrong secret": await stripeSignature(body, { secret: "whsec_someone_else" }),
    "signature for a different body": await stripeSignature(body.replace("agent", "team")),
    "timestamp swapped after signing": good.replace(/^t=\d+/, `t=${now - 5}`),
    "no v1": `t=${now}`,
    "no timestamp": good.replace(/^t=\d+,/, ""),
    "non-numeric timestamp": good.replace(/^t=\d+/, "t=abc"),
    "not hex": `t=${now},v1=zzzz`,
    "v0 only": `t=${now},v0=${"0".repeat(64)}`,
    empty: "",
  };
  for (const [label, signature] of Object.entries(signatures)) {
    const res = await worker.fetch(await stripeRequest(event, { signature }), env, ctx);
    assert.equal(res.status, 400, label);
  }
  const noHeader = req("/v1/webhooks/stripe", { method: "POST", body });
  assert.equal((await worker.fetch(noHeader, env, ctx)).status, 400);
  assert.equal(record(env).plan, "free");
});

test("a header with several v1 signatures (secret being rolled) verifies if any matches", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const event = checkoutEvent();
  const body = JSON.stringify(event);
  const ts = nowSeconds();
  const stale = (await stripeSignature(body, { t: ts, secret: "whsec_previous_secret" })).match(/v1=([0-9a-f]+)/)[1];
  const current = (await stripeSignature(body, { t: ts })).match(/v1=([0-9a-f]+)/)[1];
  // the matching signature may come first or last
  const first = await worker.fetch(await stripeRequest(event, { signature: `t=${ts},v1=${current},v1=${stale}` }), env, ctx);
  assert.equal(first.status, 200);
  assert.equal(record(env).plan, "agent");

  const other = { ...event, id: "evt_checkout_rolled" };
  const otherBody = JSON.stringify(other);
  const otherCurrent = (await stripeSignature(otherBody, { t: ts })).match(/v1=([0-9a-f]+)/)[1];
  const otherStale = (await stripeSignature(otherBody, { t: ts, secret: "whsec_previous_secret" })).match(/v1=([0-9a-f]+)/)[1];
  const last = await worker.fetch(await stripeRequest(other, { signature: `t=${ts},v1=${otherStale},v1=${otherCurrent}` }), env, ctx);
  assert.deepEqual([last.status, (await last.json()).duplicate], [200, undefined]);
});

test("replaying an event id is a no-op", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const event = checkoutEvent({ created: nowSeconds() - 60 });

  assert.equal((await worker.fetch(await stripeRequest(event), env, ctx)).status, 200);
  const first = record(env);
  const keyWrites = env.KEYS.putsTo("key:").length;

  const replay = await worker.fetch(await stripeRequest(event), env, ctx);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { received: true, duplicate: true });
  assert.deepEqual(record(env), first);
  assert.equal(env.KEYS.putsTo("key:").length, keyWrites);

  // a different isolate has no memory of the event but finds the KV marker
  const other = await newIsolate();
  const again = await other.fetch(await stripeRequest(event), env, ctx);
  assert.deepEqual(await again.json(), { received: true, duplicate: true });
  assert.equal(env.KEYS.putsTo("key:").length, keyWrites);
  assert.equal(env.KEYS.putsTo("stripe_event:")[0].options.expirationTtl, 35 * 86400);
});

test("a replay that slips past the idempotency marker still cannot extend access", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const event = checkoutEvent({ created: nowSeconds() - 120 });
  await worker.fetch(await stripeRequest(event), env, ctx);
  const first = record(env).paid_until;

  // KV is eventually consistent: simulate an isolate that cannot see the marker yet
  env.KEYS.store.delete(`stripe_event:${event.id}`);
  const other = await newIsolate();
  const res = await other.fetch(await stripeRequest(event), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(record(env).paid_until, first);
});

test("concurrent deliveries of one event apply it once", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const event = checkoutEvent();
  const deliveries = await Promise.all(Array.from({ length: 8 }, () => stripeRequest(event)));
  const responses = await Promise.all(deliveries.map((r) => worker.fetch(r, env, ctx)));

  assert.equal(countStatus(responses, 200), 8);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  assert.equal(bodies.filter((b) => b.duplicate).length, 7);
  assert.equal(env.KEYS.putsTo("key:").length, 1);
});

test("an older event never shortens access and a later one extends it", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const now = nowSeconds();
  await worker.fetch(await stripeRequest(checkoutEvent({ id: "evt_new", created: now - 10 })), env, ctx);
  const until = record(env).paid_until;

  // events are not delivered in order: an earlier payment arrives afterwards
  await worker.fetch(await stripeRequest(checkoutEvent({ id: "evt_old", created: now - 5 * 86400 })), env, ctx);
  assert.equal(record(env).paid_until, until);

  await worker.fetch(await stripeRequest(checkoutEvent({ id: "evt_newer", created: now })), env, ctx);
  assert.ok(Date.parse(record(env).paid_until) > Date.parse(until));
});

test("unknown plan and unknown key are rejected, and a corrected retry succeeds", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const stranger = `brk_${"c".repeat(32)}`;

  const badPlan = await worker.fetch(await stripeRequest(checkoutEvent({ id: "evt_plan", plan: "enterprise" })), env, ctx);
  assert.equal(badPlan.status, 400);
  assert.match((await badPlan.json()).error, /unknown plan/);

  const noKey = await worker.fetch(await stripeRequest(checkoutEvent({ id: "evt_nokey", key: null })), env, ctx);
  assert.equal(noKey.status, 400);

  const unknown = checkoutEvent({ id: "evt_key", key: stranger });
  const first = await worker.fetch(await stripeRequest(unknown), env, ctx);
  assert.equal(first.status, 404);
  assert.equal(JSON.stringify(await first.json()).includes(stranger), false);
  assert.equal(record(env).plan, "free");

  // the failed attempt must not have been recorded as processed: Stripe retries it
  seedKey(env, stranger);
  const retry = await worker.fetch(await stripeRequest(unknown), env, ctx);
  assert.equal(retry.status, 200);
  assert.equal(record(env, stranger).plan, "agent");
});

test("a signed but malformed or non-event body is a 400; unhandled event types are acknowledged", async (t) => {
  const { worker, env, ctx } = await setup(t);
  assert.equal((await worker.fetch(await stripeRequest("{not json"), env, ctx)).status, 400);
  assert.equal((await worker.fetch(await stripeRequest({ object: "event" }), env, ctx)).status, 400);

  const other = await worker.fetch(await stripeRequest({ id: "evt_x", type: "customer.created", data: { object: {} } }), env, ctx);
  assert.equal(other.status, 200);
  assert.deepEqual(await other.json(), { received: true, ignored: "customer.created" });
  assert.equal(record(env).plan, "free");
});

test("invoice.paid extends paid_until for the subscription's key (both invoice payload shapes)", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const now = nowSeconds();
  await worker.fetch(await stripeRequest(checkoutEvent({ created: now - 30, subscription: "sub_123" })), env, ctx);
  assert.equal(record(env).stripe_subscription, "sub_123");

  const periodEnd = now + 61 * 86400;
  const renewal = {
    id: "evt_invoice_1", type: "invoice.paid", created: now,
    data: { object: { id: "in_1", subscription: "sub_123", lines: { data: [{ period: { start: now, end: periodEnd } }] } } },
  };
  const res = await worker.fetch(await stripeRequest(renewal), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(Date.parse(record(env).paid_until), periodEnd * 1000 + DAY_MS);
  assert.equal(record(env).plan, "agent");

  const later = periodEnd + 30 * 86400;
  const newerShape = {
    id: "evt_invoice_2", type: "invoice.paid", created: now,
    data: { object: { id: "in_2", parent: { subscription_details: { subscription: "sub_123" } }, lines: { data: [{ period: { end: later } }] } } },
  };
  await worker.fetch(await stripeRequest(newerShape), env, ctx);
  assert.equal(Date.parse(record(env).paid_until), later * 1000 + DAY_MS);

  // replaying the first renewal changes nothing
  const before = record(env);
  const replay = await worker.fetch(await stripeRequest(renewal), env, ctx);
  assert.deepEqual(await replay.json(), { received: true, duplicate: true });
  assert.deepEqual(record(env), before);
});

test("invoice.paid that arrives before the checkout event is parked, then applied", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const now = nowSeconds();
  const periodEnd = now + 45 * 86400;
  const invoice = {
    id: "evt_invoice_first", type: "invoice.paid", created: now,
    data: { object: { id: "in_9", subscription: "sub_early", lines: { data: [{ period: { end: periodEnd } }] } } },
  };
  const parked = await worker.fetch(await stripeRequest(invoice), env, ctx);
  assert.equal(parked.status, 200);
  assert.ok((await parked.json()).pending);
  assert.equal(record(env).plan, "free");

  await worker.fetch(await stripeRequest(checkoutEvent({ created: now, subscription: "sub_early" })), env, ctx);
  assert.equal(record(env).plan, "agent");
  assert.equal(Date.parse(record(env).paid_until), periodEnd * 1000 + DAY_MS);
});

test("invoices that are not for a known subscription are acknowledged and ignored", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const oneOff = { id: "evt_invoice_oneoff", type: "invoice.paid", created: nowSeconds(), data: { object: { id: "in_7", subscription: null } } };
  const res = await worker.fetch(await stripeRequest(oneOff), env, ctx);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).ignored);
  assert.equal(record(env).plan, "free");
});

test("the webhook is not quota-gated and does not spend the sender's IP quota", async (t) => {
  const { worker, env, ctx } = await setup(t, { FREE_DAILY_LIMIT: "2" });
  const ip = "198.51.100.20";
  for (let i = 0; i < 5; i++) await worker.fetch(req("/v1/stats", { ip }), env, ctx); // exhaust that IP

  const res = await worker.fetch(await stripeRequest(checkoutEvent(), { ip }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-RateLimit-Limit"), null);
  await ctx.settle();
  assert.equal(env.KEYS.json(`usage:ip:${ip}:${new Date().toISOString().slice(0, 10)}`).count, 2);
});

test("webhook without STRIPE_SECRET is 501; non-POST is 405", async (t) => {
  const { worker, env, ctx } = await setup(t, { STRIPE_SECRET: undefined });
  assert.equal((await worker.fetch(await stripeRequest(checkoutEvent()), env, ctx)).status, 501);
  assert.equal((await worker.fetch(req("/v1/webhooks/stripe"), env, ctx)).status, 405);
});
