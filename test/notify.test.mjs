// Regression tests for alert delivery. The audited failures: state was one
// flag per listing written only after every channel succeeded, so a Telegram
// failure after a Discord success re-alerted Discord on the next run; and
// every eligible listing was marked sent although a message carries only 10.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planAlerts, sendAlerts, wasSent, listingKey, telegramMessage, discordPayload, MAX_PER_MESSAGE } from "../notify.mjs";

const ENV = { DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/1/token", TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_CHAT_ID: "42" };
const THRESHOLD = 6;

const listing = (n, extra = {}) => ({
  source: "algora", org: "acme", repo: "widgets", issue: n, title: `Task ${n}`,
  url: `https://github.com/acme/widgets/issues/${n}`, amountUsd: 100 * n, score: 9, escrow: "algora-escrow", ...extra,
});
const feedOf = (bounties) => ({ generatedAt: "2026-11-10T00:00:00.000Z", bounties });

/** fetch stand-in that records each send and fails the channels named in `failing`. */
function fakeFetch(failing = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const channel = String(url).includes("api.telegram.org") ? "telegram" : "discord";
    calls.push({ channel, url: String(url), body: JSON.parse(init.body) });
    return failing.includes(channel)
      ? new Response("Bad Request: can't parse entities", { status: 400 })
      : new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl };
}

/** One run of the notifier against in-memory state. */
async function run(feed, state, { failing = [], env = ENV } = {}) {
  const { calls, fetchImpl } = fakeFetch(failing);
  const saves = [];
  const plan = planAlerts({ feed, state, env, threshold: THRESHOLD });
  const reports = await sendAlerts({
    plan, state, env, threshold: THRESHOLD, fetchImpl,
    save: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    now: () => new Date("2026-11-10T01:00:00.000Z"),
  });
  return { calls, reports, saves, plan, channels: calls.map((c) => c.channel) };
}

test("Telegram failing after Discord succeeded does not re-alert Discord on the next run", async () => {
  const feed = feedOf([listing(1), listing(2), listing(3)]);
  const state = {};

  const first = await run(feed, state, { failing: ["telegram"] });
  assert.deepEqual(first.channels, ["discord", "telegram"]);
  assert.deepEqual(first.reports.map((r) => [r.channel, r.sent.length, r.queued, Boolean(r.error)]),
    [["discord", 3, 0, false], ["telegram", 0, 3, true]]);
  assert.match(first.reports[1].error, /^Telegram 400/);
  for (const b of feed.bounties) {
    assert.equal(wasSent(state, listingKey(b), "discord"), true);
    assert.equal(wasSent(state, listingKey(b), "telegram"), false);
  }
  // Discord's success was saved before Telegram was even attempted
  assert.equal(first.saves.length, 1);
  assert.deepEqual(first.saves[0]["acme/widgets#1"], { score: 9, channels: { discord: "2026-11-10T01:00:00.000Z" } });

  const second = await run(feed, state);
  assert.deepEqual(second.channels, ["telegram"], "only the channel that failed is retried");
  for (const b of feed.bounties) assert.equal(wasSent(state, listingKey(b), "telegram"), true);

  const third = await run(feed, state);
  assert.deepEqual(third.channels, []);
  assert.equal(third.plan.fresh.length, 0);
});

test("the mirror case: Discord failing does not block or un-record Telegram", async () => {
  const feed = feedOf([listing(1)]);
  const state = {};
  const first = await run(feed, state, { failing: ["discord"] });
  assert.deepEqual(first.channels, ["discord", "telegram"]);
  assert.equal(wasSent(state, "acme/widgets#1", "telegram"), true);
  assert.equal(wasSent(state, "acme/widgets#1", "discord"), false);

  const second = await run(feed, state);
  assert.deepEqual(second.channels, ["discord"]);
});

test("listings beyond the per-message cap are not marked sent; they go out next run", async () => {
  const all = Array.from({ length: 12 }, (_, i) => listing(i + 1));
  const feed = feedOf(all);
  const state = {};
  const env = { DISCORD_WEBHOOK_URL: ENV.DISCORD_WEBHOOK_URL };

  const first = await run(feed, state, { env });
  assert.equal(MAX_PER_MESSAGE, 10);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].body.embeds.length, 10);
  assert.match(first.calls[0].body.content, /10 new high-opportunity listing\(s\).*2 more queued/);
  assert.deepEqual(first.reports[0].sent, all.slice(0, 10).map(listingKey));
  assert.equal(first.reports[0].queued, 2);
  assert.deepEqual(all.map((b) => wasSent(state, listingKey(b), "discord")),
    [...Array(10).fill(true), false, false]);
  assert.equal(Object.keys(state).length, 10);

  const second = await run(feed, state, { env });
  assert.deepEqual(second.calls[0].body.embeds.map((e) => e.url), all.slice(10).map((b) => b.url));
  assert.doesNotMatch(second.calls[0].body.content, /queued/);
  assert.equal(all.every((b) => wasSent(state, listingKey(b), "discord")), true);

  assert.equal((await run(feed, state, { env })).calls.length, 0);
});

test("Telegram marks only the listings that fit in the message", async () => {
  const longUrl = (n) => `https://github.com/acme/widgets/issues/${n}?${"x".repeat(420)}`;
  const all = Array.from({ length: 10 }, (_, i) => listing(i + 1, { url: longUrl(i + 1), title: `Task ${i + 1} ${"t".repeat(300)}` }));
  const state = {};
  const env = { TELEGRAM_BOT_TOKEN: ENV.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: ENV.TELEGRAM_CHAT_ID };

  const first = await run(feedOf(all), state, { env });
  const sent = first.reports[0].sent.length;
  assert.ok(sent >= 1 && sent < 10, `expected a partial message, got ${sent} listings`);
  assert.ok(first.calls[0].body.text.length <= 4096);
  assert.equal(first.reports[0].queued, 10 - sent);
  assert.deepEqual(all.map((b) => wasSent(state, listingKey(b), "telegram")), all.map((_, i) => i < sent));
  // whole listings only: every link in the message is complete
  assert.equal(first.calls[0].body.text.match(/<a href="/g).length, sent);
  assert.equal(first.calls[0].body.text.match(/<\/a>/g).length, sent);

  let runs = 1;
  while ((await run(feedOf(all), state, { env })).calls.length) runs++;
  assert.equal(all.every((b) => wasSent(state, listingKey(b), "telegram")), true);
  assert.ok(runs <= 10);
});

test("state written before per-channel tracking is read as sent on every channel", async () => {
  const feed = feedOf([listing(1), listing(2)]);
  const state = { "acme/widgets#1": { at: "2026-10-01T00:00:00.000Z", score: 9 } };
  const result = await run(feed, state);
  assert.deepEqual(result.calls.map((c) => [c.channel, c.channel === "discord" ? c.body.embeds.length : 1]),
    [["discord", 1], ["telegram", 1]]);
  assert.deepEqual(state["acme/widgets#1"], { at: "2026-10-01T00:00:00.000Z", score: 9 }, "legacy entry left as it was");
  assert.deepEqual(Object.keys(state["acme/widgets#2"].channels).sort(), ["discord", "telegram"]);
});

test("only listings at or above the threshold are announced, on configured channels only", async () => {
  const feed = feedOf([listing(1, { score: 9 }), listing(2, { score: 5 }), listing(3, { score: 6 })]);
  const state = {};
  const result = await run(feed, state, { env: { DISCORD_WEBHOOK_URL: ENV.DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN: "set-but-no-chat-id" } });
  assert.deepEqual(result.channels, ["discord"]);
  assert.deepEqual(Object.keys(state).sort(), ["acme/widgets#1", "acme/widgets#3"]);

  const none = planAlerts({ feed, state: {}, env: {}, threshold: THRESHOLD });
  assert.deepEqual([none.channels, none.fresh.length], [[], 2]);
});

test("messages show the score out of 12 and escape listing text for Telegram's HTML mode", () => {
  const b = listing(1, { title: `Fix <b>bold</b> & "quotes" _under_ *star* [x](y)`, url: "https://example.com/?a=1&b=<2>", source: "github-label" });
  const { text, included } = telegramMessage([b], THRESHOLD);
  assert.equal(included.length, 1);
  assert.match(text, /^🚨 1 new high-opportunity listing\(s\) \(score ≥ 6\)\n\n<b>\$100<\/b> · ★9\/12 · GitHub Bounty\n/);
  assert.match(text, /<a href="https:\/\/example\.com\/\?a=1&amp;b=&lt;2&gt;">Fix &lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quotes&quot; _under_ \*star\* \[x\]\(y\)<\/a>$/);

  const payload = discordPayload([b], 1, THRESHOLD);
  assert.match(payload.embeds[0].description, /score \*\*9\/12\*\*/);
  assert.doesNotMatch(JSON.stringify(payload) + text, /\/15/);
});

// --- the CLI, end to end --------------------------------------------------------

const SCRIPT = fileURLToPath(new URL("../notify.mjs", import.meta.url));

/** Run notify.mjs with fetch replaced by a preload that fails the given channel. */
function cli(dir, { fail }) {
  const stub = `globalThis.fetch = async (url) => new Response("x", { status: String(url).includes(${JSON.stringify(fail)}) ? 500 : 200 });`;
  return spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(stub)}`,
    SCRIPT, join(dir, "feed.json"), "--state", join(dir, "state", "alerts-state.json"),
  ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...ENV } });
}

test("CLI: a failed channel exits 1 but the successful channel's state is on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "bounty-radar-notify-"));
  try {
    writeFileSync(join(dir, "feed.json"), JSON.stringify(feedOf([listing(1), listing(2)])));
    const statePath = join(dir, "state", "alerts-state.json");

    const first = cli(dir, { fail: "api.telegram.org" });
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stderr, /telegram failed, 2 listing\(s\) stay queued: Telegram 500/);
    assert.doesNotMatch(first.stdout + first.stderr, /123:token|webhooks\/1\/token/, "credentials never reach the logs");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(Object.keys(saved["acme/widgets#1"].channels), ["discord"]);
    assert.equal(existsSync(`${statePath}.tmp`), false);

    // Next run: Discord would fail if it were contacted again. It is not.
    const second = cli(dir, { fail: "discord.test" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /discord: nothing pending/);
    assert.match(second.stdout, /telegram: sent 2/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, "utf8"))["acme/widgets#2"].channels).sort(), ["discord", "telegram"]);

    const third = cli(dir, { fail: "nothing" });
    assert.equal(third.status, 0);
    assert.match(third.stdout, /nothing new at or above score 6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: no channel configured exits 2 and writes no state", () => {
  const dir = mkdtempSync(join(tmpdir(), "bounty-radar-notify-"));
  try {
    writeFileSync(join(dir, "feed.json"), JSON.stringify(feedOf([listing(1)])));
    const env = { ...process.env };
    for (const name of Object.keys(ENV)) delete env[name];
    const r = spawnSync(process.execPath, [SCRIPT, join(dir, "feed.json")], { encoding: "utf8", timeout: 30_000, env });
    assert.equal(r.status, 2);
    assert.equal(existsSync(join(dir, "state")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
