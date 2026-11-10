// Drives mcp-server.mjs over stdio exactly as an MCP client would, using a
// local fixture feed so no network access is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));
const FEED = fileURLToPath(new URL("./fixtures/feed.json", import.meta.url));

const FIRST_SEEN_FEED = fileURLToPath(new URL("./fixtures/feed-first-seen.json", import.meta.url));

function rpc(messages, feed = FEED) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, feed], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("mcp-server timed out")); }, 10_000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const replies = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve(Object.fromEntries(replies.map((r) => [r.id, r])));
    });
    child.stdin.end(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  });
}

const call = (id, name, args = {}) => ({ id, method: "tools/call", params: { name, arguments: args } });
const payload = (reply) => JSON.parse(reply.result.content[0].text);

test("initialize and tools/list advertise the four tools", async () => {
  const r = await rpc([
    { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
  ]);
  assert.equal(r[1].result.serverInfo.name, "bounty-radar");
  assert.deepEqual(r[1].result.capabilities, { tools: {} });
  const tools = r[2].result.tools;
  assert.deepEqual(tools.map((t) => t.name), ["search_bounties", "get_listing", "whats_new", "get_stats"]);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 20);
  }
  assert.deepEqual(tools[1].inputSchema.required, ["listing_id"]);
});

test("search_bounties filters, sorts and caps", async () => {
  const r = await rpc([
    call(1, "search_bounties"),
    call(2, "search_bounties", { min_score: 7, sort: "amount" }),
    call(3, "search_bounties", { escrow_only: true, type: "bounty" }),
    call(4, "search_bounties", { q: "csv", limit: 1 }),
    call(5, "search_bounties", { source: "algora-jobs,algora-challenge", sort: "score", limit: 1 }),
  ]);
  assert.equal(payload(r[1]).total_matched, 4);
  assert.deepEqual(payload(r[2]).listing_ids, ["algora-challenge:algora:Build a fast indexer", "acme/widgets#12", "algora-jobs:acme:TypeScript Engineer"]);
  assert.deepEqual(payload(r[3]).listing_ids, ["acme/widgets#12"]);
  assert.deepEqual(payload(r[4]).listing_ids, ["acme/widgets#12"]);
  const p5 = payload(r[5]);
  assert.equal(p5.total_matched, 2);
  assert.equal(p5.returned, 1);
  assert.equal(p5.listings[0].type, "challenge");
});

test("get_listing, whats_new and get_stats", async () => {
  const r = await rpc([
    call(1, "get_listing", { listing_id: "acme/widgets#12" }),
    call(2, "get_listing", { listing_id: "nope#1" }),
    call(3, "whats_new", { since: "2026-09-01T00:00:00Z" }),
    call(4, "whats_new", { since: "2026-12-01T00:00:00Z" }),
    call(5, "get_stats"),
  ]);
  const listing = payload(r[1]);
  assert.equal(listing.amount_usd, 500);
  assert.equal(listing.verification.repo_active, true);
  assert.equal(r[2].result.isError, true);
  assert.equal(payload(r[3]).count, 4);
  assert.equal(payload(r[4]).count, 0);
  const stats = payload(r[5]);
  assert.equal(stats.live_listings, 4);
  assert.equal(stats.total_known_usd, 15550);
  assert.deepEqual(stats.by_source, { algora: 1, "github-label": 1, "algora-jobs": 1, "algora-challenge": 1 });
});

test("unknown tool and unknown method return JSON-RPC errors", async () => {
  const r = await rpc([call(1, "drop_tables"), { id: 2, method: "resources/list" }]);
  assert.equal(r[1].error.code, -32601);
  assert.equal(r[2].error.code, -32601);
});

// Audited bug: the sweep runs every 6h, so the feed's generatedAt is always
// recent. Comparing that to `since` reported every listing as new, including
// one first seen on 2026-09-01 when asked for news since 2026-11-09.
test("whats_new compares each listing's first_seen, not the feed timestamp", async () => {
  const OLD = "acme/widgets#12";                              // first seen 2026-09-01
  const RECENT = "foo/bar#3";                                 // first seen 2026-11-09T12:00Z
  const UNDATED = "algora-jobs:acme:TypeScript Engineer";     // no first_seen
  const BAD_DATE = "algora-challenge:algora:Build a fast indexer"; // unparseable first_seen
  const r = await rpc([
    call(1, "whats_new", { since: "2026-11-09T00:00:00Z" }),
    call(2, "whats_new", { since: "2026-11-10T00:55:07.560Z" }),
    call(3, "whats_new", { since: "2026-08-01T00:00:00Z" }),
    call(4, "whats_new"),
    call(5, "whats_new", { since: "2026-11-09T12:00:00.000Z" }),
    call(6, "whats_new", { since: "yesterday-ish" }),
  ], FIRST_SEEN_FEED);

  const p1 = payload(r[1]);
  assert.equal(p1.listing_ids.includes(OLD), false, "a listing first seen on 2026-09-01 is not new since 2026-11-09");
  assert.deepEqual(p1.listing_ids, [RECENT, UNDATED, BAD_DATE]);
  assert.equal(p1.count, 3);
  assert.equal(p1.listings[0].first_seen, "2026-11-09T12:00:00.000Z");

  // polling with the previous feed_generated_at, as the tool's tip says: nothing is new
  assert.equal(payload(r[2]).count, 0);
  assert.equal(payload(r[3]).count, 4);
  assert.equal(payload(r[4]).count, 4);
  // strictly after: a listing first seen exactly at `since` was already reported
  assert.deepEqual(payload(r[5]).listing_ids, [UNDATED, BAD_DATE]);
  assert.equal(r[6].result.isError, true);
});

test("search_bounties clamps limit instead of slicing from the end", async () => {
  const r = await rpc([
    call(1, "search_bounties", { limit: -1 }),
    call(2, "search_bounties", { limit: 0 }),
    call(3, "search_bounties", { limit: 1000 }),
    call(4, "search_bounties", { limit: "abc" }),
    call(5, "search_bounties", { limit: 2.9 }),
    call(6, "search_bounties", { limit: -3, sort: "amount" }),
  ]);
  const returned = (id) => [payload(r[id]).returned, payload(r[id]).listings.length, payload(r[id]).total_matched];
  assert.deepEqual(returned(1), [1, 1, 4], "limit=-1 used to return 3 of 4");
  assert.deepEqual(returned(2), [1, 1, 4]);
  assert.deepEqual(returned(3), [4, 4, 4]);
  assert.deepEqual(returned(4), [4, 4, 4]);
  assert.deepEqual(returned(5), [2, 2, 4]);
  assert.deepEqual(payload(r[6]).listing_ids, ["algora-challenge:algora:Build a fast indexer"]);
});

test("tool descriptions state the real score range", async () => {
  const r = await rpc([{ id: 1, method: "tools/list" }]);
  const search = r[1].result.tools[0];
  assert.match(search.description, /0–12 opportunity score/);
  assert.match(search.inputSchema.properties.min_score.description, /0–12/);
  assert.doesNotMatch(JSON.stringify(r[1].result.tools), /0–15|\/15/);
  assert.deepEqual([search.inputSchema.properties.limit.minimum, search.inputSchema.properties.limit.maximum], [1, 100]);
});
