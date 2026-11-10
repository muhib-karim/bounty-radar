#!/usr/bin/env node
/**
 * Alert notifier for Bounty Radar.
 * Sends a Discord and/or Telegram message when a listing with
 * score >= threshold appears in the radar feed.
 *
 * State is kept per listing AND per channel, so each channel announces each
 * listing exactly once:
 *   - a channel is marked only after its own send succeeded, and the state is
 *     saved right away. If Telegram fails after Discord succeeded, the next
 *     run retries Telegram only.
 *   - only the listings that were actually in the message are marked. One
 *     message carries at most 10 listings; the rest stay queued for the next
 *     run instead of being silently recorded as sent.
 *
 * State file shape:
 *   { "<listing key>": { "score": 9, "channels": { "discord": "<ISO time>", "telegram": "<ISO time>" } } }
 * Entries written before per-channel tracking (`{ "at": ..., "score": ... }`)
 * are read as sent on every channel.
 *
 * Usage:
 *   node notify.mjs feed.json                     # announce new 6+ listings
 *   node notify.mjs feed.json --threshold 8       # custom score threshold
 *   node notify.mjs feed.json --dry-run           # show what would fire, send nothing
 *   node notify.mjs feed.json --state state.json  # custom state file
 *
 * Env vars:
 *   DISCORD_WEBHOOK_URL   — Discord channel webhook (post message)
 *   TELEGRAM_BOT_TOKEN    — bot token from @BotFather
 *   TELEGRAM_CHAT_ID      — chat/channel id to message
 * At least one channel must be configured (unless --dry-run).
 *
 * Exit codes: 0 = nothing to do or everything sent, 1 = a channel failed (the
 * channels that succeeded are recorded), 2 = no channel configured.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SCORE } from "./radar.mjs";

/** Listings per message: Discord accepts at most 10 embeds. */
export const MAX_PER_MESSAGE = 10;
const TELEGRAM_MAX_CHARS = 4000; // Telegram rejects messages over 4096
const SEND_TIMEOUT_MS = 15_000;

const escHtml = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const listingKey = (b) => (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Has `channel` already announced the listing with this key? */
export function wasSent(state, key, channel) {
  const entry = state[key];
  if (!entry) return false;
  if (!entry.channels) return true; // pre-per-channel entry: sent everywhere
  return Boolean(entry.channels[channel]);
}

function markSent(state, listings, channel, at) {
  for (const b of listings) {
    const key = listingKey(b);
    const entry = state[key]?.channels ? state[key] : { score: b.score, channels: {} };
    entry.score = b.score;
    entry.channels[channel] = at;
    state[key] = entry;
  }
}

/** The channels that have credentials in `env`. */
export function configuredChannels(env) {
  const channels = [];
  if (env.DISCORD_WEBHOOK_URL) channels.push("discord");
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push("telegram");
  return channels;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

const SOURCE_LABEL = {
  "algora-jobs": "Algora Jobs",
  "algora-challenge": "Algora Challenge",
  "algora-mention": "Algora Thread",
  algora: "Algora Bounty",
  opire: "Opire",
  "github-label": "GitHub Bounty",
};

const money = (b) => (b.amountUsd != null ? `$${b.amountUsd.toLocaleString("en-US")}` : null);
const queuedNote = (queued) => (queued > 0 ? ` — ${queued} more queued for the next run` : "");

/** Discord message for `batch` (at most MAX_PER_MESSAGE listings). */
export function discordPayload(batch, pendingTotal, threshold) {
  const embeds = batch.map((b) => ({
    title: `${money(b) ?? "New"} · ${b.title}`.slice(0, 250),
    url: b.url,
    description: (
      `${SOURCE_LABEL[b.source] ?? b.source} · score **${b.score}/${MAX_SCORE}**\n` +
      (b.escrow ? `_${b.escrow}_\n` : "")
    ).slice(0, 300),
    color: 0x3fb950,
  }));
  return {
    username: "Bounty Radar",
    content: `🚨 **${batch.length} new high-opportunity listing(s)** (score ≥ ${threshold})${queuedNote(pendingTotal - batch.length)}`,
    embeds,
  };
}

function telegramBlock(b, withLink = true) {
  const head = `<b>${escHtml(money(b) ?? "?")}</b> · ★${escHtml(b.score)}/${MAX_SCORE} · ${escHtml(SOURCE_LABEL[b.source] ?? b.source)}`;
  const title = escHtml(String(b.title ?? "").slice(0, 200));
  return withLink && b.url ? `${head}\n<a href="${escHtml(b.url)}">${title}</a>` : `${head}\n${title}`;
}

/**
 * Telegram message (parse_mode HTML) for as many of `pending` as fit: whole
 * listings only, never cut mid-listing. Returns the text and the listings in it.
 */
export function telegramMessage(pending, threshold) {
  const included = [];
  const blocks = [];
  // room for the header, whose "N more queued" part is only known at the end
  let used = 120;
  for (const b of pending.slice(0, MAX_PER_MESSAGE)) {
    let block = telegramBlock(b);
    if (used + block.length + 2 > TELEGRAM_MAX_CHARS) {
      if (included.length > 0) break;
      block = telegramBlock(b, false); // a single oversized listing still goes out, without its link
    }
    blocks.push(block);
    included.push(b);
    used += block.length + 2;
  }
  const header = `🚨 ${included.length} new high-opportunity listing(s) (score ≥ ${threshold})${queuedNote(pending.length - included.length)}`;
  return { text: `${header}\n\n${blocks.join("\n\n")}`, included };
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

async function postJson(fetchImpl, url, body, label) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  // Report the service and status only: both URLs embed a credential.
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const SENDERS = {
  async discord({ env, fetchImpl, pending, threshold }) {
    const batch = pending.slice(0, MAX_PER_MESSAGE);
    await postJson(fetchImpl, env.DISCORD_WEBHOOK_URL, discordPayload(batch, pending.length, threshold), "Discord webhook");
    return batch;
  },
  async telegram({ env, fetchImpl, pending, threshold }) {
    const { text, included } = telegramMessage(pending, threshold);
    await postJson(
      fetchImpl,
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true },
      "Telegram",
    );
    return included;
  },
};

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Listings at or above the threshold, split by what each configured channel
 * still has to announce. `fresh` is anything pending on at least one channel
 * (with no channel configured: anything never announced at all).
 */
export function planAlerts({ feed, state, env, threshold }) {
  const eligible = (feed.bounties ?? []).filter((b) => (b.score ?? 0) >= threshold);
  const channels = configuredChannels(env);
  const pending = Object.fromEntries(
    channels.map((ch) => [ch, eligible.filter((b) => !wasSent(state, listingKey(b), ch))]),
  );
  const fresh = channels.length
    ? eligible.filter((b) => channels.some((ch) => !wasSent(state, listingKey(b), ch)))
    : eligible.filter((b) => !state[listingKey(b)]);
  return { channels, pending, fresh };
}

/**
 * Send what each channel still owes. Channels are independent: one failing
 * neither blocks nor un-records another. `state` is updated in place and
 * `save(state)` is called after every channel that sent something.
 * Returns one report per channel: { channel, sent, queued, error }.
 */
export async function sendAlerts({ plan, state, env, threshold, fetchImpl = fetch, save = () => {}, now = () => new Date() }) {
  const reports = [];
  for (const channel of plan.channels) {
    const pending = plan.pending[channel];
    if (pending.length === 0) {
      reports.push({ channel, sent: [], queued: 0, error: null });
      continue;
    }
    try {
      const sent = await SENDERS[channel]({ env, fetchImpl, pending, threshold });
      markSent(state, sent, channel, now().toISOString());
      save(state);
      reports.push({ channel, sent: sent.map(listingKey), queued: pending.length - sent.length, error: null });
    } catch (err) {
      reports.push({ channel, sent: [], queued: pending.length, error: err?.message ?? String(err) });
    }
  }
  return reports;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function loadState(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Write via a temp file so a crash mid-write cannot leave half a state file. */
function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

async function main(argv, env) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const flagValues = new Set(["threshold", "state"].map(flag).filter((v) => v !== undefined));
  const feedPath = argv.find((a) => !a.startsWith("--") && !flagValues.has(a)) ?? "feed.json";
  const threshold = Number(flag("threshold") ?? 6);
  const statePath = flag("state") ?? join(dirname(feedPath), "state", "alerts-state.json");
  const dryRun = argv.includes("--dry-run");

  const feed = JSON.parse(readFileSync(feedPath, "utf8"));
  const state = loadState(statePath);
  const plan = planAlerts({ feed, state, env, threshold });

  if (plan.fresh.length === 0) {
    console.log(`[notify] nothing new at or above score ${threshold}.`);
    return 0;
  }

  console.log(`[notify] ${plan.fresh.length} new listing(s) at score >= ${threshold}:`);
  for (const b of plan.fresh) console.log(`  - ★${b.score} ${(b.amountUsd != null ? `$${b.amountUsd}` : "")} ${String(b.title).slice(0, 70)}`);

  if (dryRun) {
    const detail = plan.channels.map((ch) => `${ch}: ${Math.min(plan.pending[ch].length, MAX_PER_MESSAGE)} of ${plan.pending[ch].length} pending`);
    console.log(`[notify] dry-run: would send to [${detail.join(", ") || "nowhere — no env vars set"}]`);
    return 0;
  }

  if (plan.channels.length === 0) {
    console.error("[notify] no DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set — cannot send.");
    return 2;
  }

  const reports = await sendAlerts({ plan, state, env, threshold, save: (s) => saveState(statePath, s) });
  for (const r of reports) {
    if (r.error) console.error(`[notify] ${r.channel} failed, ${r.queued} listing(s) stay queued: ${r.error}`);
    else if (r.sent.length) console.log(`[notify] ${r.channel}: sent ${r.sent.length}${r.queued ? `, ${r.queued} queued for the next run` : ""}; state updated: ${statePath}`);
    else console.log(`[notify] ${r.channel}: nothing pending.`);
  }
  return reports.some((r) => r.error) ? 1 : 0;
}

// Run only when executed directly, so tests can import the functions above.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error("[notify] failed:", err.message);
      process.exit(1);
    },
  );
}
