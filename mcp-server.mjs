#!/usr/bin/env node
/**
 * Bounty Radar MCP Server
 * -----------------------
 * Lets any MCP-capable agent (Claude Code, Freebuff, Cursor, …) natively ask:
 *   - what bounties are new and winnable?
 *   - details on a specific listing?
 *   - what changed since my last poll?
 *   - what's the market pulse?
 *
 * Data source: the live Bounty Radar feed (published every 6h by the
 * sweep-and-publish GitHub Action), with an optional local feed.json override.
 *
 * Stdin/stdout speak MCP JSON-RPC 2.0 (the standard MCP stdio transport).
 * Zero external dependencies.
 *
 * Env / args:
 *   BOUNTY_RADAR_FEED   URL of the JSON feed (default: the published site feed)
 *   FEED_CACHE_TTL_MS   cache lifetime in ms (default: 10 min)
 *   argv[2]             optional path to a local feed.json (overrides URL)
 *
 * Agent config snippet:
 *   { "mcpServers": { "bounty-radar": { "command": "node", "args": ["/path/to/mcp-server.mjs"] } } }
 */

import { readFileSync } from "node:fs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node mcp-server.mjs [feed.json]

MCP server (JSON-RPC 2.0 over stdio) exposing tools: search_bounties,
get_listing, whats_new, get_stats.

  feed.json            optional local feed file (overrides BOUNTY_RADAR_FEED)
  BOUNTY_RADAR_FEED    feed URL (default: the published Pages feed)
  FEED_CACHE_TTL_MS    cache lifetime in ms (default: 600000)`);
  process.exit(0);
}

const DEFAULT_FEED_URL = process.env.BOUNTY_RADAR_FEED
  ?? "https://muhib-karim.github.io/bounty-radar/bounties.json";

const FEED_PATH = process.argv[2] ?? null; // local file override
const CACHE_TTL = Number(process.env.FEED_CACHE_TTL_MS ?? 10 * 60_000);

// ---------------------------------------------------------------------------
// Feed loading (cached)
// ---------------------------------------------------------------------------

let cache = { data: null, at: 0, promise: null };

async function loadFeed() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;

  if (!cache.promise) {
    cache.promise = (async () => {
      if (FEED_PATH) {
        return JSON.parse(readFileSync(FEED_PATH, "utf8"));
      }
      const res = await fetch(DEFAULT_FEED_URL, {
        headers: { "User-Agent": "bounty-radar-mcp/1.0" },
      });
      if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
      return await res.json();
    })();
  }

  try {
    const data = await cache.promise;
    cache = { data, at: Date.now(), promise: null };
    return data;
  } catch (err) {
    cache.promise = null; // allow retry on next call
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const listingKey = (b) => b.id ?? (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`);

async function searchBounties(args) {
  const {
    min_score, min_amount, max_age_days, source, type,
    escrow_only, q, sort = "score", limit = 20,
  } = args ?? {};

  const feed = await loadFeed();
  let items = [...(feed.bounties ?? [])];

  if (Number.isFinite(min_score)) items = items.filter((b) => (b.score ?? 0) >= min_score);
  if (Number.isFinite(min_amount)) items = items.filter((b) => (b.amountUsd ?? 0) >= min_amount);
  if (Number.isFinite(max_age_days)) items = items.filter((b) => b.ageDays == null || b.ageDays <= max_age_days);
  if (source) {
    const wanted = String(source).split(",").map((s) => s.trim()).filter(Boolean);
    items = items.filter((b) => wanted.includes(b.source));
  }
  if (type) {
    const wanted = String(type).split(",").map((s) => s.trim()).filter(Boolean);
    items = items.filter((b) => wanted.includes(b.type ?? inferType(b)));
  }
  if (escrow_only) {
    items = items.filter((b) =>
      b.escrow === "algora-escrow" || b.escrow === "opire-stripe" ||
      (b.escrow ?? "").startsWith("algora challenge") ||
      (b.escrow ?? "").startsWith("direct employment"));
  }
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter((b) =>
      b.title?.toLowerCase().includes(needle) ||
      b.org?.toLowerCase().includes(needle) ||
      b.repo?.toLowerCase().includes(needle) ||
      b.desc?.toLowerCase().includes(needle));
  }

  const cmp = {
    score: (a, b) => (b.score ?? 0) - (a.score ?? 0),
    amount: (a, b) => (b.amountUsd ?? -1) - (a.amountUsd ?? -1),
    freshness: (a, b) => (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9),
  }[sort] ?? (() => 0);
  items.sort(cmp);

  const capped = items.slice(0, Math.min(Number(limit) || 20, 100));
  return {
    total_matched: items.length,
    returned: capped.length,
    feed_generated_at: feed.generatedAt,
    listing_ids: capped.map(listingKey),
    listings: capped.map(summarize),
    hint: "use get_listing with a listing_id for full verification details; use whats_new to poll cheaply",
  };
}

function inferType(b) {
  if (b.source === "algora-jobs") return "job";
  if (b.source === "algora-challenge") return "challenge";
  if (b.source === "algora-mention") return "discussion";
  return "bounty";
}

function summarize(b) {
  return {
    id: listingKey(b),
    title: b.title,
    url: b.url,
    amount_usd: b.amountUsd ?? null,
    score: b.score ?? null,
    source: b.source,
    type: b.type ?? inferType(b),
    escrow: b.escrow ?? null,
    age_days: b.ageDays ?? null,
    open_competing_prs: b.openCompetingPrs ?? null,
    claim_count: b.claimCount ?? null,
    desc: b.desc ?? undefined,
  };
}

async function getListing(args) {
  if (!args?.listing_id) throw new Error("listing_id is required");
  const feed = await loadFeed();
  const b = (feed.bounties ?? []).find((x) => listingKey(x) === args.listing_id);
  if (!b) throw new Error(`listing not found: ${args.listing_id}`);
  return {
    ...summarize(b),
    org: b.org, repo: b.repo, issue: b.issue,
    repo_pushed_days_ago: b.repoPushedDaysAgo ?? null,
    verification: {
      verified_at: feed.generatedAt,
      repo_active: (b.repoPushedDaysAgo ?? 999) <= 60,
      issue_verified_open: b.issue != null,
      note: "claims/PR counts change fast — re-check the issue before investing hours",
    },
  };
}

async function whatsNew(args) {
  const since = args?.since ? new Date(args.since) : null;
  if (since && Number.isNaN(since.getTime())) throw new Error("invalid ISO date for 'since'");
  const feed = await loadFeed();
  const generatedAt = new Date(feed.generatedAt);
  // A listing is "new to you" if our feed first saw it after your last poll.
  // We approximate first_seen with the sweep that published it: anything in the
  // current feed with generatedAt > since is potentially new. Diffing client-
  // side with returned ids gives exact new-ness across polls.
  const items = (feed.bounties ?? []).filter((b) => !since || generatedAt > since);
  return {
    feed_generated_at: feed.generatedAt,
    new_since: since ? since.toISOString() : "epoch (everything)",
    count: items.length,
    listing_ids: items.map(listingKey),
    listings: items.map(summarize),
    tip: "pass the feed_generated_at of this response as 'since' next time to get only newer listings",
  };
}

async function getStats() {
  const feed = await loadFeed();
  const items = feed.bounties ?? [];
  const bySource = {};
  let totalMoney = 0;
  for (const b of items) {
    bySource[b.source] = (bySource[b.source] ?? 0) + 1;
    if (b.amountUsd) totalMoney += b.amountUsd;
  }
  const scored = items.filter((b) => b.score != null);
  return {
    feed_generated_at: feed.generatedAt,
    live_listings: items.length,
    total_known_usd: totalMoney,
    median_score: scored.length
      ? scored.map((b) => b.score).sort((a, b) => a - b)[Math.floor(scored.length / 2)]
      : null,
    by_source: bySource,
    interpretation:
      items.length < 15
        ? "market is thin right now — consider whats_new polling so you catch fresh listings early"
        : "decent inventory — filter with min_score >= 7 and escrow_only=true for the best bets",
  };
}

// ---------------------------------------------------------------------------
// MCP plumbing (JSON-RPC 2.0 over stdio)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "search_bounties",
    description:
      "Search the live Bounty Radar feed of verified open-source bounties, jobs and challenges. " +
      "Every listing is verified: repo active (pushed ≤60d), not archived, not a fork, issue open, spam farms filtered. " +
      "Filters: min_score (0–15 opportunity score), min_amount (USD), max_age_days, source (algora|opire|github-label|algora-jobs|algora-challenge|algora-mention), " +
      "type (bounty|job|challenge|discussion), escrow_only (true = only escrow-backed), q (text), sort (score|amount|freshness), limit.",
    inputSchema: {
      type: "object",
      properties: {
        min_score: { type: "number", description: "minimum opportunity score, 0–15" },
        min_amount: { type: "number", description: "minimum USD amount" },
        max_age_days: { type: "number", description: "only listings at most this many days old" },
        source: { type: "string", description: "comma-separated source filter" },
        type: { type: "string", description: "comma-separated type filter" },
        escrow_only: { type: "boolean", description: "only escrow-backed listings" },
        q: { type: "string", description: "text search in title/org/repo/description" },
        sort: { type: "string", enum: ["score", "amount", "freshness"], default: "score" },
        limit: { type: "number", default: 20, maximum: 100 },
      },
    },
  },
  {
    name: "get_listing",
    description: "Full details for one listing by id (including verification status). Get ids from search_bounties or whats_new.",
    inputSchema: {
      type: "object",
      required: ["listing_id"],
      properties: { listing_id: { type: "string" } },
    },
  },
  {
    name: "whats_new",
    description:
      "Cheap poll: listings published since your last check. Pass the feed_generated_at you received last time as 'since'. " +
      "Returns the same shape as search_bounties — store listing_ids to dedupe.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string", description: "ISO timestamp from a previous feed_generated_at" } },
    },
  },
  {
    name: "get_stats",
    description: "Market pulse: live listing count, total known USD, score distribution, per-source breakdown, and an interpretation hint.",
    inputSchema: { type: "object", properties: {} },
  },
];

function makeRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return makeRpcResult(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "bounty-radar", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized") return null; // notification — no reply
  if (method === "ping") return makeRpcResult(id, {});

  if (method === "tools/list") {
    return makeRpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      let result;
      if (name === "search_bounties") result = await searchBounties(args);
      else if (name === "get_listing") result = await getListing(args);
      else if (name === "whats_new") result = await whatsNew(args);
      else if (name === "get_stats") result = await getStats();
      else return makeRpcError(id, -32601, `Unknown tool: ${name}`);

      return makeRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      return makeRpcResult(id, {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return makeRpcError(id ?? null, -32601, `Method not found: ${method}`);
}

let buffer = "";
let pending = 0;
let stdinEnded = false;
function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  // MCP stdio uses newline-delimited JSON messages.
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    pending++;
    (async () => {
      try {
        const msg = JSON.parse(line);
        const reply = await handleMessage(msg);
        if (reply) process.stdout.write(reply + "\n");
      } catch (err) {
        process.stdout.write(makeRpcError(null, -32700, `Parse error: ${err.message}`) + "\n");
      } finally {
        pending--;
        maybeExit();
      }
    })();
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});

// warm the cache in the background
loadFeed().catch(() => {});
