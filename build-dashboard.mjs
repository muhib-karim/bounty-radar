#!/usr/bin/env node
/**
 * Three-panel launch dashboard — one shareable SVG (CI renders it to dashboard.png):
 *   1. HN thread points over time (green) with comment bars behind
 *   2. GitHub repo stars over time (amber)
 *   3. API requests per day (blue bars, live from the Worker's /v1/launch)
 *
 * Data: state/hn-monitor.json (monitor momentum samples) + GET /v1/launch.
 * Zero deps. Exits 0 with no output when there is nothing to chart yet
 * (pre-launch), so the CI publish never blocks on it.
 *
 * Usage: node build-dashboard.mjs [out.svg] [--state state/hn-monitor.json]
 * Env:   HN_ITEM_ID (footer thread ref), LAUNCH_API_URL, DASHBOARD_API_FILE (test override)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const flagVal = (f) => { const i = args.indexOf(`--${f}`); return i !== -1 ? args[i + 1] : undefined; };
const outPath = args.find((a) => !a.startsWith("--")) ?? "site/dashboard.svg";
const statePath = flagVal("state") ?? "state/hn-monitor.json";
const API_BASE = process.env.LAUNCH_API_URL ?? "https://bounty-radar-api.ai-dev-2024.workers.dev";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- data --------------------------------------------------------------------

let samples = [];
try {
  samples = JSON.parse(readFileSync(statePath, "utf8")).momentum ?? [];
} catch { /* no monitor state yet */ }

let apiDays = {};
let apiNote = null;
try {
  const raw = process.env.DASHBOARD_API_FILE
    ? readFileSync(process.env.DASHBOARD_API_FILE, "utf8")
    : await (async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15_000);
        try {
          const res = await fetch(`${API_BASE}/v1/launch`, {
            headers: { "User-Agent": "bounty-radar-dashboard" },
            signal: ctl.signal,
          });
          if (!res.ok) throw new Error(`api ${res.status}`);
          return await res.text();
        } finally { clearTimeout(timer); }
      })();
  apiDays = JSON.parse(raw)?.data?.api?.requests_by_day ?? {};
} catch (e) {
  apiNote = `API traffic unavailable (${esc(e.message)})`;
}

const starSamples = samples.filter((s) => s.stars != null);
if (samples.length === 0 && starSamples.length === 0 && Object.keys(apiDays).length === 0) {
  console.error("[dashboard] no data yet — skipping (dashboard appears once the thread is live)");
  process.exit(0);
}

// --- svg geometry --------------------------------------------------------------

const W = 940, PAD = 14, PW = W - PAD * 2;
const PH = 84, LABEL_H = 20, GAP = 20, TOP = 56;
const panelTop = (i) => TOP + i * (LABEL_H + PH + GAP);
const H = panelTop(2) + LABEL_H + PH + 44;

// line + end dot over a time axis, clipped to one panel's plot area
function linePlot(series, { color, w = PW, h = PH, x0 = PAD }) {
  if (series.length === 0) return "";
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const max = Math.max(...series.map((s) => s.v), 1);
  const x = (t) => x0 + 4 + ((t - t0) / Math.max(t1 - t0, 60_000)) * (w - 8);
  const y = (v) => h - 4 - (v / max) * (h - 8);
  const pts = series.map((s) => `${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`);
  const line = series.length >= 2
    ? `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`
    : "";
  const [lx, ly] = pts[pts.length - 1].split(",");
  return `${line}<circle cx="${lx}" cy="${ly}" r="3" fill="${color}"/>`;
}

// low bars behind a line (comments), same time axis
function barsOverTime(series, { color, w = PW, h = PH, x0 = PAD, frac = 0.3 }) {
  if (series.length === 0 || series.length > 140) return "";
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const max = Math.max(...series.map((s) => s.v), 1);
  const x = (t) => x0 + 4 + ((t - t0) / Math.max(t1 - t0, 60_000)) * (w - 8);
  const bw = Math.max((w - 8) / series.length - 1, 1);
  return series.map((s) => {
    const bh = (s.v / max) * h * frac;
    return `<rect x="${(x(s.t) - bw / 2).toFixed(1)}" y="${(h - 4 - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.45"/>`;
  }).join("");
}

// categorical per-day bars
function dayBars(days, { color, w = PW, h = PH, x0 = PAD }) {
  if (!days.length) return "";
  const max = Math.max(...days.map((d) => d.n), 1);
  const step = (w - 8) / days.length;
  const bw = Math.min(Math.max(step - 2, 3), 48); // cap width so few-day charts don't render walls
  return days.map((d, i) => {
    const bh = Math.max((d.n / max) * (h - 8), 2);
    return `<rect x="${(x0 + 4 + i * step).toFixed(1)}" y="${(h - 4 - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"/>`;
  }).join("");
}

const emptyNote = (text) =>
  `<text x="${W / 2}" y="${PH / 2 + 4}" text-anchor="middle" font-size="12" fill="#8b949e">${esc(text)}</text>`;

function panel(i, label, value, color, body) {
  const y0 = panelTop(i) + LABEL_H;
  return `  <text x="${PAD}" y="${panelTop(i) + 4}" font-size="12" fill="#8b949e">${esc(label)}</text>
  <text x="${W - PAD}" y="${panelTop(i) + 4}" text-anchor="end" font-size="12" fill="${color}">${esc(value)}</text>
  <g transform="translate(0,${y0})">
    <line x1="${PAD}" y1="${PH}" x2="${W - PAD}" y2="${PH}" stroke="#30363d"/>
    ${body}
  </g>`;
}

// --- assemble -------------------------------------------------------------------

const last = samples[samples.length - 1] ?? null;
const lastStars = starSamples[starSamples.length - 1] ?? null;
const days = Object.entries(apiDays).sort(([a], [b]) => a.localeCompare(b))
  .map(([day, n]) => ({ day, n: Number(n) || 0 }));
const totalReq = days.reduce((s, d) => s + d.n, 0);
const todayStr = new Date().toISOString().slice(0, 10);
const todayReq = days.find((d) => d.day === todayStr)?.n ?? 0;
const hnId = process.env.HN_ITEM_ID ?? "";

const p1 = panel(0, "HN thread points", last ? `${last.pts} pts · ${last.comments} comments` : "awaiting launch", "#3fb950",
  (last ? barsOverTime(samples.map((s) => ({ t: s.t, v: s.comments })), { color: "#58a6ff" })
      + linePlot(samples.map((s) => ({ t: s.t, v: s.pts })), { color: "#3fb950" })
    : emptyNote("chart starts with the first monitor poll after HN_ITEM_ID is set")));

const p2 = panel(1, "GitHub stars (muhib-karim/bounty-radar)", lastStars ? `${lastStars.stars} stars` : "—", "#d29922",
  starSamples.length
    ? linePlot(starSamples.map((s) => ({ t: s.t, v: s.stars })), { color: "#d29922" })
    : emptyNote("logs with the first monitor poll (hn-monitor.json samples)"));

const p3 = panel(2, "API requests/day (bounty-radar-api)", days.length ? `${todayReq} today · ${totalReq} total` : (apiNote ?? "no traffic yet"), "#58a6ff",
  days.length
    ? dayBars(days, { color: "#58a6ff" })
      + `<text x="${PAD + 4}" y="${PH + 14}" font-size="10" fill="#8b949e">${esc(days[0].day)}</text>`
      + `<text x="${W - PAD - 4}" y="${PH + 14}" text-anchor="end" font-size="10" fill="#8b949e">${esc(days[days.length - 1].day)}</text>`
    : emptyNote(apiNote ?? "no API traffic logged yet"));

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Bounty Radar launch dashboard">
  <rect width="${W}" height="${H}" fill="#0d1117"/>
  <text x="${PAD}" y="26" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="15" font-weight="600" fill="#e6edf3">Bounty Radar — launch dashboard</text>
  <text x="${W - PAD}" y="26" text-anchor="end" font-family="system-ui,sans-serif" font-size="12" fill="#8b949e">${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC</text>
  <g font-family="system-ui,-apple-system,'Segoe UI',sans-serif">
${p1}
${p2}
${p3}
  </g>
  <text x="${PAD}" y="${H - 10}" font-family="system-ui,sans-serif" font-size="11" fill="#8b949e">sources: hn-monitor momentum samples · /v1/launch${hnId ? ` · news.ycombinator.com/item?id=${esc(hnId)}` : ""}</text>
</svg>
`;

if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, svg, "utf8");
console.error(`[dashboard] wrote ${outPath} (${samples.length} HN samples, ${starSamples.length} star samples, ${days.length} API days)`);
