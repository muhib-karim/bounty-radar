# Bounty Radar API — Product Plan (v1)

*Companion to the digest site. Written 2026-09-09, grounded in live market research from this repo's sweeps.*

---

## 1. Positioning

**One-liner:** the verified, machine-readable feed of payable open-source work — built for coding agents first, humans second.

**The insight:** agents (Claude Code, Freebuff, Cursor, custom loops) are becoming the primary bounty hunters. They don't browse HTML — they poll structured data and act on it. Every existing bounty source is either (a) platform-locked (Algora/Opire APIs serve their own listings only) or (b) unverified noise (raw GitHub label searches full of dead repos and spam farms — proven by this repo's research). **Nobody offers a cross-platform, verification-filtered feed designed for agent consumption.** That's the wedge.

**Why we can win:** the verification pipeline already exists and is battle-tested in this repo (repo-liveness, issue-state, fork, spam-farm filters). The moat is not the data (anyone can scrape it) — it's the **verification quality + freshness + distribution**. We move first on agent-native distribution (MCP server, skills) before the platforms themselves aggregate.

**Relationship to the digest site:**

| Surface | Role | Price |
|---|---|---|
| Digest site (Pages) | Marketing + top of funnel + SEO | Free forever |
| Static `bounties.json` | The free ad — agents discover us via it | Free forever |
| **API v1** | The product: filters, diff, webhooks, archive | Free tier → paid tiers |
| MCP server | Distribution into agent tools | Uses same API keys |

The site stays up no matter what — it is the portfolio piece, the trust signal, and the discovery surface. The API monetizes the *programmatic* users the site attracts.

---

## 2. Data model

Stable, flat, verification-first. This extends the existing `bounties.json` schema — backward compatible from day one.

```jsonc
{
  "id": "algora:tscircuit/tscircuit#1130",        // stable across sweeps
  "source": "algora",                              // algora | opire | github-label | algora-jobs | algora-challenge
  "type": "bounty",                                // bounty | job | challenge | discussion
  "title": "Change of color on hover for traces",
  "url": "https://github.com/.../issues/1130",
  "org": "tscircuit", "repo": "tscircuit", "issue": 1130,
  "amount_usd": 25,
  "score": 7,                                      // 0–12 opportunity score (unchanged)
  "escrow": "algora-escrow",                       // escrow | platform-down | unknown
  "age_days": 41,
  "first_seen": "2026-09-09T00:07:53Z",            // when OUR radar first saw it
  "last_seen": "2026-09-09T00:07:53Z",
  "verification": {                                // the differentiator — agents can trust or re-check
    "verified_at": "2026-09-09T00:07:53Z",
    "repo_pushed_days_ago": 1,
    "repo_archived": false,
    "repo_is_fork": false,
    "issue_state": "open",
    "open_competing_prs": 3,
    "claim_count": 19
  }
}
```

Envelope for all responses:

```jsonc
{ "data": [...], "meta": { "generated_at": "...", "sweep_id": "...", "next_cursor": "...", "rate_limit": {...} } }
```

---

## 3. Endpoints (v1)

| Method & path | What | Tier |
|---|---|---|
| `GET /v1/listings` | Core search. Query params: `source`, `type`, `min_amount`, `max_age_days`, `min_score`, `escrow_only=true`, `q`, `sort=score\|amount\|freshness`, `limit` (≤100), `cursor` | Free (rate-limited) |
| `GET /v1/listings/{id}` | One listing, full verification block | Free |
| `GET /v1/diff?since=<ISO or sweep_id>` | **Agent favorite:** only new/changed/closed listings since last poll. Cheap polling, no re-scan cost | Paid |
| `GET /v1/sources` | Source health: last successful sweep per source, platform status (e.g. Opire 502 detection) | Free |
| `GET /v1/stats` | Market pulse: open count, total $, median age, by-source breakdown. Also powers site homepage widgets | Free |
| `GET /v1/archive?from=&to=` | Historical snapshots — did this bounty ever get paid? how fast? | Paid |
| `POST /v1/subscriptions` | Webhook registration: POST on new listings matching a filter (the notify.mjs logic, multi-tenant) | Paid |
| `GET /v1/feed.rss` · `/v1/feed.json` | Backward-compat aliases of today's static files | Free |

**Agent ergonomics (non-negotiable):**
- `ETag` / `If-None-Match` on everything → free 304s for unchanged polls
- Stable `id`s; `closed` listings appear in `/diff` as `status: "closed"` (agents clean their queues)
- No auth for free tier (`?key=` optional for attribution); `Authorization: Bearer` for paid
- OpenAPI spec published at `/openapi.json` → instantly usable by any agent tooling
- Human-readable docs page generated from the spec

---

## 4. Pricing

Freemium, flat tiers (per-agent metering is fiddly — flat is cleaner to start; revisit at scale):

| Tier | Price | Limits & features | Target |
|---|---|---|---|
| **Free** | $0 | 100 req/day, current sweep only, no `/diff`, no webhooks | Discovery, hobby agents, the platforms themselves |
| **Agent** | **$15/mo** | 5,000 req/day, `/diff`, `min_score` & `escrow_only` filters, Discord/Telegram alerts, 7-day archive | Individual devs running personal agents |
| **Team** | **$79/mo** | 25k req/day, webhooks, 5 API keys, 90-day archive, request custom orgs/sources, 99% SLA | Agencies / fleets of agents |
| **Enterprise** | custom | Full archive + raw sweep dumps, custom sources, private verification profiles, data licensing | Platforms, funds, research |

**Anchors:** one won bounty pays for a year of Agent tier — pricing against *value of a single lead*, not bandwidth. Free tier stays generous enough that `bounties.json` users graduate naturally when they hit limits.

**Later revenue options (do not build yet):** platform referral fees (Algora/Opire affiliate), sponsored listings (orgs pay to badge-verify their own bounties), and a "verified bounty" seal orgs can embed.

---

## 5. Distribution plan (in order)

1. **Static feeds stay free & promoted** — `bounties.json` gets a `meta.upgrade` pointer; site footer links to API docs. Zero-cost funnel, already live.
2. **MCP server (`bounty-radar-mcp`)** — tools: `search_bounties`, `get_listing`, `whats_new(since)`. Publish to MCP registries; this is *the* channel to reach agents in 2026. Free tier works out of the box; key unlocks `/diff`.
3. **Agent skills / templates** — a Claude Code skill ("check bounty-radar for winnable work") and a GitHub Action snippet agents can import.
4. **Launch (when Stage 1 is live):** Show HN ("I built a verified bounty feed for coding agents — the market is full of dead and fake bounties"), r/opensource, Algora/Opire Discords (they *want* more hunters), the digest site's own data (our `/v1/stats` documenting the bounty drought is genuinely linkable content).
5. **SEO on the site** — every listing gets a canonical page (`/listing/algora:tscircuit/tscircuit-1130`) once API exists → long-tail search traffic ("tscircuit bounty").

---

## 6. Staged rollout (cheap-first)

| Stage | Build | Cost | Success signal |
|---|---|---|---|
| **0 — now** | Static `bounties.json` + RSS on Pages | $0 | Already live ✅ |
| **1 — API MVP** | Cloudflare Worker serving `/v1/listings`, `/v1/sources`, `/v1/stats` from sweep artifacts (Worker + KV; Pages-adjacent) | ~$0 (CF free tier) | 10 external consumers/week |
| **2 — Monetize** | API keys (Workers + D1), `/diff`, Stripe payment links, webhooks | ~$0 + Stripe fees | First 10 paying Agent-tier subs |
| **3 — Moat** | `/v1/archive`, listing pages + SEO, MCP server polish, stats widgets | ~$5/mo (domain) | 100 subs or a platform partnership |

**Deliberately deferred:** custom sweep scheduling per customer, ML scoring, non-GitHub forges (GitLab) — all Stage 4+ only if pull exists.

---

## 7. Risks & honest caveats

- **Thin inventory is the real risk.** Our own sweeps show the bounty market is currently dry (roughly a dozen verified listings, most stale). The API sells *leads*, and leads are scarce in a drought. Mitigation: `/v1/stats` turns the drought itself into content; expand sources (more orgs, GitLab, project-native programs) before scaling sales.
- **No data moat.** Anyone can copy the scraper. Defense = verification reputation, freshness, distribution head start in agent ecosystems, and being the *default* integration agents ship with.
- **ToS/porting:** all data comes from public GitHub API + public Algora pages — factual metadata republication is standard practice (cf. every existing aggregator). Keep per-source attribution in responses; respect upstream rate limits; add contact header.
- **Payment/payout confusion:** we sell *information*, never handle bounty money — keep that boundary loud in marketing (avoids "scam?" skepticism we ourselves researched).
- **Platform lock-in risk:** Algora could ship an official API and kill the aggregator angle. Mitigation: our value is cross-platform *verification*, not access — and we'd integrate their API as a source if they do.
