# Show HN Launch Kit — Bounty Radar

*You submit manually (your account; HN has no posting API, and Show HN etiquette favors the author). Everything below is paste-ready.*

**Best window:** Tue–Thu, 8–10am ET (weekday mornings = peak HN traffic).

---

## Step 1 — Submit

Go to https://news.ycombinator.com/submit

- **title** (paste exactly, 71 chars):

```
Show HN: Bounty Radar – a verified, agent-readable feed of OSS bounties
```

- **url**:

```
https://muhib-karim.github.io/bounty-radar/
```

(Submit as URL, not text — the site is the demo. Text posts bury the link.)

## Step 2 — Immediately post this as the first comment (yours, as the author)

```
Hi HN — I built Bounty Radar after spending a day hunting OSS bounties with
an AI agent and discovering that almost every "open bounty" out there is a
ghost. We hit: deleted repos with live bounty labels, programs that quietly
ended (one of the biggest bounty orgs told us "we don't do bounties
anymore"), and a flood of AI-generated "[Bounty: $850]" bait repos with zero
money behind them.

So the radar does three unglamorous things:

1. Sweeps 6 sources every 6h (Algora orgs, Opire via GitHub, bounty labels)
2. VERIFIES each listing: repo pushed ≤60d, not archived, not a fork, issue
   still open, known spam farms filtered
3. Publishes what survives as a browsable board + RSS + a plain JSON feed

The part I care about most: it's built agent-first. Coding agents are
becoming the primary bounty hunters, and they need structured feeds, not
HTML. So besides the board there's:

- JSON feed: https://muhib-karim.github.io/bounty-radar/bounties.json (or /v1/diff on the API for change-only polling)
- A queryable API (free, no key): https://bounty-radar-api.ai-dev-2024.workers.dev
  e.g. /v1/listings?escrow_only=1&sort=amount  ·  /v1/listings?type=job
  Agents poll /v1/diff?since=<last timestamp> and get structured
  added/changed/removed — a cheap poll, no re-scanning.
- And yes, this thread is instrumenting itself: GET /v1/launch returns this
  post's points/comments/stars over time plus our API traffic, as JSON.
  The board charts the same data live at the top of the page, and a CI job
  renders it into a shareable dashboard image (dashboard.svg). Watch the
  thread chart itself: https://muhib-karim.github.io/bounty-radar/
- An MCP server so Claude Code / Cursor etc. can ask natively:
  https://github.com/muhib-karim/bounty-radar#use-it-from-any-agent-mcp-server

To prove the loop, we dogfooded it: the agent picked a listing through the
MCP server, checked competition, fixed the bug, and opened a CI-green PR on
PHPOffice/PHPWord (7.6k stars): https://github.com/PHPOffice/PHPWord/pull/2937

Stack: ~600 lines of zero-dependency Node for the sweeper, GitHub Actions as
the cron, GitHub Pages for hosting, one small Cloudflare Worker for the API.
No database, no build step, nothing to pay for.

Honest caveat: the verified-bounty market is small but moving — today's
board has 28 listings ($1,394 tracked, largest $1,340), 20 of them under a
week old, 18 scoring 6+/10 as winnable. Proof it moves: when Opire came back
online this week, its $1,340 bounty was on the board within one sweep.
Verification data is best-effort (escrow flags come from the platforms;
claim/PR counts drift).

Ask: if you run an OSS repo with bounty labels, I'd love to hear what
metadata you'd want in the feed so agents can triage your issues better.

Repo: https://github.com/muhib-karim/bounty-radar
```

## Step 3 — Engagement notes (first 2 hours matter)

- **Reply fast, short, specific.** HN punishes marketing-speak; reward: "straight answer."
- **Likely question 1:** "How is this different from Algora's own listing page?" → *Algora only lists Algora; we cross-check repo liveness and filter dead/expired listings across platforms — which their pages don't (we found their org pages listing deleted repos).*
- **Likely question 2:** "Why not just a GitHub label search?" → *Raw searches are full of deleted repos and bait farms; that's the actual problem. Show them the research: 28 verified out of 105 raw hits on today's sweep.*
- **Likely question 3:** "Does the agent thing actually work?" → *Link the PHPWord PR; the pipeline picked, fixed, and submitted it end-to-end.*
- **Likely question 4:** "Why are you tracking your own thread?" → *It demos the whole thesis in one endpoint: agent-readable data about the launch itself (/v1/launch), the same samples rendered as the board's chart, and zero extra infrastructure — the monitor's committed state is the only source. Feel free to point out they can curl it live.*
- If someone from tscircuit/Algora shows up: be warm, no shade — their data powers the radar.
- **Don't** mention monetization plans unless asked directly ("Stage 2" pricing exists in the repo docs — fine to link if asked).

## Step 4 — Arm the thread monitor (10 seconds, right after submitting)

The `hn-monitor` workflow watches your thread every 10 minutes and pings Discord on every new comment (plus GitHub PR reviews in the same digest). It activates the moment you set one variable:

1. **Get the item id** — after submitting, your post's URL is `https://news.ycombinator.com/item?id=XXXXXXXX`. Copy that number.
2. **Add it** — go to https://github.com/muhib-karim/bounty-radar/settings/variables/actions → **New repository variable** → Name: `HN_ITEM_ID`, Value: the number → **Add variable**.
3. **Done** — the next 10-minute tick starts watching. (Optional smoke test: Repo → Actions → "hn-monitor" → Run workflow → check it went green and Discord got a "nothing new" or seed digest.)

That one variable arms everything at once: the 10-min comment monitor, the hourly launch digest (pts/comments/stars/API-reqs to Discord for ~36h), the board's momentum chart, the footer "Discuss on HN" link, and the `dashboard.svg` shareable image — each appears/starts on the next publish.

The PR-watching half of the digest is already live — no setup needed.

## Pre-flight checklist

**One command verifies everything below against production:**

```
npm run preflight
```

It checks all links, the API examples, PR #2937, the chart pipeline, the HN variable and secrets — and compares every number in the first comment to the live data. Exit 0 = GO. Re-run launch morning; counts drift.

Manual items it can't check:

- [ ] Site loads on mobile (HN traffic is ~half mobile)
- [ ] `bounties.json` fresh (cron at 00:00/06:00/12:00/18:00 UTC — check `meta.generated_at`)
- [ ] API 200s: `/v1/stats`, `/v1/listings?escrow_only=1`, `/v1/launch`
- [ ] PHPWord PR #2937 still open/clean — it's the proof link
- [ ] Discord webhook secret configured? (alert demo works when traffic finds a fresh listing)
- [ ] After setting `HN_ITEM_ID`: next sweep adds the momentum chart to the board + `hn-momentum.json` gets its first samples; the sweep after that publishes `dashboard.svg` (that's the "thread charting itself" link in your first comment — verify it before posting, or soften the line to "will chart within the hour"). Login-free share URLs appear on the `gh-artifacts` branch at the same time: `https://raw.githubusercontent.com/muhib-karim/bounty-radar/gh-artifacts/dashboard.png` (and `momentum.png`) — good for tweets/Discord embeds that can't fetch behind a GitHub login.
- [ ] **Launch morning, re-check every number in the first comment** (they drift): listing count + freshness split (`/v1/stats`), PHPWord star count, example result counts (`escrow_only=1&sort=amount`, `type=job`), PR #2937 state. Understating is safe; stating a stale exact number is what HN pounces on.
- [ ] This file (`docs/SHOW_HN.md`) **removed from the repo or kept?** — harmless either way; keeping it is fine and honest
