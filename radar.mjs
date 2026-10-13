#!/usr/bin/env node
/**
 * Daily Bounty Radar
 * ------------------
 * Sweeps Algora, Opire and GitHub bounty-label issues for open bounties,
 * PLUS Algora jobs (full-time/contract), challenges, and Algora-mention
 * paid-work discussions — the higher-income alternatives to bounties.
 *
 * Verifies each candidate repo is active (pushed within the last 60 days),
 * filters out dead repos / escrow-less spam, and prints a ranked digest.
 *
 * Zero external dependencies. Requires Node 20+ and the GitHub CLI (`gh`)
 * authenticated with repo read access.
 *
 * Usage:
 *   node radar.mjs                # human-readable digest
 *   node radar.mjs --json         # machine-readable JSON to stdout
 *   node radar.mjs --out FILE     # also write the markdown digest to FILE
 *   node radar.mjs --max-age 14   # only bounties seen as new within N days
 *   node radar.mjs --help         # print usage and exit
 *
 * Exit codes: 0 = ran fine (even if no bounties), 1 = hard failure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ACTIVE_DAYS = 60;      // repo must have been pushed within this window
const CLAIM_STALENESS_DAYS = 21;  // a claim older than this is considered expired
const ALGORA_TIMEOUT_MS = 12_000;
const GITHUB_TIMEOUT_MS = 30_000;

/** Algora orgs known to run real, escrow-backed bounty programs (escrow via Algora). */
const ALGORA_ORGS = [
  "tscircuit",
  "tailcallhq",
  "cal",
  "daytonaio",
  "formbricks",
  "trieve",
  "unkey",
  "unsiloed-ai",
  "prisma",
];

/** Orgs whose /jobs pages we check for full-time & contract OSS roles. */
const ALGORA_JOBS_ORGS = [...new Set([...ALGORA_ORGS, "antinomyhq", "forgecode", "i-am-bee", "blitz-js"])];

/**
 * Known spam patterns for GitHub bounty-labeled issues. These repos/orgs mass-
 * produce fake "[Bounty: $X]" issues with no escrow behind them. Escrow-less
 * listings are excluded because there is no guarantee of payment.
 */
const SPAM_PATTERNS = [
  /bounty[-_]?plaza/i,
  /bug[-_]?bounty(?!-platforms)/i,
  /oss-hunter/i,
  /misakanet/i,
];

const GITHUB_BOUNTY_LABELS = ["💰 bounty", "💎 bounty", "bounty", "💵 bounty"];

export const USAGE = `Usage: node radar.mjs [options]

Sweeps Algora, Opire and GitHub bounty labels, verifies each candidate repo
is alive, and prints a ranked digest. Requires Node 20+ and an authenticated
GitHub CLI (gh).

Options:
  --json          machine-readable JSON to stdout (progress on stderr)
  --out FILE      also write the markdown digest to FILE
  --max-age N     only keep listings at most N days old
  -h, --help      show this help and exit`;

/** Parse CLI flags. Pure: takes argv (without node + script), returns options. */
export function parseArgs(argv) {
  const valueOf = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const maxAge = Number(valueOf("--max-age"));
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json"),
    out: valueOf("--out") ?? null,
    maxAge: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : null,
  };
}

const { json: FLAG_JSON, out: FLAG_OUT, maxAge: FLAG_MAX_AGE } = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch with a hard timeout. */
async function fetchWithTimeout(url, ms, init = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Run `gh` and return parsed JSON, or null on failure. */
async function gh(args, timeoutMs = GITHUB_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: timeoutMs });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 86_400_000;
const fmtDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "?");

export function isSpam(owner, repo, title) {
  const hay = `${owner}/${repo} ${title}`;
  return SPAM_PATTERNS.some((re) => re.test(hay));
}

/** First "$1,234"-style amount in a title, as a number, or null. */
export function titleAmountUsd(title) {
  const m = String(title).match(/\$(\d[\d,]*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Mass-produced fake bounties use a copy-pasted "[Bounty: $X]" / "[Bounty]" title prefix. */
export function isBaitTitle(title) {
  return /^\s*\[\s*bounty\s*[:\]]/i.test(title);
}

/** Drop listings older than maxAge days; listings with unknown age are kept. */
export function filterByMaxAge(candidates, maxAge) {
  return candidates.filter((c) => maxAge == null || c.ageDays == null || c.ageDays <= maxAge);
}

/** Rank by score (desc), then amount (desc). Returns new objects with `score` set. */
export function rankBounties(bounties) {
  return bounties
    .map((b) => ({ ...b, score: scoreBounty(b) }))
    .sort((a, b) => b.score - a.score || (b.amountUsd ?? 0) - (a.amountUsd ?? 0));
}

// ---------------------------------------------------------------------------
// Source 1: Algora org bounty pages
// ---------------------------------------------------------------------------

/**
 * Algora renders bounty lists client-side, but the raw text of the page still
 * contains the listings. We fetch the HTML and parse the (title, $amount, age,
 * claims) tuples out of the text layer. If the page is unavailable we skip.
 */
export function parseAlgoraText(text) {
  const results = [];
  // Entries look like: "$500\nrepo#373\nfeature: do the thing\n25 months ago\n[2 claims]"
  const entryRe =
    /\$(\d[\d,]*)\s*\n+\s*([A-Za-z0-9_.-]+)#(\d+)\s*\n+\s*([^\n]+?)\s*\n+\s*(\d+)\s+(hour|day|week|month|year)s?\s+ago(?:\s*\n+\s*(\d+)\s+claims?)?/g;
  let m;
  while ((m = entryRe.exec(text)) !== null) {
    const [, amount, repo, num, title, ageN, ageUnit, claims] = m;
    const multiplier = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[ageUnit];
    results.push({
      amount: Number(amount.replace(/,/g, "")),
      repo,
      issue: Number(num),
      title: title.trim(),
      ageDays: Math.round(Number(ageN) * multiplier),
      claims: claims ? Number(claims) : 0,
    });
  }
  return results;
}

async function sweepAlgora() {
  const found = [];
  for (const org of ALGORA_ORGS) {
    const url = `https://algora.io/${org}/bounties?status=open`;
    try {
      const res = await fetchWithTimeout(url, ALGORA_TIMEOUT_MS);
      if (!res.ok) continue;
      const html = await res.text();
      // The listings live in the server-rendered text inside the HTML.
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&lbrace;/g, "{")
        .replace(/&rbrace;/g, "}")
        .replace(/&amp;/g, "&")
        .replace(/\n{2,}/g, "\n"); // collapse blank lines so entries are contiguous
      for (const entry of parseAlgoraText(text)) {
        found.push({
          source: "algora",
          org,
          repo: entry.repo,
          issue: entry.issue,
          title: entry.title,
          url: `https://github.com/${org}/${entry.repo}/issues/${entry.issue}`,
          amountUsd: entry.amount,
          ageDays: entry.ageDays,
          claimCount: entry.claims,
          escrow: "algora-escrow",
        });
      }
    } catch {
      // org page down / renamed — skip quietly
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Source 1b: Algora jobs pages (full-time & contract OSS roles)
// ---------------------------------------------------------------------------

/**
 * Jobs pages are server-rendered. Job blocks render as separate lines:
 *   "TypeScript Engineer" ... "Remote" "-" ... "We're seeking ..."
 * So: a line that is exactly "Remote" marks a job; the nearest non-empty line
 * above it is the title; the first long line below is the description.
 */
export function parseAlgoraJobs(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const jobs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "Remote") continue;
    // title: nearest plausible title line above (skip blanks/"-"/badge noise)
    let title = "";
    for (let j = i - 1; j >= 0 && j >= i - 16; j--) {
      const l = lines[j];
      if (l && l !== "-" && !/^Remote/.test(l) && !/^(Engineering|Jobs|We.re hiring)/i.test(l)) { title = l; break; }
    }
    if (!title || title.length < 4 || title.length > 90 || /^\$/.test(title)) continue;
    // description: first line > 60 chars within the next ~10 lines
    let desc = "";
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      if (lines[j].length > 60) { desc = lines[j]; break; }
    }
    jobs.push({ title, desc: desc.slice(0, 220) });
  }
  // dedupe by title
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.title) ? false : (seen.add(j.title), true)));
}

async function sweepAlgoraJobs() {
  const found = [];
  for (const org of ALGORA_JOBS_ORGS) {
    const url = `https://algora.io/${org}/jobs`;
    try {
      const res = await fetchWithTimeout(url, ALGORA_TIMEOUT_MS);
      if (!res.ok) continue;
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
      for (const job of parseAlgoraJobs(text)) {
        found.push({
          source: "algora-jobs",
          org,
          repo: null,
          issue: null,
          title: job.title,
          desc: job.desc,
          url,
          amountUsd: null,
          ageDays: null,
          claimCount: null,
          escrow: "direct employment/contract — negotiate directly",
          noIssue: true,
        });
      }
    } catch {
      // org has no jobs page or is down — skip
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Source 1c: Algora challenges (large-prize competitions)
// ---------------------------------------------------------------------------

async function sweepAlgoraChallenges() {
  const found = [];
  try {
    const res = await fetchWithTimeout("https://algora.io/challenges", ALGORA_TIMEOUT_MS);
    if (!res.ok) return found;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\n{2,}/g, "\n");
    // Active challenges render as "$15000\n<Challenge Title>\n..." — completed ones
    // render without a prize line. Pair any prize amount with the next title-ish line.
    const entryRe = /\$([\d,]{2,})\s*\n+\s*([^\n]{5,120})/g;
    let m;
    while ((m = entryRe.exec(text)) !== null) {
      const [, amount, title] = m;
      if (/^(open|completed|bounties)/i.test(title)) continue;
      found.push({
        source: "algora-challenge",
        org: "algora",
        repo: null,
        issue: null,
        title: title.trim(),
        url: "https://algora.io/challenges",
        amountUsd: Number(amount.replace(/,/g, "")),
        ageDays: null,
        claimCount: null,
        escrow: "algora challenge prize",
        noIssue: true,
      });
    }
  } catch {
    // challenges page down — skip
  }
  return found;
}

// ---------------------------------------------------------------------------
// Source 1d: Algora mentions — issues where @algora-io was summoned,
// often signaling a tip/bounty/contract discussion in an active repo.
// ---------------------------------------------------------------------------

async function sweepAlgoraMentions() {
  const found = [];
  const issues = await gh(
    [
      "search", "issues",
      "--mentions=algora-io",
      "--state=open",
      "--sort=updated",
      "--limit=20",
      "--json", "repository,title,number,url,updatedAt",
    ],
    GITHUB_TIMEOUT_MS,
  );
  if (!Array.isArray(issues)) return found;
  for (const it of issues) {
    const [owner, repo] = it.repository.nameWithOwner.split("/");
    if (isSpam(owner, repo, it.title)) continue;
    found.push({
      source: "algora-mention",
      org: owner,
      repo,
      issue: it.number,
      title: it.title,
      url: it.url,
      amountUsd: null,
      ageDays: Math.round(daysAgo(it.updatedAt)),
      claimCount: null,
      escrow: "unknown — Algora was mentioned; check thread for offer",
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Source 2: Opire rewards
// ---------------------------------------------------------------------------

/**
 * Opire rewards live on GitHub via their GitHub App (rewards are funded per-
 * issue; claims use /opire try). There is no "opirebot" user — so we search
 * for issues whose comments reference opire.dev or /opire commands, then pull
 * reward amounts from the issue title or the linking comments.
 *
 * NOTE (Sep 2026): app.opire.dev has been returning 502 for days. Rewards can
 * still be discovered on GitHub, but claims/payouts may be blocked while the
 * platform is down — always verify before investing time.
 */
async function sweepOpire() {
  const found = [];
  const issues = await gh(
    [
      "search", "issues",
      "opire.dev in:comments",
      "--state=open",
      "--sort=updated",
      "--limit=30",
      "--json", "repository,title,number,url,updatedAt",
    ],
    GITHUB_TIMEOUT_MS,
  );
  if (!Array.isArray(issues)) return found;

  for (const it of issues) {
    const [owner, repo] = it.repository.nameWithOwner.split("/");
    if (isSpam(owner, repo, it.title)) continue;
    // Reward amount is often in the title: "[BOUNTY] WearOS Support [$1340]"
    const amountUsd = titleAmountUsd(it.title);
    if (amountUsd == null) continue; // no visible amount → just a discussion, skip
    found.push({
      source: "opire",
      org: owner,
      repo,
      issue: it.number,
      title: it.title,
      url: it.url,
      amountUsd,
      ageDays: Math.round(daysAgo(it.updatedAt)),
      claimCount: null,
      escrow: "opire — verify platform is up (has been 502) & app installed on repo",
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Source 3: GitHub bounty labels (platform-agnostic, includes project-native)
// ---------------------------------------------------------------------------

async function sweepGithubLabels() {
  const found = [];
  for (const label of GITHUB_BOUNTY_LABELS) {
    const issues = await gh(
      [
        "search", "issues",
        `--label=${label}`,
        "--state=open",
        "--sort=created",
        "--limit=25",
        "--json", "repository,title,number,url,createdAt",
      ],
      GITHUB_TIMEOUT_MS,
    );
    if (!Array.isArray(issues)) continue;
    for (const it of issues) {
      const [owner, repo] = it.repository.nameWithOwner.split("/");
      if (isSpam(owner, repo, it.title)) continue;
      // Bait filter: mass-produced fake bounties use a "[Bounty: $X]" title
      // template. Legitimate project-native bounties state amounts in labels,
      // comments or linked platforms, not in a copy-pasted title prefix.
      if (isBaitTitle(it.title)) continue;
      // Amount sometimes stated in the title, e.g. "fix X ($100)".
      const amountUsd = titleAmountUsd(it.title);
      found.push({
        source: "github-label",
        org: owner,
        repo,
        issue: it.number,
        title: it.title,
        url: it.url,
        amountUsd,
        ageDays: Math.round(daysAgo(it.createdAt)),
        claimCount: null,
        escrow: "unknown — verify escrow before investing time",
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Verification: is the repo alive? Are there competing open PRs?
// ---------------------------------------------------------------------------

async function verifyCandidates(candidates) {
  const verified = [];
  const seen = new Set();

  for (const c of candidates) {
    // Jobs/challenges have no issue number — dedupe on org + title instead.
    const key = c.issue != null ? `${c.org}/${c.repo}#${c.issue}` : `${c.org}/${c.source}:${c.title}`;
    if (seen.has(key)) {
      // merge duplicates, keeping the highest amount seen
      const existing = verified.find((v) => (v.issue != null ? `${v.org}/${v.repo}#${v.issue}` : `${v.org}/${v.source}:${v.title}`) === key);
      if (existing && c.amountUsd && (!existing.amountUsd || c.amountUsd > existing.amountUsd)) {
        existing.amountUsd = c.amountUsd;
      }
      continue;
    }
    seen.add(key);

    // Jobs & challenges have no GitHub issue to verify — pass through.
    if (c.noIssue) { verified.push({ ...c, repoPushedDaysAgo: null }); continue; }

    // 1. Repo must exist, not be a fork, and be recently pushed.
    const repoInfo = await gh(["api", `repos/${c.org}/${c.repo}`, "--jq",
      "{pushed_at: .pushed_at, archived: .archived, fork: .fork}"]);
    if (!repoInfo || repoInfo.archived) continue; // repo gone or archived → unpayable
    if (repoInfo.fork && c.source === "github-label") continue; // bounty on a fork is unverifiable
    const repoAgeDays = Math.round(daysAgo(repoInfo.pushed_at));
    if (repoAgeDays > REPO_ACTIVE_DAYS) continue; // dormant repo → likely dead bounty

    // 2. Issue must still be open (search index can lag).
    const issueInfo = await gh(["api", `repos/${c.org}/${c.repo}/issues/${c.issue}`, "--jq",
      "{state: .state, comments: .comments}"]);
    if (!issueInfo || issueInfo.state !== "open") continue;

    // 3. Detect competing open PRs referencing this issue.
    const linkedPrs = await gh(
      ["pr", "list", "--repo", `${c.org}/${c.repo}`, "--state", "open",
       "--search", `${c.issue} in:body`, "--json", "number"],
      GITHUB_TIMEOUT_MS,
    );
    const openCompetingPrs = Array.isArray(linkedPrs) ? linkedPrs.length : null;

    verified.push({ ...c, repoPushedDaysAgo: repoAgeDays, openCompetingPrs });
  }
  return verified;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Higher = better opportunity. Deterministic, explainable. */
export function scoreBounty(b) {
  // Jobs & challenges are higher-income signals — score them on their own scale.
  if (b.source === "algora-jobs") return 7;
  if (b.source === "algora-challenge") {
    return (b.amountUsd ?? 0) >= 5000 ? 9 : 8;
  }
  let score = 0;
  const amt = b.amountUsd ?? 0;
  if (amt >= 1000) score += 4;
  else if (amt >= 250) score += 3;
  else if (amt >= 100) score += 2;
  else if (amt >= 30) score += 1;
  // freshness: younger is better
  // (null <= 3 is true in JS, so unknown ages must be excluded explicitly)
  if (b.ageDays != null) {
    if (b.ageDays <= 3) score += 3;
    else if (b.ageDays <= 14) score += 2;
    else if (b.ageDays <= 60) score += 1;
  }
  // low competition
  if (b.claimCount === 0) score += 2;
  else if (b.claimCount != null && b.claimCount <= 2) score += 1;
  if (b.openCompetingPrs === 0) score += 2;
  // freshly-pushed repo is a plus
  if (b.repoPushedDaysAgo != null && b.repoPushedDaysAgo <= 7) score += 1;
  return score;
}

// ---------------------------------------------------------------------------
// Digest rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(bounties) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    `# 🎯 Bounty Radar Digest — ${now}`,
    "",
    bounties.length === 0
      ? "No live, payable bounties found this sweep. The market is dry — check again tomorrow."
      : `${bounties.length} verified-live bounty candidate(s), ranked by opportunity score:`,
    "",
  ];

  for (const b of bounties) {
    const id = b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.org} — ${b.title}`;
    lines.push(
      `## ${b.amountUsd ? `$${b.amountUsd.toLocaleString()}` : "$?"} — ${id}`,
      `- **Title:** ${b.title}`,
    );
    if (b.desc) lines.push(`- **About:** ${b.desc}`);
    lines.push(`- **Link:** ${b.url}`);
    lines.push(`- **Source / escrow:** ${b.source} (${b.escrow})`);
    if (b.issue != null) {
      lines.push(`- **Age:** ${b.ageDays}d | **Claims:** ${b.claimCount ?? "?"} | **Open competing PRs:** ${b.openCompetingPrs ?? "?"}`);
    }
    if (b.repoPushedDaysAgo != null) lines.push(`- **Repo activity:** last push ${b.repoPushedDaysAgo}d ago`);
    lines.push(`- **Score:** ${b.score}/15`, "");
  }

  lines.push(
    "---",
    "_Verification rules: repo pushed within 60d, issue still open, spam repos filtered. Jobs/challenges pass through unverified (no GitHub issue). _",
    "_Rule of thumb: jobs & challenges = highest $/hour. For bounties, only invest time when escrow is verified and openCompetingPrs is low._",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Stable id, matching worker/mcp-server convention. */
export const listingKey = (b) => (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`);

/**
 * Merge this sweep's listings into the seen-map (state/listings-seen.json,
 * committed back by CI). Gives every listing first_seen/last_seen so /v1/diff
 * can eventually report per-listing changes and removals.
 * ponytail: file grows ~50 entries/day; prune entries unseen >90d if it ever matters.
 */
function annotateFirstSeen(ranked) {
  const SEEN_PATH = "state/listings-seen.json";
  let seen = {};
  try { seen = JSON.parse(readFileSync(SEEN_PATH, "utf8")); } catch { /* first run */ }
  const now = new Date().toISOString();
  for (const b of ranked) {
    const k = listingKey(b);
    if (!seen[k]) seen[k] = { first_seen: now };
    seen[k].last_seen = now;
    b.first_seen = seen[k].first_seen;
    b.last_seen = now;
  }
  mkdirSync(dirname(SEEN_PATH), { recursive: true });
  writeFileSync(SEEN_PATH, JSON.stringify(seen));
}

async function main() {
  if (FLAG_JSON) console.error("Sweeping sources…");

  const [algora, algoraJobs, algoraChallenges, algoraMentions, opire, ghLabels] = await Promise.all([
    sweepAlgora(),
    sweepAlgoraJobs(),
    sweepAlgoraChallenges(),
    sweepAlgoraMentions(),
    sweepOpire(),
    sweepGithubLabels(),
  ]);

  if (FLAG_JSON) {
    console.error(
      `algora: ${algora.length}, algora-jobs: ${algoraJobs.length}, challenges: ${algoraChallenges.length}, ` +
      `algora-mentions: ${algoraMentions.length}, opire: ${opire.length}, github-labels: ${ghLabels.length}`,
    );
  }

  const all = filterByMaxAge(
    [...algoraJobs, ...algoraChallenges, ...algoraMentions, ...algora, ...opire, ...ghLabels],
    FLAG_MAX_AGE,
  );

  const verified = await verifyCandidates(all);
  const ranked = rankBounties(verified);

  annotateFirstSeen(ranked);

  const markdown = renderMarkdown(ranked);

  if (FLAG_OUT) {
    writeFileSync(FLAG_OUT, markdown, "utf8");
    console.error(`Digest written to ${FLAG_OUT}`);
  }

  if (FLAG_JSON) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bounties: ranked }, null, 2));
  } else {
    console.log(markdown);
  }
}

// Run only when executed directly, so tests can import the pure helpers above.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (parseArgs(process.argv.slice(2)).help) {
    console.log(USAGE);
  } else {
    main().catch((err) => {
      console.error("radar failed:", err);
      process.exit(1);
    });
  }
}
