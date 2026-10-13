#!/usr/bin/env node
/**
 * Hourly launch-day digest — one compact Discord message per hour while the
 * Show HN thread is fresh:
 *   • HN points + comments (Algolia)
 *   • GitHub stars of the dashboard repo (gh CLI)
 *   • API requests today/total (Worker /v1/launch)
 * Deltas are relative to the previous digest run (state file).
 *
 * Self-gating: sends only while the thread is younger than DIGEST_MAX_AGE_HOURS
 * (default 36) — after that the hourly run is a silent no-op, so the cron can
 * stay enabled forever without spamming.
 *
 * Usage:
 *   node launch-digest.mjs                    # one digest (cron mode)
 *   node launch-digest.mjs --dry-run          # print, don't send
 *   node launch-digest.mjs --force            # ignore the thread-age gate
 *   node launch-digest.mjs --state path.json
 *
 * Env: HN_ITEM_ID, DISCORD_WEBHOOK_URL, GH_TOKEN (stars), DIGEST_MAX_AGE_HOURS
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(`--${f}`);
const flagVal = (f) => { const i = args.indexOf(`--${f}`); return i !== -1 ? args[i + 1] : undefined; };

const ITEM_ID = process.env.HN_ITEM_ID ?? flagVal("item");
const DASH_REPO = process.env.GH_DASHBOARD_REPO ?? "muhib-karim/bounty-radar";
const API_BASE = process.env.LAUNCH_API_URL ?? "https://bounty-radar-api.ai-dev-2024.workers.dev";
const MAX_AGE_H = Number(process.env.DIGEST_MAX_AGE_HOURS ?? 36);
const STATE_PATH = flagVal("state") ?? "state/launch-digest.json";
const DRY = hasFlag("dry-run");
const FORCE = hasFlag("force");

const fmt = (n) => (n ?? 0).toLocaleString("en-US");
const arrow = (d) => (!hasPrev ? "" : d > 0 ? ` ▲${fmt(d)}` : d < 0 ? ` ▼${fmt(-d)}` : "");

async function hnItem(id) {
  const res = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, { headers: { "User-Agent": "bounty-radar-launch-digest" } });
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  return res.json();
}

// recursive count — Algolia nests replies, children.length alone undercounts
function countComments(node) {
  let n = 0;
  for (const c of node.children ?? []) { if (!c.deleted) n += 1 + countComments(c); }
  return n;
}

async function stars() {
  const { stdout } = await execFileAsync("gh", ["api", `repos/${DASH_REPO}`, "--jq", ".stargazers_count | tostring"], { timeout: 30_000 });
  return Number(stdout.trim());
}

async function apiStats() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`${API_BASE}/v1/launch`, { headers: { "User-Agent": "bounty-radar-launch-digest" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`api ${res.status}`);
    const j = await res.json();
    const days = j?.data?.api?.requests_by_day ?? {};
    const today = new Date().toISOString().slice(0, 10);
    return { today: days[today] ?? 0, total: Object.values(days).reduce((s, n) => s + (Number(n) || 0), 0) };
  } finally { clearTimeout(timer); }
}

let seen = { last: null, sent: 0 };
if (existsSync(STATE_PATH)) {
  try { seen = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { /* fresh */ }
}
// state is per-thread: a new HN_ITEM_ID (next launch) starts a fresh baseline
if (seen.item !== (ITEM_ID ?? "")) {
  seen.item = ITEM_ID ?? "";
  seen.last = null;
}
const prev = seen.last ?? {};
const hasPrev = seen.last != null;

// Pre-launch: nothing to digest — stay silent (the hourly cron runs forever).
if (!ITEM_ID) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ item: "", last: null, sent: seen.sent }), "utf8");
  console.log("[digest] HN_ITEM_ID not set — launch digest inactive (silent skip).");
  process.exit(0);
}

// --- gather (each metric optional; partial failures degrade the line, not the digest)
const parts = [];
let threadAgeH = null;

{
  const item = await hnItem(ITEM_ID);
  const created = (item.created_at_i ?? 0) * 1000;
  threadAgeH = created ? (Date.now() - created) / 3_600_000 : null;
  const comments = countComments(item);
  const dPts = (item.points ?? 0) - (prev.pts ?? 0);
  const dCm = comments - (prev.comments ?? 0);
  parts.push(`**HN** ${fmt(item.points)} pts${arrow(dPts)} · ${fmt(comments)} comments${arrow(dCm)}`);
  seen.last = { ...seen.last, pts: item.points ?? 0, comments };
}

try {
  const s = await stars();
  parts.push(`★ ${fmt(s)}${arrow(s - (prev.stars ?? 0))}`);
  seen.last = { ...seen.last, stars: s };
} catch { parts.push("★ —"); }

try {
  const a = await apiStats();
  parts.push(`**API** ${fmt(a.today)} today${arrow(a.today - (prev.apiToday ?? 0))} · ${fmt(a.total)} total`);
  seen.last = { ...seen.last, apiToday: a.today, apiTotal: a.total };
} catch { parts.push("**API** —"); }
const fresh = FORCE || threadAgeH == null || threadAgeH < MAX_AGE_H;
const lines = [
  "📊 **Launch digest** (hourly)",
  parts.join("\n"),
  `· <https://news.ycombinator.com/item?id=${ITEM_ID ?? ""}> · <${API_BASE}/v1/launch>`,
];

if (!fresh) {
  console.log(`[digest] thread is ${Math.round(threadAgeH)}h old (>${MAX_AGE_H}h) — silent skip. Sent ${seen.sent} digests so far.`);
} else if (DRY) {
  console.log("[digest] dry-run would send:\n" + lines.join("\n"));
} else {
  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Launch Digest", content: lines.join("\n").slice(0, 1900) }),
  });
  if (!res.ok) throw new Error(`discord ${res.status}`);
  seen.sent++;
  console.log(`[digest] sent (#${seen.sent}): ${parts.join(" | ")}`);
}

mkdirSync(dirname(STATE_PATH), { recursive: true });
writeFileSync(STATE_PATH, JSON.stringify(seen), "utf8");
