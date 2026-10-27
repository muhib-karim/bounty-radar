#!/usr/bin/env node
/**
 * Launch pre-flight — one command, GO/NO-GO verdict.
 * Verifies every link, example, claim and number the Show HN post references,
 * directly against production. Run before submitting (and re-run on launch
 * morning — counts drift).
 *
 * Usage:
 *   node preflight.mjs            # human-readable table + exit code (0=GO, 1=NO-GO)
 *   node preflight.mjs --quiet    # verdict line only (CI)
 * Also: npm run preflight
 *
 * Checks marked [hard] block GO. [soft] items only inform.
 * Zero deps; gh CLI used when available (PR state, stars, secrets, variables).
 */
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const QUIET = process.argv.includes("--quiet");

const SITE = process.env.SITE_URL ?? "https://muhib-karim.github.io/bounty-radar/";
const API = process.env.LAUNCH_API_URL ?? "https://bounty-radar-api.ai-dev-2024.workers.dev";
const REPO = process.env.GH_DASHBOARD_REPO ?? "muhib-karim/bounty-radar";
const PROOF = { repo: "PHPOffice/PHPWord", pr: 2937 };
const KIT_PATH = join(here, "docs", "SHOW_HN.md");
const README_PATH = join(here, "README.md");
const FEED_MAX_AGE_H = 7; // cron is 6h — anything older means the pipeline stalled

const results = [];
const check = (name, kind) => ({ name, kind });
async function run(def, fn) {
  try {
    const detail = await fn();
    results.push({ ...def, ok: true, detail });
  } catch (e) {
    results.push({ ...def, ok: false, detail: e.message });
  }
}
const fetchy = async (url, opts) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    return await fetch(url, { headers: { "User-Agent": "bounty-radar-preflight" }, signal: ctl.signal, ...opts });
  } finally { clearTimeout(t); };
};
const gh = async (args) => (await execFileAsync("gh", args, { timeout: 30_000 })).stdout.trim();
const hasGh = await gh(["auth", "status"]).then(() => true).catch(() => false);

// --- kit numbers (parsed from the actual post draft) ---------------------------
let kit = { count: null, stars: null, raw: null };
try {
  const md = readFileSync(KIT_PATH, "utf8");
  kit.count = Number(md.match(/board (?:has|shows) (\d+) listings/)?.[1]) || null;
  kit.stars = Number(md.match(/\((\d+(?:\.\d+)?)k stars\)/)?.[1]) || null;
  kit.raw = md.match(/(\d+) verified out of (\d+) raw/)?.[2] ?? null;
} catch { /* kit missing → count parity check reports it */ }

// --- checks ---------------------------------------------------------------------

await run(check("site", "hard"), async () => {
  const r = await fetchy(SITE);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return "200";
});

let stats;
await run(check("feed", "hard"), async () => {
  const r = await fetchy(`${SITE}bounties.json`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const ageH = (Date.now() - new Date(j.generatedAt).getTime()) / 3.6e6;
  if (!(ageH >= 0) || ageH > FEED_MAX_AGE_H) throw new Error(`stale (${ageH.toFixed(1)}h old — run sweep-and-publish)`);
  stats = j;
  return `${j.bounties.length} listings, ${ageH.toFixed(1)}h old`;
});

await run(check("api", "hard"), async () => {
  const r = await fetchy(API);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return "root 200";
});

await run(check("stats", "hard"), async () => {
  const r = await fetchy(`${API}/v1/stats`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.data?.live_listings) throw new Error("0 live listings");
  return `${j.data.live_listings} listings · $${j.data.total_known_usd.toLocaleString("en-US")}`;
});

await run(check("example escrow", "hard"), async () => {
  const r = await fetchy(`${API}/v1/listings?escrow_only=1&sort=amount`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const n = (await r.json()).data.length;
  if (!n) throw new Error("0 results — the kit's showcase call returns an empty list");
  return `${n} results`;
});

await run(check("example jobs", "hard"), async () => {
  const r = await fetchy(`${API}/v1/listings?type=job`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const n = (await r.json()).data.length;
  if (!n) throw new Error("0 results — update the kit example or the job source");
  return `${n} results`;
});

await run(check("diff poll", "hard"), async () => {
  const r = await fetchy(`${API}/v1/diff?since=${encodeURIComponent(stats?.generatedAt ?? new Date().toISOString())}`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const c = j.meta?.counts ?? {};
  return `200 (${c.added ?? "?"}/${c.changed ?? "?"}/${c.removed ?? "?"} add/chg/rem)`;
});

await run(check("launch api", "hard"), async () => {
  const r = await fetchy(`${API}/v1/launch`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return "200";
});

await run(check("proof PR", "hard"), async () => {
  if (!hasGh) throw new Error("skipped: gh CLI unavailable");
  const j = JSON.parse(await gh(["pr", "view", String(PROOF.pr), "--repo", PROOF.repo, "--json", "state,mergeable"]));
  if (j.state !== "OPEN" || j.mergeable !== "MERGEABLE") throw new Error(`#2937 ${j.state}/${j.mergeable} — pick a different proof link or drop the claim`);
  return `#${PROOF.pr} OPEN · MERGEABLE`;
});

let actualStars;
await run(check("stars claim", "hard"), async () => {
  if (!hasGh) throw new Error("skipped: gh CLI unavailable");
  actualStars = Number(await gh(["api", `repos/${PROOF.repo}`, "--jq", ".stargazers_count"]));
  if (!kit.stars) return `kit has no star claim — actual ${(actualStars / 1000).toFixed(1)}k`;
  const drift = Math.abs(kit.stars - actualStars / 1000);
  if (drift > 0.15) throw new Error(`kit says ${kit.stars}k, actual ${(actualStars / 1000).toFixed(1)}k — update docs/SHOW_HN.md`);
  return `kit ${kit.stars}k ≈ actual ${(actualStars / 1000).toFixed(1)}k`;
});

await run(check("kit counts", "hard"), async () => {
  if (!stats) throw new Error("feed check failed — no baseline");
  if (!kit.count) throw new Error("could not parse 'shows N listings' from docs/SHOW_HN.md");
  if (kit.count !== stats.bounties.length) throw new Error(`kit says ${kit.count}, live is ${stats.bounties.length} — update docs/SHOW_HN.md`);
  return `kit ${kit.count} = live ${stats.bounties.length}${kit.raw ? ` · raw ${kit.raw} (historical)` : ""}`;
});

await run(check("MCP anchor", "hard"), async () => {
  const md = readFileSync(README_PATH, "utf8");
  if (!/^## Use it from any agent \(MCP server\)$/m.test(md)) throw new Error("README heading missing — anchor #use-it-from-any-agent-mcp-server would 404");
  return "heading present → anchor resolves";
});

await run(check("HN_ITEM_ID", "soft"), async () => {
  if (!hasGh) throw new Error("gh unavailable — check the variable manually");
  const vars = await gh(["api", `repos/${REPO}/actions/variables`, "--jq", ".variables[].name"]);
  if (!vars.split("\n").includes("HN_ITEM_ID")) throw new Error("not set (normal pre-launch — set it right after submitting)");
  return "set — monitor/digest/chart all armed";
});

await run(check("chart", "soft"), async () => {
  if (!stats) throw new Error("feed check failed");
  const mom = await fetchy(`${SITE}hn-momentum.json`).then((r) => r.json());
  const n = mom.samples?.length ?? 0;
  if (n === 0) return "no samples yet — materializes 1–2 sweeps after HN_ITEM_ID is set";
  const dash = await fetchy(`${SITE}dashboard.svg`);
  return dash.status === 200 ? `${n} samples · dashboard.svg live` : `${n} samples · dashboard.svg ${dash.status} (needs one more sweep)`;
});

await run(check("discord secret", "soft"), async () => {
  if (!hasGh) throw new Error("gh unavailable — check Settings → Secrets manually");
  const names = await gh(["api", `repos/${REPO}/actions/secrets`, "--jq", ".secrets[].name"]);
  if (!names.split("\n").includes("DISCORD_WEBHOOK_URL")) throw new Error("DISCORD_WEBHOOK_URL secret missing — alerts/digests will be silent");
  return "configured";
});

// --- verdict ---------------------------------------------------------------------

const hard = results.filter((r) => r.kind === "hard");
const failed = hard.filter((r) => !r.ok);
const GO = failed.length === 0;

if (!QUIET) {
  console.log("══ Bounty Radar — launch pre-flight ══");
  for (const r of results) {
    const mark = r.ok ? "✓" : r.kind === "hard" ? "✗" : "·";
    console.log(` ${mark} ${r.name.padEnd(15)} ${r.detail}`);
  }
}
if (GO) {
  console.log(`\nVERDICT: GO — all ${hard.length} hard checks pass. Numbers match production.`);
  console.log("Launch: 1) submit per docs/SHOW_HN.md  2) set HN_ITEM_ID  3) re-run this — chart/HN checks should flip to armed.");
} else {
  console.log(`\nVERDICT: NO-GO — ${failed.length} hard check(s) failing:`);
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  console.log("Fix the above (most are one-line doc updates or a manual workflow run), then re-run.");
}
process.exit(GO ? 0 : 1);
