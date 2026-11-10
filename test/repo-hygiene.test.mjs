// Drift guards. Each of these went stale once already: a pre-rename account
// name in URLs, a pin to a package version that never existed, a preflight
// check looking for a README heading that had been renamed, and scores shown
// out of a maximum the scorer cannot reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SCORE } from "../radar.mjs";
import { headingAnchors, MCP_ANCHOR } from "../preflight.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// state/ is written by the scheduled workflows (it holds historical PR ids
// under the old account name); lockfiles and binaries are not prose.
const SKIP_DIRS = new Set([".git", "node_modules", "state", "site", ".wrangler"]);
const TEXT = /\.(mjs|js|json|md|yml|yaml|toml|svg|txt)$/;

function textFiles(dir = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...textFiles(join(dir, entry.name)));
    } else if (TEXT.test(entry.name) && entry.name !== "package-lock.json") {
      out.push(relative(ROOT, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return out;
}

const FILES = textFiles().filter((f) => f !== "test/repo-hygiene.test.mjs");
const WORKFLOWS = FILES.filter((f) => f.startsWith(".github/workflows/"));
const README = read("README.md");

test("no reference to the pre-rename GitHub account, except the live Worker host", () => {
  // The Worker's workers.dev subdomain belongs to the Cloudflare account and
  // did not change with the GitHub rename; it is the one deliberate exception.
  const LIVE_WORKER = "bounty-radar-api.ai-dev-2024.workers.dev";
  const stale = [];
  for (const file of FILES) {
    read(file).split("\n").forEach((line, i) => {
      if (line.replaceAll(LIVE_WORKER, "").includes("ai-dev-2024")) stale.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(stale, []);
});

test("every action in every workflow is pinned to a full commit SHA", () => {
  assert.ok(WORKFLOWS.length >= 4);
  let uses = 0;
  for (const file of WORKFLOWS) {
    for (const [, ref] of read(file).matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      uses++;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${ref}`);
    }
  }
  assert.ok(uses >= 10, `expected to inspect the workflows' actions, saw ${uses}`);
});

test("sharp is pinned to a released 0.33/0.34 version and its install is not silenced", () => {
  const workflow = read(".github/workflows/sweep-and-publish.yml");
  const pins = [...workflow.matchAll(/sharp@([\w.-]+)/g)].map((m) => m[1]);
  assert.equal(pins.length, 1);
  assert.match(pins[0], /^0\.3[34]\.\d+$/);
  const install = workflow.split("\n").find((line) => line.includes("sharp@"));
  assert.doesNotMatch(install, /\/dev\/null|\|\|\s*true/);
});

test("ci.yml runs lint, test and gitleaks on pull requests", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^ {2}pull_request:/m);
  for (const job of ["lint", "test", "gitleaks"]) assert.match(ci, new RegExp(`^ {2}${job}:$`, "m"), job);
  assert.match(ci, /npm run lint/);
  assert.match(ci, /npm test/);
  assert.match(ci, /gitleaks\/gitleaks-action@[0-9a-f]{40}/);
});

test("the root package has no runtime dependencies and exposes lint, test and check", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), []);
  assert.ok(pkg.devDependencies.eslint);
  for (const script of ["lint", "test", "check"]) assert.ok(pkg.scripts[script], script);
  // the Worker ships without dependencies too: wrangler is a deploy tool
  assert.deepEqual(Object.keys(JSON.parse(read("worker/package.json")).dependencies ?? {}), []);
  assert.doesNotMatch(read("worker/src/index.js"), /^\s*import\s/m);
});

test("no script shows a score out of anything but MAX_SCORE", () => {
  assert.equal(MAX_SCORE, 12);
  const wrong = [];
  for (const file of FILES.filter((f) => !f.startsWith("test/"))) {
    read(file).split("\n").forEach((line, i) => {
      if (/score[^\n]{0,40}\/15\b|0[–-]15\b/i.test(line)) wrong.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(wrong, []);
});

test("README has the anchor the board and the launch docs link to", () => {
  assert.ok(headingAnchors(README).includes(MCP_ANCHOR));
  for (const file of ["build-site.mjs", "docs/SHOW_HN.md"]) {
    const links = [...read(file).matchAll(/github\.com\/muhib-karim\/bounty-radar#([\w-]+)/g)].map((m) => m[1]);
    assert.ok(links.length > 0, `${file} links into the README`);
    for (const anchor of links) assert.ok(headingAnchors(README).includes(anchor), `${file} links to #${anchor}`);
  }
});

test("README links that point inside the README resolve", () => {
  const anchors = headingAnchors(README);
  for (const [, anchor] of README.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(anchors.includes(anchor), `#${anchor}`);
});

test("README carries CI and licence badges for muhib-karim/bounty-radar", () => {
  assert.match(README, /https:\/\/github\.com\/muhib-karim\/bounty-radar\/actions\/workflows\/ci\.yml\/badge\.svg/);
  assert.match(README, /https:\/\/img\.shields\.io\/github\/license\/muhib-karim\/bounty-radar/);
  assert.match(read("LICENSE"), /MIT License/);
});

test("README documents every environment variable the code reads", () => {
  const names = new Set();
  // Node scripts: process.env.NAME, plus the injected `env.NAME` in notify.mjs
  for (const file of FILES.filter((f) => /^[\w-]+\.mjs$/.test(f))) {
    for (const [, name] of read(file).matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(name);
  }
  // Worker: env.NAME (vars, secrets and bindings)
  for (const [, name] of read("worker/src/index.js").matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) names.add(name);
  // wrangler.toml: declared vars and bindings
  const toml = read("worker/wrangler.toml");
  for (const [, name] of toml.matchAll(/^([A-Z][A-Z0-9_]+)\s*=/gm)) names.add(name);
  for (const [, name] of toml.matchAll(/^binding\s*=\s*"([A-Z0-9_]+)"/gm)) names.add(name);
  // workflows: secrets.NAME and vars.NAME
  for (const file of WORKFLOWS) {
    for (const [, name] of read(file).matchAll(/\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)\b/g)) names.add(name);
  }

  assert.ok(names.size >= 25, `found only ${names.size} variables: the scan is broken`);
  for (const expected of ["STRIPE_SECRET", "QUOTA_FLUSH_MS", "KEYS", "DISCORD_WEBHOOK_URL", "HN_ITEM_ID", "SITE_URL"]) {
    assert.ok(names.has(expected), `scan should have found ${expected}`);
  }
  const undocumented = [...names].filter((name) => !README.includes(`\`${name}\``)).sort();
  assert.deepEqual(undocumented, []);
});
