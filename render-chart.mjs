#!/usr/bin/env node
/**
 * Render momentum.svg → momentum.png (for the HN thread's first comment,
 * social posts, README). One dep (sharp), run in CI only — see
 * sweep-and-publish.yml. Usage: node render-chart.mjs site/momentum.svg site/momentum.png
 */
import { readFileSync } from "node:fs";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: node render-chart.mjs <in.svg> <out.png>");
  process.exit(2);
}

// sharp (pinned in sweep-and-publish.yml) renders SVG via its bundled librsvg — no system deps.
const { default: sharp } = await import("sharp");
const svg = readFileSync(inPath, "utf8");

await sharp(Buffer.from(svg), { density: 192 }) // 2x for crisp social embeds
  .png({ compressionLevel: 9 })
  .toFile(outPath);

console.log(`[render-chart] wrote ${outPath} (${svg.length} bytes svg in)`);
