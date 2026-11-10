// Regression tests for the RSS feed written by build-site.mjs. The audited
// failures: the <guid> interpolated the raw title (so `&` or `<` in an issue
// title broke the XML) and ended in the listing's rank (so every re-ranking
// made feed readers show the listing again).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../build-site.mjs", import.meta.url));

/** Run build-site.mjs on `feed` in a temp dir; returns the written files as strings. */
function build(feed, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bounty-radar-site-"));
  try {
    const feedPath = join(dir, "feed.json");
    if (feed !== null) writeFileSync(feedPath, JSON.stringify(feed));
    const r = spawnSync(process.execPath, [SCRIPT, feedPath, join(dir, "site")],
      { encoding: "utf8", timeout: 60_000, cwd: dir, env: { ...process.env, HN_ITEM_ID: "", ...env } });
    const read = (name) => (existsSync(join(dir, "site", name)) ? readFileSync(join(dir, "site", name), "utf8") : null);
    return { status: r.status, stderr: r.stderr, rss: read("feed.xml"), html: read("index.html"), feedWritten: existsSync(feedPath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Minimal well-formedness check for the generated feed: legal characters only,
 * every `&` starts a predefined entity, every `<` starts a tag, tags nest.
 * Returns the items as unescaped { title, link, guid, pubDate, description }.
 */
function parseRss(xml) {
  assert.doesNotMatch(xml, /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u, "character not allowed in XML 1.0");
  assert.doesNotMatch(xml, /&(?!(?:amp|lt|gt|quot|apos);)/, "bare ampersand");
  const body = xml.replace(/^<\?xml [^?]*\?>\n/, "");
  const stack = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/y;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === ">") assert.fail(`stray ">" at offset ${i}: ${body.slice(Math.max(0, i - 40), i + 10)}`);
    if (body[i] !== "<") continue;
    tag.lastIndex = i;
    const m = tag.exec(body);
    assert.ok(m, `"<" that is not a tag at offset ${i}: ${body.slice(i, i + 50)}`);
    const [whole, closing, name, , selfClosing] = m;
    if (closing) assert.equal(stack.pop(), name, `mismatched </${name}>`);
    else if (!selfClosing) stack.push(name);
    i += whole.length - 1;
  }
  assert.deepEqual(stack, [], "unclosed elements");

  return [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const field = (name) => unescape(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))[1]);
    return { title: field("title"), link: field("link"), guid: field("guid"), pubDate: field("pubDate"), description: field("description") };
  });
}

const issue = (n, extra = {}) => ({
  source: "algora", org: "acme", repo: "widgets", issue: n, title: `Task ${n}`,
  url: `https://github.com/acme/widgets/issues/${n}`, amountUsd: 100 * n, ageDays: n, claimCount: 0,
  escrow: "algora-escrow", score: n, ...extra,
});
const job = (title, extra = {}) => ({
  source: "algora-jobs", org: "acme", repo: null, issue: null, title, url: "https://algora.io/acme/jobs",
  amountUsd: null, ageDays: null, escrow: "direct employment/contract — negotiate directly", noIssue: true, score: 7, ...extra,
});
const GENERATED = "2026-11-10T00:55:07.560Z";

test("hostile text in a listing still yields well-formed RSS, with the text preserved", () => {
  const title = `Fix <script>alert(1)</script> & "double" 'single' ]]> <![CDATA[ x`;
  const feed = {
    generatedAt: GENERATED,
    bounties: [
      issue(1, { title, desc: "R&D <b>bold</b> & more", url: "https://github.com/acme/widgets/issues/1?a=1&b=2" }),
      issue(2, { title: "control \u0001\u000B\u001F chars, lone surrogate \uD800, emoji 🎯 kept", escrow: "weird <escrow> & co" }),
      job(`Engineer <"R&D"> & 'ops'`, { source: "x<y&z" }),
    ],
  };
  const out = build(feed);
  assert.equal(out.status, 0, out.stderr);
  const items = parseRss(out.rss);
  assert.equal(items.length, 3);

  assert.equal(items[0].title, `[$100] [escrow ✓] acme/widgets#1 — ${title}`);
  assert.equal(items[0].link, "https://github.com/acme/widgets/issues/1?a=1&b=2");
  assert.equal(items[0].guid, "https://github.com/acme/widgets/issues/1?a=1&b=2");
  assert.match(items[0].description, /R&D <b>bold<\/b> & more$/);
  // characters XML cannot represent are dropped; everything else survives
  assert.equal(items[1].title, "[$200] [weird <escrow> & co] acme/widgets#2 — control  chars, lone surrogate , emoji 🎯 kept");
  assert.match(items[2].title, /Engineer <"R&D"> & 'ops'$/);
  assert.match(items[2].description, /^Source: x<y&z\./);

  // the same listings must not break or inject into the HTML page either
  assert.doesNotMatch(out.html, /<script>alert\(1\)<\/script>/);
  assert.match(out.html, /Fix &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;double&quot;/);
  assert.doesNotMatch(out.html, /&amp;(amp|lt|gt|quot);/, "nothing is escaped twice");
});

test("guid comes from the listing URL and does not depend on rank or order", () => {
  const listings = [issue(1), issue(2), issue(3), job("TypeScript Engineer"), job("Rust Engineer")];
  const a = parseRss(build({ generatedAt: GENERATED, bounties: listings }).rss);
  // next sweep: same listings, re-ranked (different order and scores)
  const reranked = [...listings].reverse().map((b, i) => ({ ...b, score: i }));
  const b = parseRss(build({ generatedAt: "2026-11-10T06:55:00.000Z", bounties: reranked }).rss);

  const byTitle = (items) => Object.fromEntries(items.map((it) => [it.title.replace(/^.* — /, ""), it.guid]));
  assert.deepEqual(byTitle(b), byTitle(a));
  assert.notDeepEqual(b.map((it) => it.guid), a.map((it) => it.guid), "the order really did change");

  assert.equal(byTitle(a)["Task 2"], "https://github.com/acme/widgets/issues/2");
  for (const it of a) {
    assert.ok(it.guid.startsWith(it.link), `${it.guid} is derived from ${it.link}`);
    assert.doesNotMatch(it.guid, /-\d+$/, "no positional suffix");
  }
});

test("guids are unique even when listings share a URL", () => {
  const listings = [job("TypeScript Engineer"), job("Rust Engineer"), job("Go Engineer", { org: "other", url: "https://algora.io/other/jobs" }), issue(4)];
  const items = parseRss(build({ generatedAt: GENERATED, bounties: listings }).rss);
  const guids = items.map((it) => it.guid);
  assert.equal(new Set(guids).size, 4);
  assert.deepEqual(guids.slice(0, 2), [
    "https://algora.io/acme/jobs#algora-jobs%3Aacme%3ATypeScript%20Engineer",
    "https://algora.io/acme/jobs#algora-jobs%3Aacme%3ARust%20Engineer",
  ]);

  // an issue listing keeps its guid when its title is edited or its amount changes
  const edited = parseRss(build({ generatedAt: GENERATED, bounties: [issue(4, { title: "Renamed", amountUsd: 999 })] }).rss);
  assert.equal(edited[0].guid, guids[3]);

  // the same listing twice (a hand-edited feed) is one entry, not a duplicated guid
  const twice = parseRss(build({ generatedAt: GENERATED, bounties: [issue(4), issue(4)] }).rss);
  assert.equal(twice.length, 1);
});

test("the feed is reproducible: same input, same bytes; pubDate is the first-seen time", () => {
  const feed = {
    generatedAt: GENERATED,
    bounties: [issue(1, { first_seen: "2026-09-01T00:00:00.000Z" }), issue(2), job("TypeScript Engineer")],
  };
  const first = build(feed);
  const second = build(feed);
  assert.equal(second.rss, first.rss);

  const items = parseRss(first.rss);
  assert.equal(items[0].pubDate, "Tue, 01 Sep 2026 00:00:00 GMT");
  assert.equal(items[1].pubDate, "Sun, 08 Nov 2026 00:55:07 GMT", "no first_seen: sweep time minus the listing's age");
  assert.equal(items[2].pubDate, "Tue, 10 Nov 2026 00:55:07 GMT");
  assert.match(first.rss, /<lastBuildDate>Tue, 10 Nov 2026 00:55:07 GMT<\/lastBuildDate>/);
});

test("scores are shown out of 12 in the page and the feed", () => {
  const out = build({ generatedAt: GENERATED, bounties: [issue(9), job("TypeScript Engineer")] });
  assert.match(out.html, /★ 9\/12</);
  assert.match(out.html, /★ 7\/12</);
  assert.match(parseRss(out.rss)[0].description, /Score: 9\/12\./);
  assert.doesNotMatch(out.html + out.rss, /\/15/);
});

test("when the sweep fails outright, no site is written", () => {
  // No feed on disk, so build-site runs the sweep itself. The preload makes
  // every fetch fail in the child sweep too, and PATH has no `gh`.
  const dir = mkdtempSync(join(tmpdir(), "bounty-radar-nogh-"));
  try {
    mkdirSync(join(dir, "bin"));
    const preload = `--import=data:text/javascript,${encodeURIComponent("globalThis.fetch=async()=>{throw new Error(String(503))}")}`;
    const out = build(null, { NODE_OPTIONS: preload, PATH: join(dir, "bin") });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /all 6 sources errored/);
    assert.equal(out.html, null);
    assert.equal(out.rss, null);
    assert.equal(out.feedWritten, false, "no empty feed cached for the next run either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
