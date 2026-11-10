// Regression tests for /v1/listings. The audited failures: one ETag for every
// query (so a validator from one query confirmed another query's cache),
// limit=-1 returning 11 of 12, and a malformed %-escape in the id path
// surfacing as 502.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newIsolate, makeEnv, makeCtx, makeFeed, stubFeed, req } from "./helpers/worker-harness.mjs";

async function setup(t, feed = makeFeed(12)) {
  stubFeed(t, feed);
  return { worker: await newIsolate(), env: makeEnv({ FREE_DAILY_LIMIT: "1000" }), ctx: makeCtx() };
}

test("ETag is specific to the query", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const etag = async (path) => (await worker.fetch(req(path), env, ctx)).headers.get("ETag");

  const tags = {};
  for (const q of ["", "?sort=amount", "?sort=freshness", "?type=job", "?type=bounty", "?limit=1", "?limit=2", "?q=task", "?q=zzz", "?q=yyy", "?min_score=5", "?escrow_only=1", "?source=algora"]) {
    tags[q] = await etag(`/v1/listings${q}`);
    assert.match(tags[q], /^"l-[0-9a-f]{32}"$/, q);
  }
  assert.equal(new Set(Object.values(tags)).size, Object.keys(tags).length, "every distinct query gets its own ETag");
  await ctx.settle();
});

test("If-None-Match from another query is not honoured; from the same query it is", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const amount = await worker.fetch(req("/v1/listings?sort=amount"), env, ctx);
  const tag = amount.headers.get("ETag");

  const other = await worker.fetch(req("/v1/listings?type=job", { headers: { "If-None-Match": tag } }), env, ctx);
  assert.equal(other.status, 200);
  assert.equal((await other.json()).data.every((b) => b.type === "job"), true);

  const same = await worker.fetch(req("/v1/listings?sort=amount", { headers: { "If-None-Match": tag } }), env, ctx);
  assert.equal(same.status, 304);
  assert.equal(same.headers.get("ETag"), tag);
  assert.equal(await same.text(), "");

  // list and weak forms, as sent by caches and proxies
  for (const header of [`W/${tag}`, `"something-else", ${tag}`, "*"]) {
    const res = await worker.fetch(req("/v1/listings?sort=amount", { headers: { "If-None-Match": header } }), env, ctx);
    assert.equal(res.status, 304, header);
  }
  await ctx.settle();
});

test("equivalent queries share an ETag; a new sweep changes it", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const etag = async (w, path) => (await w.fetch(req(path), env, ctx)).headers.get("ETag");

  const base = await etag(worker, "/v1/listings?sort=amount&limit=5");
  assert.equal(await etag(worker, "/v1/listings?limit=5&sort=amount"), base, "parameter order");
  assert.equal(await etag(worker, "/v1/listings?sort=amount&limit=5&utm_source=x"), base, "parameters that do not affect the result");
  assert.equal(await etag(worker, "/v1/listings?sort=score"), await etag(worker, "/v1/listings"), "explicit default sort");
  assert.equal(await etag(worker, "/v1/listings?limit=-1"), await etag(worker, "/v1/listings?limit=1"), "clamped limit");
  assert.equal(await etag(worker, "/v1/listings?source=algora,github-label"), await etag(worker, "/v1/listings?source=github-label,%20algora"), "csv order");

  // same query against a newer sweep (fresh isolate, so no feed cache)
  t.mock.restoreAll();
  stubFeed(t, makeFeed(12, "2026-11-10T06:00:00.000Z"));
  const next = await newIsolate();
  assert.notEqual(await etag(next, "/v1/listings?sort=amount&limit=5"), base);
  await ctx.settle();
});

test("limit is clamped to 1..100 and meta.returned matches the data", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const cases = [
    ["-1", 1], ["0", 1], ["-999", 1], ["1", 1], ["2.9", 2], ["11", 11], ["12", 12],
    ["1000", 12], ["abc", 12], ["", 12], ["Infinity", 12], ["NaN", 12],
  ];
  for (const [limit, expected] of cases) {
    const body = await (await worker.fetch(req(`/v1/listings?limit=${limit}`), env, ctx)).json();
    assert.equal(body.data.length, expected, `limit=${limit}`);
    assert.equal(body.meta.returned, expected, `limit=${limit} meta.returned`);
    assert.equal(body.meta.total_matched, 12, `limit=${limit} total_matched`);
  }
  const all = await (await worker.fetch(req("/v1/listings"), env, ctx)).json();
  assert.equal(all.data.length, 12);
  await ctx.settle();
});

test("limit caps at 100 and defaults to 50 on a large feed", async (t) => {
  const { worker, env, ctx } = await setup(t, makeFeed(150));
  const count = async (q) => (await (await worker.fetch(req(`/v1/listings${q}`), env, ctx)).json()).data.length;
  assert.equal(await count(""), 50);
  assert.equal(await count("?limit=100"), 100);
  assert.equal(await count("?limit=5000"), 100);
  assert.equal(await count("?limit=-5"), 1);
  await ctx.settle();
});

test("malformed percent-encoding in /v1/listings/<id> is a 400, not a 502", async (t) => {
  const { worker, env, ctx } = await setup(t);
  for (const bad of ["%E0%A4%A", "%", "abc%zz", "acme%2Fwidgets%23%"]) {
    const res = await worker.fetch(req(`/v1/listings/${bad}`), env, ctx);
    assert.equal(res.status, 400, bad);
    assert.match((await res.json()).error, /percent-encoding/, bad);
    assert.equal(res.headers.get("X-RateLimit-Limit"), null, "rejected before any quota is spent");
  }
  await ctx.settle();
  assert.equal(env.KEYS.putsTo("usage:").length, 0);
});

test("a well-formed encoded id resolves; an unknown id is 404", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const found = await worker.fetch(req(`/v1/listings/${encodeURIComponent("acme/widgets#1")}`), env, ctx);
  assert.equal(found.status, 200);
  const { data } = await found.json();
  assert.deepEqual([data.id, data.org, data.repo, data.issue], ["acme/widgets#1", "acme", "widgets", 1]);

  const issueless = await worker.fetch(req(`/v1/listings/${encodeURIComponent("algora-jobs:org3:Engineer 3")}`), env, ctx);
  assert.equal(issueless.status, 200);

  const missing = await worker.fetch(req(`/v1/listings/${encodeURIComponent("acme/widgets#999")}`), env, ctx);
  assert.equal(missing.status, 404);
  await ctx.settle();
});

test("filters and sorting still work through the normalized query", async (t) => {
  const { worker, env, ctx } = await setup(t);
  const get = async (q) => (await (await worker.fetch(req(`/v1/listings${q}`), env, ctx)).json()).data;

  assert.deepEqual((await get("?sort=amount&limit=3")).map((b) => b.amount_usd), [1200, 1100, 1000]);
  assert.deepEqual((await get("?limit=3")).map((b) => b.score), [11, 10, 9]);
  assert.equal((await get("?type=job")).length, 3);
  assert.equal((await get("?source=algora,%20github-label")).length, 9);
  assert.equal((await get("?escrow_only=true")).every((b) => /escrow|direct/.test(b.escrow)), true);
  assert.equal((await get("?q=ENGINEER")).length, 3);
  assert.equal((await get("?min_score=10")).length, 2);
  await ctx.settle();
});

test("an unreachable feed is a 502 with the upstream status; other failures are a 500", async (t) => {
  t.mock.method(console, "error", () => {});
  stubFeed(t, () => new Response("gone", { status: 404 }));
  const worker = await newIsolate();
  const env = makeEnv();
  const ctx = makeCtx();

  const down = await worker.fetch(req("/v1/listings"), env, ctx);
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: "feed fetch 404" });

  t.mock.restoreAll();
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network down"); });
  const unreachable = await (await newIsolate()).fetch(req("/v1/stats"), env, ctx);
  assert.equal(unreachable.status, 502);

  // a corrupt key record is our bug, not the upstream's
  env.KEYS.store.set(`key:brk_${"e".repeat(32)}`, "{corrupt");
  const broken = await worker.fetch(req("/v1/stats", { key: `brk_${"e".repeat(32)}` }), env, ctx);
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: "internal error" });
  await ctx.settle();
});

test("/v1/diff stores each sweep snapshot once, not on every request", async (t) => {
  const { worker, env, ctx } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(req("/v1/diff"), env, ctx)).status, 200);
  assert.equal(env.SNAPSHOTS.puts.length, 1);

  const since = encodeURIComponent("2026-11-10T00:00:00.000Z");
  const diff = await (await worker.fetch(req(`/v1/diff?since=${since}`), env, ctx)).json();
  assert.equal(diff.meta.snapshot_found, true);
  assert.deepEqual(diff.meta.counts, { added: 0, changed: 0, removed: 0 });
  await ctx.settle();
});
