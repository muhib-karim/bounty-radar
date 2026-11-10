// Regression tests for the Worker's daily quota. The audited failure: 300
// parallel requests all passed a 100/day limit, because each one read the KV
// counter before any of them had written it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newIsolate, makeEnv, makeCtx, makeFeed, stubFeed, req, countStatus, utcDay, seedKey, API_KEY, MockKV,
} from "./helpers/worker-harness.mjs";

const burst = (worker, env, ctx, n, make) => Promise.all(Array.from({ length: n }, (_, i) => worker.fetch(make(i), env, ctx)));

test("300 parallel anonymous requests against a 100/day limit: exactly 100 pass", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv();
  const ctx = makeCtx();

  const responses = await burst(worker, env, ctx, 300, () => req("/v1/stats"));
  assert.equal(countStatus(responses, 200), 100);
  assert.equal(countStatus(responses, 429), 200);

  const denied = responses.find((r) => r.status === 429);
  assert.equal(denied.headers.get("X-RateLimit-Limit"), "100");
  assert.equal(denied.headers.get("X-RateLimit-Remaining"), "0");
  assert.ok(Number(denied.headers.get("Retry-After")) >= 1);
  const body = await denied.json();
  assert.equal(body.limit, 100);
  assert.equal(body.usage, 100);

  // the count is persisted once the write-behind flush has run
  await ctx.settle();
  assert.deepEqual(env.KEYS.json(`usage:ip:203.0.113.7:${utcDay()}`), { count: 100 });
});

test("300 parallel requests with one API key: exactly the key's limit pass, key record untouched", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "10" }); // free key = 10x = 100/day
  const ctx = makeCtx();
  seedKey(env);

  const responses = await burst(worker, env, ctx, 300, () => req("/v1/sources", { key: API_KEY }));
  assert.equal(countStatus(responses, 200), 100);
  assert.equal(countStatus(responses, 429), 200);

  await ctx.settle();
  assert.deepEqual(env.KEYS.json(`usage:key:${API_KEY}:${utcDay()}`), { count: 100 });
  // The quota path must never rewrite the key record: a stale write-back
  // could undo a plan change made by the Stripe webhook.
  assert.equal(env.KEYS.putsTo("key:").length, 0);
});

test("counters are per client: one IP exhausting its quota does not affect another", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "3" });
  const ctx = makeCtx();

  const a = await burst(worker, env, ctx, 10, () => req("/v1/stats", { ip: "203.0.113.1" }));
  assert.equal(countStatus(a, 200), 3);
  const b = await worker.fetch(req("/v1/stats", { ip: "203.0.113.2" }), env, ctx);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get("X-RateLimit-Remaining"), "2");
  await ctx.settle();
});

test("a new isolate picks the count up from KV instead of starting at zero", async (t) => {
  stubFeed(t);
  const env = makeEnv({ FREE_DAILY_LIMIT: "5" });
  const ctx = makeCtx();

  const first = await newIsolate();
  assert.equal(countStatus(await burst(first, env, ctx, 5, () => req("/v1/stats")), 200), 5);
  await ctx.settle();

  const second = await newIsolate();
  const res = await second.fetch(req("/v1/stats"), env, ctx);
  assert.equal(res.status, 429);
  await ctx.settle();
});

test("the limit still holds when KV rejects every write (1 write/sec per key, free-plan cap)", async (t) => {
  stubFeed(t);
  t.mock.method(console, "warn", () => {});
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "20" });
  const ctx = makeCtx();
  env.KEYS.failPuts = true;

  const responses = await burst(worker, env, ctx, 60, () => req("/v1/stats"));
  assert.equal(countStatus(responses, 200), 20);
  assert.equal(countStatus(responses, 429), 40);
  await ctx.settle();
});

test("requests are still served and counted when KV reads fail", async (t) => {
  stubFeed(t);
  t.mock.method(console, "warn", () => {});
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "4" });
  const ctx = makeCtx();
  env.KEYS.failGets = true;

  const responses = await burst(worker, env, ctx, 10, () => req("/v1/stats"));
  assert.equal(countStatus(responses, 200), 4);
  assert.equal(countStatus(responses, 429), 6);
  env.KEYS.failGets = false;
  await ctx.settle();
});

test("writes are coalesced: a burst costs a couple of KV writes, not one per request", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ QUOTA_FLUSH_MS: "250" });
  const ctx = makeCtx();

  await burst(worker, env, ctx, 300, () => req("/v1/stats"));
  await ctx.settle();
  const writes = env.KEYS.putsTo("usage:ip:");
  assert.ok(writes.length >= 1 && writes.length <= 2, `expected 1-2 usage writes, got ${writes.length}`);
  assert.equal(writes.at(-1).options.expirationTtl, 172800);
});

test("POST /v1/keys: 20 parallel creations from one IP yield exactly 5 keys", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ CHECKOUT_URL_AGENT: "https://buy.stripe.com/test_agent", CHECKOUT_URL_TEAM: "https://buy.stripe.com/test_team?locale=en" });
  const ctx = makeCtx();

  const responses = await burst(worker, env, ctx, 20, () => req("/v1/keys", { method: "POST" }));
  assert.equal(countStatus(responses, 201), 5);
  assert.equal(countStatus(responses, 429), 15);
  assert.equal(env.KEYS.putsTo("key:brk_").length, 5);

  // the upgrade links carry the new key, which is how the webhook finds it
  const { data } = await responses.find((r) => r.status === 201).json();
  assert.match(data.key, /^brk_[0-9a-f]{32}$/);
  assert.equal(data.daily_limit, 1000);
  assert.equal(new URL(data.upgrade_urls.agent).searchParams.get("client_reference_id"), data.key);
  const team = new URL(data.upgrade_urls.team);
  assert.equal(team.searchParams.get("client_reference_id"), data.key);
  assert.equal(team.searchParams.get("locale"), "en");
  await ctx.settle();
});

test("paid_until is enforced: an expired paid plan gets the free limit", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "1" }); // free key = 10/day
  const ctx = makeCtx();
  seedKey(env, API_KEY, { plan: "agent", paid_until: "2026-01-01T00:00:00.000Z" });

  const me = await (await worker.fetch(req("/v1/keys/me", { key: API_KEY }), env, ctx)).json();
  assert.equal(me.data.plan, "free");
  assert.equal(me.data.daily_limit, 10);
  assert.equal(me.data.plan_expired, true);
  assert.equal(me.data.paid_until, "2026-01-01T00:00:00.000Z");

  const responses = await burst(worker, env, ctx, 30, () => req("/v1/stats", { key: API_KEY }));
  assert.equal(countStatus(responses, 200), 9); // 10/day minus the /v1/keys/me call above
  await ctx.settle();
});

test("a paid plan inside its paid_until window gets the plan limit; one without paid_until does not", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv();
  const ctx = makeCtx();
  const other = `brk_${"b".repeat(32)}`;
  seedKey(env, API_KEY, { plan: "team", paid_until: new Date(Date.now() + 86_400_000).toISOString() });
  seedKey(env, other, { plan: "team" });

  const active = await (await worker.fetch(req("/v1/keys/me", { key: API_KEY }), env, ctx)).json();
  assert.deepEqual([active.data.plan, active.data.daily_limit, active.data.plan_expired], ["team", 25000, false]);
  const undated = await (await worker.fetch(req("/v1/keys/me", { key: other }), env, ctx)).json();
  assert.deepEqual([undated.data.plan, undated.data.daily_limit, undated.data.plan_expired], ["free", 1000, true]);
  await ctx.settle();
});

test("usage previously stored inside the key record is honoured after the upgrade", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "10" }); // free key = 100/day
  const ctx = makeCtx();
  seedKey(env, API_KEY, { usage: { day: utcDay(), count: 95 } });

  const responses = await burst(worker, env, ctx, 20, () => req("/v1/stats", { key: API_KEY }));
  assert.equal(countStatus(responses, 200), 5);
  await ctx.settle();
});

test("invalid, malformed and disabled keys get 401 and consume nothing", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv();
  const ctx = makeCtx();
  const disabled = `brk_${"d".repeat(32)}`;
  seedKey(env, disabled, { status: "disabled" });

  for (const key of [`brk_${"f".repeat(32)}`, "not a key!", "x".repeat(600), disabled]) {
    const res = await worker.fetch(req("/v1/stats", { key }), env, ctx);
    assert.equal(res.status, 401, `key ${key.slice(0, 12)}…`);
  }
  assert.equal((await worker.fetch(req("/v1/keys/me"), env, ctx)).status, 401);
  await ctx.settle();
  assert.equal(env.KEYS.putsTo("usage:").length, 0);
});

test("FREE_DAILY_LIMIT missing or invalid falls back to 100 rather than unlimited", async (t) => {
  stubFeed(t);
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: undefined });
  const ctx = makeCtx();

  const responses = await burst(worker, env, ctx, 130, () => req("/v1/stats"));
  assert.equal(countStatus(responses, 200), 100);
  await ctx.settle();
});

test("unmetered and unknown routes do not spend quota; /v1/launch sees the request counter", async (t) => {
  stubFeed(t, (url) => new Response(url.endsWith("hn-momentum.json") ? '{"samples":[]}' : JSON.stringify(makeFeed())));
  const worker = await newIsolate();
  const env = makeEnv({ FREE_DAILY_LIMIT: "30", KEYS: new MockKV() });
  const ctx = makeCtx();

  for (const path of ["/", "/openapi.json", "/v1/nope", "/v1/launch"]) await worker.fetch(req(path), env, ctx);
  assert.equal((await worker.fetch(req("/v1/nope"), env, ctx)).status, 404);
  assert.equal((await worker.fetch(req("/v1/stats", { method: "DELETE" }), env, ctx)).status, 405);
  const first = await worker.fetch(req("/v1/stats"), env, ctx);
  assert.equal(first.headers.get("X-RateLimit-Remaining"), "29");

  await burst(worker, env, ctx, 24, () => req("/v1/stats"));
  await ctx.settle();
  const launch = await (await worker.fetch(req("/v1/launch"), env, ctx)).json();
  assert.ok(launch.data.api.total_tracked >= 20, `launch counter saw ${launch.data.api.total_tracked} requests`);
});
