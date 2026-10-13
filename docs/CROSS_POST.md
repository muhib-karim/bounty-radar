# Cross-Post Kit — r/opensource & Algora Discord

*Same project, different rooms, different voices. Post these **after** the Show HN goes live (or instead of, if HN gets no traction — but never before, so every claim is already battle-tested). All numbers below were verified against production at writing; re-run `npm run preflight` before posting.*

**The one rule across all venues:** the story is the *verification evidence*, not the tool. We are not announcing "a scraper"; we are publishing findings — dead repos with live bounty labels, ended programs still listed, AI-generated bait farms — and the tool is the byproduct that keeps documenting them.

---

## 1. r/opensource — post as **Promotional** flair (required there)

r/opensource is friendly to makers but allergic to landing-page marketing. Lead with what you found, use first person, include at least one thing that isn't your project (the tscircuit/Algora findings qualify), and answer every comment — Reddit rewards sustained author presence for ~48h.

**Title** (paste exactly, no link in title):

```
I tried to find real open-source bounties with an AI agent — most "open bounties" were ghosts, so I built a verifier that publishes what survives
```

**Body:**

```markdown
Last week I went bounty hunting with a coding agent. The pitch of bounty work
is great: pick a labeled issue, fix it, get paid. The reality I found: a lot
of what looks like an open bounty is a ghost.

What the raw sweep turned up (105 raw "bounties" across Algora, Opire and
GitHub bounty labels in one pass):

- repos that no longer exist, still carrying live bounty labels
- a large bounty program that quietly ended — their org page kept listing
  bounties, and they confirmed they "don't do bounties anymore"
- a band of AI-generated "[Bounty: $850]" repos with zero money behind them
  (now blocklisted)

So I built a verifier that re-checks every candidate every 6 hours: repo
pushed ≤60 days, not archived, not a fork, issue still open, blocklist
applied. Today that reduces 105 raw hits to 28 verified listings — and what
survives is documented at https://muhib-karim.github.io/bounty-radar/
(the board shows the numbers, RSS + JSON if you want the feed).

The whole thing is ~600 lines of zero-dependency Node: GitHub Actions as the
cron, GitHub Pages for hosting, one small Cloudflare Worker for the queryable
API (filters, escrow flags, /v1/diff for cheap agent polling). MIT licensed,
no database, nothing to pay for.

Two things I'd genuinely like feedback on from this community:

1. If you maintain a repo with bounty labels: what metadata would make
   agents triage your issues *better* instead of spamming you? (claimed-by?
   ETA? required skill?) I'll add it to the feed spec.
2. Is an aggregator/verifier like this useful to you as a contributor, or is
   the bounty market too small to bother? Honest takes welcome — the data
   says it's small (28 verified listings, 20 under a week old) right now.

Repo (MIT): https://github.com/muhib-karim/bounty-radar
```

**Notes for this venue:**
- **Flair: "Promotional"** — it's the required flair for sharing your own project; unflaired promo posts get removed by AutoMod.
- Comment replies should be as substantive as the post — this sub reads threads.
- If asked "why not just use Algora's site?": *Algora only lists Algora, and the ghost listings are on their org pages — verification is the missing layer, not another list.*
- If asked about monetization: the API has paid tiers ($15/$79) but the board/feed/JSON are free and stay free. Say it plainly, once.

---

## 2. Algora Discord — **relationship post, not a launch post**

This is the most delicate venue: the radar reads Algora's public pages, so the message must lead with what the radar does **for Algora's ecosystem** — sending them real contributors — and own the "ghost listing" finding *about the ecosystem* without pointing fingers at Algora-the-company. Post it in a feedback/tools/community channel (not #general), ideally as a reply where bots/tools are discussed.

**Message (short enough for one Discord message):**

```
Hey — I've been working on an open tool that Algora folks here might find
useful: Bounty Radar, a verifier that re-checks bounties every 6h (repo
active? issue open? escrow-backed?) and publishes what survives as a clean
board + JSON feed that coding agents can read directly.

Motivation: while hunting bounties with an AI agent I kept hitting dead
repos and expired programs still carrying live bounty labels — across
platforms, not just Algora. The verifier filters those out, so agents and
contributors who use the feed only land on real, open, funded issues.

Algora-angle: of the 105 raw candidates in a recent sweep, Algora's 9 active
listings survived verification (3 escrowed bounties, 4 contract roles, 2
mentions) — and those are the ones our feed pushes to agents first. Real
contributors, fewer wasted claims on ghost bounties.

Board: https://muhib-karim.github.io/bounty-radar/
Repo (MIT, zero-dep): https://github.com/muhib-karim/bounty-radar

If the Algora team ever ships an official API, I'd happily make the radar a
client of it — the value here is the verification layer, and honest feedback
from this community (especially maintainers) on what metadata agents should
get would shape that spec.
```

**Notes for this venue:**
- **Discipline:** one message, no follow-up bumps, no screenshots of their own pages being called dead. If someone asks "which repos are dead?", answer in DMs or vaguely ("some org pages list repos that no longer exist") — public callouts in their house is how you get banned.
- **The official-API line is the real message** to staff reading: you're a potential client, not a competitor.
- If a maintainer asks "can you add our org?": yes, and do it fast — that's a warm lead.
- Do **not** mention the paid API tiers here.

---

## Sequencing & hygiene

1. **HN first** (Tue–Thu 8–10am ET), then Reddit ~2h later, Discord the next morning — lets each venue's reaction inform the next.
2. Re-run `npm run preflight` before each post; update counts in these drafts to current (`/v1/stats`).
3. Same author voice everywhere — use the same username that posts on HN.
4. Track links: append `?utm_source=reddit` / `?utm_source=algora-discord` when posting (GitHub Pages ignores them; they only help your own analytics via referrers in the Worker logs).
5. Never cross-paste the HN first comment verbatim — every venue above has its own angle. Same facts, different emphasis.
