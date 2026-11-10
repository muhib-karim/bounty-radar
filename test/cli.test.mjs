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

// --- radar.mjs exit code -----------------------------------------------------
// Runs the real CLI in a child process with the network stubbed by a preload,
// inside a temp directory so no repo state is touched. `gh` is whatever the
// test puts on PATH: by default nothing, so every GitHub-backed source fails.
async function runRadarOffline(fetchStub, args = [], { ghScript = null, env = {} } = {}) {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "bounty-radar-cli-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    if (ghScript) writeFileSync(join(bin, "gh"), ghScript, { mode: 0o755 });
    const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${fetchStub};`)}`;
    const r = spawnSync(process.execPath, ["--import", preload, script("radar.mjs"), ...args],
      { cwd: dir, env: { PATH: bin, ...env }, encoding: "utf8", timeout: 30_000 });
    const statePath = join(dir, "state", "listings-seen.json");
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, state: existsSync(statePath) ? readFileSync(statePath, "utf8") : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OFFLINE = "async () => { throw new Error('offline') }";
const EMPTY_PAGES = "async () => new Response('')";
// every Algora jobs page lists one role; every other page is empty
const JOBS_ONLY = "async (url) => new Response(String(url).endsWith('/jobs') ? '<p>TypeScript Engineer</p><p>Remote</p>' : '')";

test("radar.mjs exits non-zero, prints no feed and writes no state when every source errors", async () => {
  for (const args of [[], ["--json"]]) {
    const r = await runRadarOffline(OFFLINE, args);
    assert.equal(r.status, 1, `args ${JSON.stringify(args)}: ${r.stderr}`);
    assert.equal(r.stdout, "", "nothing on stdout: an empty feed must never be published");
    assert.match(r.stderr, /all 6 sources errored/);
    assert.match(r.stderr, /source algora failed: .*offline/);
    assert.match(r.stderr, /source opire failed: gh search failed: the GitHub CLI \(gh\) is not installed/);
    assert.equal(r.state, null, "first-seen state untouched");
  }
});

test("radar.mjs also fails when some sources error and nothing at all is found", async () => {
  // Algora answers but lists nothing, and gh is unavailable: indistinguishable from an outage.
  const r = await runRadarOffline(EMPTY_PAGES, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no listings survived and 3 of 6 sources errored/);
  assert.equal(r.state, null);
});

test("radar.mjs exits 0 when some sources error but listings were found", async () => {
  const r = await runRadarOffline(JOBS_ONLY, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const feed = JSON.parse(r.stdout);
  assert.ok(feed.bounties.length >= 1);
  assert.equal(feed.bounties.every((b) => b.source === "algora-jobs" && b.score === 7 && b.first_seen), true);
  assert.match(r.stderr, /source github-labels failed/);
  assert.doesNotMatch(r.stderr, /radar failed/);
  assert.equal(Object.keys(JSON.parse(r.state)).length, feed.bounties.length);
});

test("radar.mjs exits 0 with an empty feed when every source answered and found nothing", async () => {
  const r = await runRadarOffline(EMPTY_PAGES, ["--json"], { ghScript: "#!/bin/sh\necho '[]'\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).bounties, []);
  assert.doesNotMatch(r.stderr, /failed/);
});

// Found by running a real sweep in a shell that forces colour: gh then colours
// and pretty-prints its --json output even into a pipe, JSON.parse rejected
// it, and all three GitHub-backed sources silently came back empty.
test("radar.mjs gets plain JSON from gh even when the environment forces colour", { skip: process.platform === "win32" }, async () => {
  const gh = [
    "#!/bin/sh",
    "if [ \"$CLICOLOR_FORCE\" = \"1\" ] || [ -n \"$GH_FORCE_TTY\" ] || [ -z \"$NO_COLOR\" ]; then",
    "  printf '\\033[1;38m[\\033[m\\n\\033[1;38m]\\033[m\\n'",
    "else",
    "  echo '[]'",
    "fi",
    "",
  ].join("\n");
  const r = await runRadarOffline(JOBS_ONLY, ["--json"], { ghScript: gh, env: { CLICOLOR_FORCE: "1", GH_FORCE_TTY: "100%", FORCE_COLOR: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /failed/, "no GitHub-backed source may fail on coloured output");
  assert.ok(JSON.parse(r.stdout).bounties.length >= 1);
});
