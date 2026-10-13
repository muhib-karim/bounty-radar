#!/usr/bin/env node
/**
 * Social banner generator — 1280x640 GitHub social-preview card.
 * Vector-drawn (radar sweep motif, branded typography in the board's
 * GitHub-dark palette) with LIVE stats baked in: fetched from the
 * published feed at build time, so the card can never show stale numbers.
 *
 * Output:
 *   docs/social-banner.svg  (vector source, committed)
 *   docs/social-banner.png  (2x render for the GitHub upload slot)
 *
 * Zero deps besides `sharp` (devDependency of the repo's tooling).
 * Fails loudly (exit 1) if the feed can't be fetched — never render stale.
 */

import { writeFileSync } from "node:fs";
import sharp from "sharp";

const FEED_URL =
  process.env.SOCIAL_BANNER_FEED_URL ??
  "https://muhib-karim.github.io/bounty-radar/bounties.json";

const W = 1280;
const H = 640;

// ---- palette (matches the board's GitHub-dark theme) ----
const C = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  green: "#3fb950",
  amber: "#d29922",
  blue: "#58a6ff",
  greenDim: "rgba(63,185,80,0.10)",
};
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

// ---- fetch live stats ----
const feed = await fetch(FEED_URL, { signal: AbortSignal.timeout(20_000) });
if (!feed.ok) throw new Error(`feed fetch failed: HTTP ${feed.status}`);
const data = await feed.json();
const L = data.bounties ?? data.listings;
if (!Array.isArray(L) || L.length === 0) throw new Error("feed has no listings");

let usd = 0;
for (const x of L) if (x.amountUsd) usd += x.amountUsd;
const winnable = L.filter((x) => (x.score ?? 0) >= 6).length;
const usdFmt = "$" + usd.toLocaleString("en-US");
const generatedAt = data.generatedAt ?? new Date().toISOString();

// ---- helpers ----
const statBlock = (x, value, label, color) => `
  <text x="${x}" y="500" font-family="${FONT}" font-size="46" font-weight="700" fill="${color}">${value}</text>
  <text x="${x}" y="528" font-family="${FONT}" font-size="13" letter-spacing="2.5" fill="${C.muted}">${label}</text>`;

const chip = (x, label) => {
  const wpx = 26 + label.length * 8.2;
  return `<g>
    <rect x="${x}" y="560" width="${wpx}" height="34" rx="17" fill="#21262d" stroke="${C.border}"/>
    <text x="${x + wpx / 2}" y="582" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${C.blue}">${label}</text>
  </g>`;
};

// radar motif (right side): concentric rings, sweep wedge, live-looking blips
const cx = 1000, cy = 320;
const ring = (r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.border}" stroke-width="1.5" opacity="0.9"/>`;
const blip = (x, y, r, color, op) => `
  <circle cx="${x}" cy="${y}" r="${r * 3}" fill="${color}" opacity="0.12"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${op}"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bounty Radar — verified open-source bounties, ${L.length} live listings, ${usdFmt} tracked">
  <defs>
    <radialGradient id="glow" cx="78%" cy="50%" r="55%">
      <stop offset="0%" stop-color="${C.green}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${C.bg}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.green}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${C.green}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="0"/></clipPath>
  </defs>

  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>

    <!-- radar motif -->
    <g>
      ${ring(60)}${ring(110)}${ring(160)}${ring(210)}
      <line x1="${cx - 220}" y1="${cy}" x2="${cx + 220}" y2="${cy}" stroke="${C.border}" stroke-width="1" opacity="0.55"/>
      <line x1="${cx}" y1="${cy - 220}" x2="${cx}" y2="${cy + 220}" stroke="${C.border}" stroke-width="1" opacity="0.55"/>
      <path d="M ${cx} ${cy} L ${cx + 205} ${cy - 84} A 220 220 0 0 0 ${cx + 220} ${cy} Z" fill="url(#sweep)"/>
      <line x1="${cx}" y1="${cy}" x2="${cx + 205}" y2="${cy - 84}" stroke="${C.green}" stroke-width="2" opacity="0.8"/>
      ${blip(cx + 128, cy - 52, 7, C.green, 0.95)}
      ${blip(cx + 40, cy + 96, 6, C.amber, 0.9)}
      ${blip(cx - 96, cy + 30, 6, C.blue, 0.9)}
      ${blip(cx - 52, cy - 120, 5, C.green, 0.65)}
      ${blip(cx + 150, cy + 128, 5, C.amber, 0.6)}
      <circle cx="${cx}" cy="${cy}" r="4" fill="${C.text}"/>
    </g>

    <!-- left content -->
    <text x="64" y="118" font-family="${FONT}" font-size="14" font-weight="600" letter-spacing="4" fill="${C.green}">OPEN-SOURCE BOUNTY INTELLIGENCE</text>
    <text x="60" y="212" font-family="${FONT}" font-size="82" font-weight="800" fill="${C.text}">Bounty <tspan fill="${C.green}">Radar</tspan></text>
    <line x1="64" y1="248" x2="700" y2="248" stroke="${C.border}" stroke-width="1"/>
    <text x="64" y="292" font-family="${FONT}" font-size="21" fill="${C.muted}">Every “open bounty” verified before you spend a day on it:</text>
    <text x="64" y="322" font-family="${FONT}" font-size="21" fill="${C.muted}">repo active · issue open · spam filtered — published as an</text>
    <text x="64" y="352" font-family="${FONT}" font-size="21" fill="${C.muted}">agent-readable feed for humans <tspan fill="${C.text}">and</tspan> coding agents.</text>

    ${statBlock(64, String(L.length), "LIVE LISTINGS", C.text)}
    ${statBlock(320, usdFmt, "TRACKED PAYOUTS", C.green)}
    ${statBlock(576, winnable + "+", "SCORED WINNABLE", C.amber)}

    ${chip(64, "JSON feed")}${chip(190, "RSS")}${chip(268, "MCP for agents")}

    <text x="64" y="624" font-family="${FONT}" font-size="14" fill="${C.muted}">muhib-karim.github.io/bounty-radar · sweeps 6 sources every 6h — Algora, Opire, GitHub labels</text>
  </g>
</svg>`;

writeFileSync("docs/social-banner.svg", svg, "utf8");

// 2x render for the upload slot; fall back to 1x if it would exceed GitHub's 1MB
const png2x = await sharp(Buffer.from(svg), { density: 192 })
  .resize(2560, 1280)
  .png({ compressionLevel: 9 })
  .toBuffer();
if (png2x.byteLength <= 1_000_000) {
  writeFileSync("docs/social-banner.png", png2x);
  console.log(`social-banner: 2560x1280 png (${(png2x.byteLength / 1024).toFixed(0)} KB) + svg — stats: ${L.length} listings, ${usdFmt}, ${winnable} winnable`);
} else {
  const png1x = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync("docs/social-banner.png", png1x);
  console.log(`social-banner: 1280x640 png (${(png1x.byteLength / 1024).toFixed(0)} KB, 2x exceeded 1MB) + svg`);
}
