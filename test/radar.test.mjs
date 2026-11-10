import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  isSpam,
  isBaitTitle,
  titleAmountUsd,
  parseAlgoraText,
  parseAlgoraJobs,
  scoreBounty,
  rankBounties,
  filterByMaxAge,
  listingKey,
  renderMarkdown,
  MAX_SCORE,
  SOURCES,
  sweepSources,
  everySourceFailed,
  sweepIsUnpublishable,
} from "../radar.mjs";

describe("parseArgs", () => {
  test("defaults", () => {
    assert.deepEqual(parseArgs([]), { help: false, json: false, out: null, maxAge: null });
  });
  test("reads --json, --out and --max-age", () => {
    assert.deepEqual(parseArgs(["--json", "--out", "d.md", "--max-age", "14"]), {
      help: false, json: true, out: "d.md", maxAge: 14,
    });
  });
  test("ignores non-positive or non-numeric --max-age", () => {
    assert.equal(parseArgs(["--max-age", "0"]).maxAge, null);
    assert.equal(parseArgs(["--max-age", "abc"]).maxAge, null);
    assert.equal(parseArgs(["--max-age"]).maxAge, null);
  });
  test("recognises -h and --help", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });
});

describe("spam and bait filters", () => {
  test("flags known spam repos/orgs", () => {
    assert.equal(isSpam("bounty-plaza", "x", "anything"), true);
    assert.equal(isSpam("someone", "oss-hunter", "anything"), true);
    assert.equal(isSpam("x", "y", "join our bug_bounty program"), true);
  });
  test("allows the bug-bounty-platforms exception and normal repos", () => {
    assert.equal(isSpam("x", "bug-bounty-platforms", "list"), false);
    assert.equal(isSpam("acme", "widgets", "Add CSV export"), false);
  });
  test("bait title prefix", () => {
    assert.equal(isBaitTitle("[Bounty: $500] Fix it"), true);
    assert.equal(isBaitTitle("  [ bounty ] do thing"), true);
    assert.equal(isBaitTitle("Fix parser ($100)"), false);
    assert.equal(isBaitTitle("Bounty program docs"), false);
  });
  test("titleAmountUsd extracts the first dollar amount", () => {
    assert.equal(titleAmountUsd("[BOUNTY] WearOS Support [$1,340]"), 1340);
    assert.equal(titleAmountUsd("fix X ($100) or $200"), 100);
    assert.equal(titleAmountUsd("no money here"), null);
  });
});

describe("parseAlgoraText", () => {
  test("parses amount, repo, issue, title, age and claims", () => {
    const text = [
      "$500", "widgets#373", "feature: do the thing", "25 months ago", "2 claims",
      "$1,200", "core#9", "fix: crash on start", "3 days ago",
    ].join("\n");
    assert.deepEqual(parseAlgoraText(text), [
      { amount: 500, repo: "widgets", issue: 373, title: "feature: do the thing", ageDays: 750, claims: 2 },
      { amount: 1200, repo: "core", issue: 9, title: "fix: crash on start", ageDays: 3, claims: 0 },
    ]);
  });
  test("returns [] for text with no listings", () => {
    assert.deepEqual(parseAlgoraText("nothing to see\nhere"), []);
  });
});

describe("parseAlgoraJobs", () => {
  test("finds title above 'Remote' and long description below, deduped", () => {
    const desc = "We're seeking an engineer to build and maintain our open-source developer tooling.";
    const text = ["Jobs", "TypeScript Engineer", "Remote", "-", desc,
      "TypeScript Engineer", "Remote", desc].join("\n");
    assert.deepEqual(parseAlgoraJobs(text), [{ title: "TypeScript Engineer", desc }]);
  });
  test("skips implausible titles such as prices", () => {
    assert.deepEqual(parseAlgoraJobs("$5000\nRemote"), []);
  });
});

describe("scoreBounty", () => {
  test("jobs and challenges use a fixed scale", () => {
    assert.equal(scoreBounty({ source: "algora-jobs" }), 7);
    assert.equal(scoreBounty({ source: "algora-challenge", amountUsd: 15000 }), 9);
    assert.equal(scoreBounty({ source: "algora-challenge", amountUsd: 1000 }), 8);
    assert.equal(scoreBounty({ source: "algora-challenge" }), 8);
  });
  test("best-case bounty reaches the maximum of 12", () => {
    const b = { source: "algora", amountUsd: 1000, ageDays: 1, claimCount: 0, openCompetingPrs: 0, repoPushedDaysAgo: 2 };
    assert.equal(scoreBounty(b), 12);
  });
  test("amount tiers", () => {
    const base = { source: "github-label", ageDays: 999 };
    assert.deepEqual([0, 30, 100, 250, 1000].map((amountUsd) => scoreBounty({ ...base, amountUsd })), [0, 1, 2, 3, 4]);
  });
  test("freshness and competition tiers", () => {
    const base = { source: "opire", amountUsd: 0 };
    assert.equal(scoreBounty({ ...base, ageDays: 14 }), 2);
    assert.equal(scoreBounty({ ...base, ageDays: 60 }), 1);
    assert.equal(scoreBounty({ ...base, ageDays: 61, claimCount: 2 }), 1);
    assert.equal(scoreBounty({ ...base, ageDays: 61, claimCount: 3 }), 0);
  });
  test("unknown age / repo activity earns no points", () => {
    assert.equal(scoreBounty({ source: "github-label", ageDays: null, repoPushedDaysAgo: null }), 0);
  });
});

describe("rankBounties / filterByMaxAge / listingKey", () => {
  test("sorts by score then amount and attaches score", () => {
    const ranked = rankBounties([
      { source: "github-label", amountUsd: 50, ageDays: 100, title: "low" },
      { source: "algora-jobs", title: "job" },
      { source: "algora-challenge", amountUsd: 20000, title: "big" },
      { source: "algora-challenge", amountUsd: 6000, title: "medium" },
    ]);
    assert.deepEqual(ranked.map((b) => [b.title, b.score]), [["big", 9], ["medium", 9], ["job", 7], ["low", 1]]);
  });
  test("max-age filter keeps unknown ages", () => {
    const items = [{ ageDays: 1 }, { ageDays: 30 }, { ageDays: null }];
    assert.deepEqual(filterByMaxAge(items, 14), [{ ageDays: 1 }, { ageDays: null }]);
    assert.equal(filterByMaxAge(items, null).length, 3);
  });
  test("stable ids for issues and issue-less listings", () => {
    assert.equal(listingKey({ org: "acme", repo: "w", issue: 4 }), "acme/w#4");
    assert.equal(listingKey({ source: "algora-jobs", org: "acme", issue: null, title: "Eng" }), "algora-jobs:acme:Eng");
  });
});

describe("renderMarkdown", () => {
  test("empty digest says so", () => {
    assert.match(renderMarkdown([]), /No live, payable bounties found/);
  });
  test("renders amount, id, link and score", () => {
    const md = renderMarkdown([{
      source: "algora", org: "acme", repo: "w", issue: 4, title: "T", url: "https://x/4",
      amountUsd: 1500, ageDays: 2, claimCount: 0, openCompetingPrs: 1, repoPushedDaysAgo: 3, escrow: "algora-escrow", score: 10,
    }]);
    assert.match(md, /1 verified-live bounty candidate/);
    assert.match(md, /## \$1,500 — acme\/w#4/);
    assert.match(md, /- \*\*Link:\*\* https:\/\/x\/4/);
    assert.match(md, /- \*\*Score:\*\* 10\/12$/m);
  });
});

describe("score scale", () => {
  test("MAX_SCORE is the highest score any listing can reach", () => {
    let max = -Infinity;
    for (const source of ["algora", "opire", "github-label", "algora-mention", "algora-jobs", "algora-challenge"]) {
      for (const amountUsd of [null, 0, 30, 100, 250, 1000, 5000, 1e7]) {
        for (const ageDays of [null, 0, 3, 4, 14, 60, 61]) {
          for (const claimCount of [null, 0, 1, 2, 3]) {
            for (const openCompetingPrs of [null, 0, 1]) {
              for (const repoPushedDaysAgo of [null, 0, 7, 8]) {
                max = Math.max(max, scoreBounty({ source, amountUsd, ageDays, claimCount, openCompetingPrs, repoPushedDaysAgo }));
              }
            }
          }
        }
      }
    }
    assert.equal(max, 12);
    assert.equal(MAX_SCORE, max);
  });
});

describe("sweepSources", () => {
  const offline = async () => { throw new Error("getaddrinfo ENOTFOUND algora.io"); };
  const ghBroken = async () => null; // what gh() resolves to when the CLI is missing or unauthenticated
  const emptyPage = async () => new Response("<html><body>nothing here</body></html>");
  const ghEmpty = async () => [];

  test("every source is reported, in merge order", async () => {
    const results = await sweepSources({ fetch: emptyPage, gh: ghEmpty });
    assert.deepEqual(results.map((r) => r.name), SOURCES.map((s) => s.name));
    assert.deepEqual(results.map((r) => r.name),
      ["algora-jobs", "algora-challenges", "algora-mentions", "algora", "opire", "github-labels"]);
  });

  test("when nothing answers, every source is an error and the sweep counts as failed", async () => {
    const results = await sweepSources({ fetch: offline, gh: ghBroken });
    for (const r of results) {
      assert.equal(r.ok, false, r.name);
      assert.deepEqual(r.items, [], r.name);
      assert.ok(r.error, r.name);
    }
    assert.match(results.find((r) => r.name === "algora").error, /all 9 Algora org page requests failed .*ENOTFOUND/);
    assert.match(results.find((r) => r.name === "opire").error, /gh search failed/);
    assert.equal(everySourceFailed(results), true);
  });

  test("HTTP error statuses are failures, not empty results", async () => {
    const results = await sweepSources({ fetch: async () => new Response("down", { status: 503 }), gh: ghBroken });
    assert.equal(everySourceFailed(results), true);
    assert.match(results.find((r) => r.name === "algora-challenges").error, /HTTP 503/);
  });

  test("a source that answers with no listings is a success", async () => {
    const results = await sweepSources({ fetch: emptyPage, gh: ghEmpty });
    assert.equal(results.every((r) => r.ok && r.items.length === 0 && r.error === null), true);
    assert.equal(everySourceFailed(results), false);
  });

  test("some sources failing is not a failed sweep", async () => {
    const results = await sweepSources({ fetch: emptyPage, gh: ghBroken });
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.name), ["algora-mentions", "opire", "github-labels"]);
    assert.equal(everySourceFailed(results), false);
    // one reachable org page is enough for a multi-request source
    const oneOrg = await sweepSources({
      fetch: async (url) => (url.includes("/cal/") ? new Response("ok") : new Response("no", { status: 404 })),
      gh: ghBroken,
    });
    assert.equal(oneOrg.find((r) => r.name === "algora").ok, true);
    assert.equal(oneOrg.find((r) => r.name === "algora-challenges").ok, false);
  });

  test("listings from stubbed sources come through normalized", async () => {
    const page = "<p>$500</p><p>widgets#3</p><p>Fix the thing</p><p>2 days ago</p><p>1 claim</p>";
    const issue = { repository: { nameWithOwner: "acme/app" }, title: "Paid help wanted", number: 7, url: "https://github.com/acme/app/issues/7", updatedAt: new Date().toISOString() };
    const results = await sweepSources({
      fetch: async (url) => new Response(url.endsWith("/cal/bounties?status=open") ? page : ""),
      gh: async (args) => (args.includes("--mentions=algora-io") ? [issue] : []),
    });
    const bySource = Object.fromEntries(results.map((r) => [r.name, r.items]));
    assert.deepEqual(bySource.algora.map((b) => [b.org, b.repo, b.issue, b.amountUsd, b.claimCount, b.url]),
      [["cal", "widgets", 3, 500, 1, "https://github.com/cal/widgets/issues/3"]]);
    assert.deepEqual(bySource["algora-mentions"].map((b) => [b.source, b.org, b.repo, b.issue]), [["algora-mention", "acme", "app", 7]]);
    assert.equal(everySourceFailed(results), false);
  });

  test("everySourceFailed needs at least one source", () => {
    assert.equal(everySourceFailed([]), false);
  });

  test("a sweep is unpublishable when all sources failed, or some failed and nothing was found", () => {
    const ok = { name: "a", ok: true, items: [], error: null };
    const bad = { name: "b", ok: false, items: [], error: "boom" };
    const listing = { title: "x" };
    assert.equal(sweepIsUnpublishable([bad, bad], []), true, "every source errored");
    assert.equal(sweepIsUnpublishable([ok, bad], []), true, "empty next to a failure looks like an outage");
    assert.equal(sweepIsUnpublishable([ok, bad], [listing]), false, "partial failure with results is published");
    assert.equal(sweepIsUnpublishable([ok, ok], []), false, "a clean sweep that finds nothing is a real answer");
    assert.equal(sweepIsUnpublishable([ok, ok], [listing]), false);
  });
});
