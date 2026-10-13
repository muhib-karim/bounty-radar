// Smoke tests: --help must print usage and exit 0 without touching the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const run = (name, args) => execFileSync(process.execPath, [script(name), ...args], { encoding: "utf8", timeout: 10_000 });

test("radar.mjs --help prints usage", () => {
  const out = run("radar.mjs", ["--help"]);
  assert.match(out, /^Usage: node radar\.mjs/);
  assert.match(out, /--max-age N/);
});

test("radar.mjs -h prints usage", () => {
  assert.match(run("radar.mjs", ["-h"]), /^Usage:/);
});

test("mcp-server.mjs --help prints usage", () => {
  assert.match(run("mcp-server.mjs", ["--help"]), /search_bounties/);
});

test("notify.mjs --dry-run on the fixture feed sends nothing", () => {
  const out = run("notify.mjs", [fileURLToPath(new URL("./fixtures/feed.json", import.meta.url)), "--dry-run", "--state", "/dev/null"]);
  assert.match(out, /3 new listing\(s\) at score >= 6/);
  assert.match(out, /dry-run: would send/);
});

test("build-site.mjs renders HTML, RSS and JSON from a local feed", async () => {
  const { mkdtempSync, copyFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "bounty-radar-"));
  try {
    // Copy so the feed's mtime is fresh (build-site re-sweeps stale feeds).
    const feed = join(dir, "feed.json");
    copyFileSync(fileURLToPath(new URL("./fixtures/feed.json", import.meta.url)), feed);
    const env = { ...process.env, HN_ITEM_ID: "" };
    execFileSync(process.execPath, [script("build-site.mjs"), feed, join(dir, "site")], { env, timeout: 30_000, stdio: "pipe" });
    const html = readFileSync(join(dir, "site", "index.html"), "utf8");
    assert.match(html, /Add CSV export/);
    assert.match(readFileSync(join(dir, "site", "feed.xml"), "utf8"), /<rss[\s\S]*<item>/);
    assert.equal(JSON.parse(readFileSync(join(dir, "site", "bounties.json"), "utf8")).bounties.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
