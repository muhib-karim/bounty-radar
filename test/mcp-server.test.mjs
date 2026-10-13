// Drives mcp-server.mjs over stdio exactly as an MCP client would, using a
// local fixture feed so no network access is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));
const FEED = fileURLToPath(new URL("./fixtures/feed.json", import.meta.url));

function rpc(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, FEED], { stdio: ["pipe", "pipe", "inherit"] });
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
