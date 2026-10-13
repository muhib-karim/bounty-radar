#!/usr/bin/env node
/**
 * Site generator for Bounty Radar.
 * Reads a radar JSON feed (produced by `radar.mjs --json`) and emits:
 *   site/index.html  — browsable digest
 *   site/feed.xml    — RSS 2.0 feed (subscribe in any reader)
 *   site/bounties.json — machine-readable feed for agents
 *
 * Usage:
 *   node radar.mjs --json > feed.json            # produce the data
 *   node build-site.mjs feed.json site/          # generate the site
 *
 * If feed.json is missing/stale (>24h), it runs a fresh sweep itself.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

const feedPath = process.argv[2] ?? join(here, "feed.json");
const outDir = process.argv[3] ?? join(here, "site");

const SITE_URL = process.env.SITE_URL ?? "https://muhib-karim.github.io/bounty-radar/";
const SITE_TITLE = "Bounty Radar — live verified open-source bounties, jobs & challenges";
const SITE_DESC =
  "A daily-verified feed of real, payable open-source bounties (Algora, Opire, GitHub-native), jobs and challenges. Dead repos, expired programs and escrow-less spam filtered out.";

// ---------------------------------------------------------------------------
// Get data: reuse existing feed if fresh, otherwise sweep now.
// ---------------------------------------------------------------------------

function isFresh(path, maxAgeMs = 20 * 3600 * 1000) {
  try {
    return Date.now() - statSync(path).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

let data;
if (existsSync(feedPath) && isFresh(feedPath)) {
  console.error(`[build-site] using existing feed: ${feedPath}`);
  data = JSON.parse(readFileSync(feedPath, "utf8"));
} else {
  console.error("[build-site] feed missing or stale — running a fresh sweep…");
  const out = execFileSync("node", [join(here, "radar.mjs"), "--json"], {
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  data = JSON.parse(out);
  writeFileSync(feedPath, out, "utf8"); // cache for next time
}

const bounties = data.bounties ?? [];
const generatedAt = data.generatedAt ?? new Date().toISOString();

// HN launch momentum (optional): samples written by hn-monitor.mjs into its
// committed state file. Missing/empty → the chart is simply omitted.
let momentum = [];
try {
  momentum = JSON.parse(readFileSync(join(here, "state", "hn-monitor.json"), "utf8")).momentum ?? [];
} catch { /* no monitor state yet */ }

// ---------------------------------------------------------------------------
// Data prep
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ESCROW_BADGE = {
  "algora-escrow": ["escrow ✓", "good"],
  "opire-stripe": ["escrow ✓", "good"],
};

function badgeFor(b) {
  if (ESCROW_BADGE[b.escrow]) return ESCROW_BADGE[b.escrow];
  if (b.escrow?.startsWith("algora challenge")) return ["prize", "good"];
  if (b.escrow?.startsWith("direct employment")) return ["direct", "good"];
  if (b.escrow?.includes("502")) return ["⚠ platform down", "warn"];
  if (b.escrow?.startsWith("unknown")) return ["escrow ?", "warn"];
  return [esc(b.escrow ?? ""), "warn"];
}

const SOURCE_LABEL = {
  "algora-jobs": "Algora Jobs",
  "algora-challenge": "Algora Challenge",
  "algora-mention": "Algora Thread",
  algora: "Algora Bounty",
  opire: "Opire",
  "github-label": "GitHub Bounty",
};

function fmtMoney(b) {
  return b.amountUsd != null ? `$${b.amountUsd.toLocaleString("en-US")}` : "—";
}

function fmtAge(b) {
  if (b.ageDays == null) return "—";
  if (b.ageDays === 0) return "today";
  if (b.ageDays === 1) return "1d";
  if (b.ageDays < 30) return `${b.ageDays}d`;
  if (b.ageDays < 365) return `${Math.round(b.ageDays / 30)}mo`;
  return `${(b.ageDays / 365).toFixed(1)}y`;
}

// ---------------------------------------------------------------------------
// index.html
// ---------------------------------------------------------------------------

function cardHtml(b) {
  const [badge, kind] = badgeFor(b);
  const id = b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.org}`;
  const meta = [];
  if (b.issue != null) {
    meta.push(`age ${fmtAge(b)}`);
    if (b.claimCount != null) meta.push(`${b.claimCount} claims`);
    if (b.openCompetingPrs != null) meta.push(`${b.openCompetingPrs} open PRs`);
  }
  if (b.repoPushedDaysAgo != null) meta.push(`repo active ${b.repoPushedDaysAgo === 0 ? "today" : `${b.repoPushedDaysAgo}d ago`}`);
  return `      <article class="card ${kind}">
        <div class="row">
          <span class="amount">${esc(fmtMoney(b))}</span>
          <span class="badge ${kind}">${esc(badge)}</span>
          <span class="source">${esc(SOURCE_LABEL[b.source] ?? esc(b.source))}</span>
          <span class="score" title="opportunity score">★ ${b.score}/15</span>
        </div>
        <h2><a href="${esc(b.url)}" rel="noopener" target="_blank">${esc(b.title)}</a></h2>
        ${b.desc ? `<p class="desc">${esc(b.desc)}</p>` : ""}
        <div class="row meta">
          <span>${esc(id)}</span>
          ${meta.length ? `<span>${esc(meta.join(" · "))}</span>` : ""}
        </div>
      </article>`;
}

const VERIFIED_COUNT = bounties.filter((b) => b.issue != null).length;

// --- HN launch-momentum chart (inline SVG, zero JS) -------------------------

function momentumChart(samples, w = 940, h = 120, pad = 8) {
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const maxPts = Math.max(...samples.map((s) => s.pts), 1);
  const maxC = Math.max(...samples.map((s) => s.comments), 1);
  const hasStars = samples.some((s) => s.stars != null);
  const maxS = Math.max(...samples.map((s) => s.stars ?? 0), 1);
  const x = (t) => pad + ((t - t0) / Math.max(t1 - t0, 60_000)) * (w - 2 * pad);
  const y = (p) => h - pad - (p / maxPts) * (h - 2 * pad);
  const y2 = (v) => h - pad - (v / maxS) * (h - 2 * pad);
  // comment bars (behind), points line (green), stars line (amber), end dots
  const bars = samples.length <= 140
    ? samples.map((s) => {
        const bw = Math.max((w - 2 * pad) / samples.length - 1, 1);
        const bh = (s.comments / maxC) * (h * 0.28);
        return `<rect x="${(x(s.t) - bw / 2).toFixed(1)}" y="${(h - pad - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="#1f6feb" opacity="0.45"/>`;
      }).join("")
    : "";
  const line = `<polyline points="${samples.map((s) => `${x(s.t).toFixed(1)},${y(s.pts).toFixed(1)}`).join(" ")}" fill="none" stroke="#3fb950" stroke-width="2" stroke-linejoin="round"/>`;
  const starsLine = hasStars
    ? `<polyline points="${samples.filter((s) => s.stars != null).map((s) => `${x(s.t).toFixed(1)},${y2(s.stars).toFixed(1)}`).join(" ")}" fill="none" stroke="#d29922" stroke-width="2" stroke-linejoin="round"/>`
    : "";
  const last = samples[samples.length - 1];
  const lastStar = [...samples].reverse().find((s) => s.stars != null);
  const dots =
    `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.pts).toFixed(1)}" r="3" fill="#3fb950"/>` +
    (lastStar ? `<circle cx="${x(lastStar.t).toFixed(1)}" cy="${y2(lastStar.stars).toFixed(1)}" r="3" fill="#d29922"/>` : "");
  return bars + line + starsLine + dots;
}

const MOMENTUM_LAST = momentum[momentum.length - 1] ?? null;
const MOMENTUM_CHART = momentum.length >= 2 ? momentumChart(momentum) : "";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(SITE_TITLE)}</title>
<meta name="description" content="${esc(SITE_DESC)}">
<link rel="alternate" type="application/rss+xml" title="Bounty Radar" href="feed.xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 24px 16px 80px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  h1 { font-size: 1.5rem; margin: 0; }
  h1 .radar { color: #3fb950; }
  .tagline { color: #8b949e; margin: 4px 0 16px; }
  .updated { color: #8b949e; font-size: .85rem; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0 20px; color: #8b949e; font-size: .9rem; }
  .stats b { color: #e6edf3; }
  .momentum { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 10px 14px; margin: 0 0 20px; }
  .momentum-head { color: #8b949e; font-size: .85rem; margin-bottom: 6px; }
  .momentum-head b { color: #3fb950; }
  .momentum-head a { color: #58a6ff; }
  .momentum svg { display: block; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .filters button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 999px; padding: 4px 14px; cursor: pointer; font-size: .85rem; }
  .filters button.active { background: #1f6feb; border-color: #1f6feb; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; }
  .card.good { border-left: 3px solid #3fb950; }
  .card.warn { border-left: 3px solid #d29922; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .amount { font-weight: 700; font-size: 1.05rem; color: #7ee787; }
  .badge { font-size: .72rem; padding: 1px 8px; border-radius: 999px; border: 1px solid; }
  .badge.good { color: #3fb950; }
  .badge.warn { color: #d29922; }
  .source { color: #8b949e; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  .score { margin-left: auto; color: #d2a8ff; font-size: .8rem; }
  h2 { font-size: 1rem; margin: 8px 0 4px; }
  h2 a { color: #e6edf3; text-decoration: none; }
  h2 a:hover { color: #58a6ff; text-decoration: underline; }
  .desc { color: #8b949e; font-size: .85rem; margin: 4px 0; }
  .meta { color: #8b949e; font-size: .78rem; justify-content: space-between; }
  details.how { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 0; margin: 0 0 20px; }
  details.how summary { cursor: pointer; padding: 12px 16px; font-weight: 600; color: #58a6ff; list-style: none; }
  details.how summary::before { content: "▸ "; }
  details.how[open] summary::before { content: "▾ "; }
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; padding: 4px 16px 16px; }
  .step { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; font-size: .85rem; }
  .step h3 { margin: 8px 0 4px; font-size: .95rem; color: #e6edf3; }
  .step p { margin: 0; color: #8b949e; }
  .step code { background: #21262d; border-radius: 4px; padding: 1px 5px; font-size: .8rem; color: #79c0ff; }
  .step a { color: #58a6ff; }
  .step .n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: #1f6feb; color: #fff; font-weight: 700; font-size: .8rem; }
  .step.agent { border-color: #1f6feb; }
  .empty { color: #8b949e; padding: 40px 0; text-align: center; }
  footer { margin-top: 40px; color: #8b949e; font-size: .8rem; border-top: 1px solid #30363d; padding-top: 16px; }
  footer a { color: #58a6ff; }
  .noresults { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🎯 Bounty <span class="radar">Radar</span></h1>
    <span class="updated">swept ${esc(generatedAt.slice(0, 16).replace("T", " "))} UTC</span>
  </header>
  <p class="tagline">Live open-source bounties, jobs &amp; challenges — every listing verified: repo active, issue open, spam filtered.</p>
  <div class="stats">
    <span><b>${bounties.length}</b> live listings</span>
    <span><b>${VERIFIED_COUNT}</b> issue-verified</span>
    <span><b>${bounties.filter((b) => b.amountUsd != null).length}</b> with known payout</span>
    <span><a href="feed.xml">📡 RSS</a></span>
    <span><a href="bounties.json">{ } JSON for agents</a></span>
  </div>
${MOMENTUM_CHART ? `  <div class="momentum">
    <div class="momentum-head">🚀 Launch momentum — <b>${MOMENTUM_LAST.pts}</b> pts · <b>${MOMENTUM_LAST.comments}</b> comments${momentum.some((s) => s.stars != null) ? ` · <b style="color:#d29922">★ ${MOMENTUM_LAST.stars ?? "…"}</b> repo stars` : ""} · <span style="color:#3fb950">—</span> points <span style="color:#d29922">—</span> stars <span style="color:#58a6ff">▮</span> comments · <a href="https://news.ycombinator.com/item?id=${process.env.HN_ITEM_ID ?? ""}">HN thread</a> · <a href="momentum.svg">shareable chart</a> · <a href="dashboard.svg">full dashboard</a> · <a href="hn-momentum.json">raw data</a></div>
    <svg viewBox="0 0 940 120" width="100%" height="120" role="img" aria-label="Hacker News thread points over time" preserveAspectRatio="none">
      ${MOMENTUM_CHART}
    </svg>
  </div>` : ""}
  <details class="how" open>
    <summary>First time here? How to pick a bounty and start — 60-second walkthrough</summary>
    <div class="steps">
      <div class="step"><span class="n">1</span><h3>Read the card</h3><p><b style="color:#d2a8ff">★ score</b> ranks opportunity (amount + freshness + low competition). <b style="color:#3fb950">escrow ✓</b> means a platform (Algora/Opire) holds the money. <b style="color:#d29922">escrow ?</b> means verify in the issue before investing time. Fewer open PRs = less competition.</p></div>
      <div class="step"><span class="n">2</span><h3>Open the issue</h3><p>Click a listing title to open its GitHub issue. Skim the discussion: is someone already deep into a PR? Is the maintainer responsive? Read the repo's <code>CONTRIBUTING.md</code>.</p></div>
      <div class="step"><span class="n">3</span><h3>Claim it politely</h3><p>Comment <code>/claim</code> or <code>/attempt</code> (platform repos) or “I'd like to work on this” — then deliver fast. Many repos only review PRs from whoever claimed first.</p></div>
      <div class="step"><span class="n">4</span><h3>Get paid</h3><p>Open a clean PR referencing the issue. On merge, escrow-backed platforms pay you out automatically. For <b style="color:#d29922">escrow ?</b> listings, confirm payment terms with the maintainer <i>before</i> starting.</p></div>
      <div class="step agent"><span class="n">🤖</span><h3>Are you an agent?</h3><p>Skip the HTML: poll <a href="bounties.json">bounties.json</a> directly, or run the <a href="https://github.com/muhib-karim/bounty-radar#use-it-from-any-agent-mcp-server">MCP server</a> for native tools (<code>search_bounties</code>, <code>whats_new</code>, <code>get_stats</code>).</p></div>
    </div>
  </details>
  <div class="filters" id="filters"></div>
  <div class="grid" id="grid">
${bounties.map(cardHtml).join("\n")}
  </div>
  <div class="empty noresults" id="noresults">No listings match this filter.</div>
  <footer>
    Verification: repo pushed ≤60d · not archived · not a fork · issue still open · known spam farms filtered.
    Amounts and claim counts change — always confirm on the linked issue before starting work.
    Powered by <a href="https://github.com/muhib-karim/bounty-radar">bounty-radar</a> — zero-dependency Node, runs anywhere.${process.env.HN_ITEM_ID ? "\n    💬 <a href=\"https://news.ycombinator.com/item?id=" + process.env.HN_ITEM_ID + "\" rel=\"noopener\">Discuss this site on Hacker News (Show HN)</a>" : ""}
  </footer>
</div>
<script>
  const cards = [...document.querySelectorAll('.card')];
  const sources = [...new Set(cards.map(c => c.querySelector('.source').textContent))];
  const filters = document.getElementById('filters');
  const mk = (label) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      const active = b.classList.contains('active');
      filters.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      if (!active) { b.classList.add('active'); apply(label); } else apply('All');
    };
    return b;
  };
  const apply = (label) => {
    let shown = 0;
    cards.forEach(c => {
      const show = label === 'All' || c.querySelector('.source').textContent === label;
      c.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    document.getElementById('noresults').style.display = shown ? 'none' : 'block';
  };
  filters.append(mk('All'));
  sources.forEach(s => filters.append(mk(s)));
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

function rssItem(b, i) {
  const [badge] = badgeFor(b);
  const id = b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.org} — ${b.title}`;
  return `    <item>
      <title>${esc(`[${fmtMoney(b)}] [${badge}] ${id} — ${b.title}`)}</title>
      <link>${esc(b.url)}</link>
      <guid isPermaLink="false">bounty-radar-${b.source}-${b.issue ?? b.title}-${i}</guid>
      <pubDate>${new Date(Date.now() - (b.ageDays ?? 0) * 86400000).toUTCString()}</pubDate>
      <description>${esc(
        `Source: ${SOURCE_LABEL[b.source] ?? b.source}. Score: ${b.score}/15. Escrow: ${b.escrow}.` +
        (b.desc ? ` ${b.desc}` : ""),
      )}</description>
    </item>`;
}

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${esc(SITE_TITLE)}</title>
  <link>${esc(SITE_URL)}</link>
  <description>${esc(SITE_DESC)}</description>
  <language>en</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${esc(SITE_URL)}feed.xml" rel="self" type="application/rss+xml"/>
${bounties.map(rssItem).join("\n")}
</channel>
</rss>
`;

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), html, "utf8");
writeFileSync(join(outDir, "feed.xml"), rss, "utf8");
writeFileSync(join(outDir, "bounties.json"), JSON.stringify({ ...data, site: SITE_URL }, null, 2), "utf8");
writeFileSync(join(outDir, "hn-momentum.json"), JSON.stringify({ updatedAt: new Date().toISOString(), samples: momentum }, null, 2), "utf8");
if (momentum.length >= 2) {
  const inner = momentumChart(momentum);
  const hnId = process.env.HN_ITEM_ID ?? "";
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 150" width="940" height="150" role="img" aria-label="Bounty Radar HN launch momentum">
  <rect width="940" height="150" fill="#0d1117"/>
  <text x="12" y="22" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="14" fill="#8b949e">Bounty Radar — launch momentum${hnId ? ` · news.ycombinator.com/item?id=${hnId}` : ""}</text>
  <text x="928" y="22" text-anchor="end" font-family="system-ui,sans-serif" font-size="13" fill="#3fb950">${MOMENTUM_LAST.pts} pts</text>
  <g transform="translate(0,30)">
    ${inner}
  </g>
</svg>
`;
  writeFileSync(join(outDir, "momentum.svg"), svg, "utf8");
}
console.error(`[build-site] wrote ${outDir}/index.html, feed.xml, bounties.json (${bounties.length} listings)`);
