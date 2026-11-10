# Contributing

Thanks! This repo runs a public data pipeline; contributions should keep it boring, small, and dependency-free.

## Ground rules

- **Zero runtime npm dependencies.** Node stdlib only (`worker/` may use what its deploy needs). The root `devDependencies` are lint tooling and nothing else.
- **Node 20+.** No build step, no TypeScript, no transpile.
- Smallest working diff. No scaffolding "for later".
- **A bug fix comes with a test** under `test/` (`node:test`, offline: mock `fetch`, KV and the `gh` CLI rather than calling them).

## Good first contributions

- **New bounty sources** — add a `source:` block in `radar.mjs` following the existing pattern (fetch → normalize to `{title, url, org, repo, issue, amountUsd, escrow, source}` → the verifier/scorer handles the rest).
- **Verification heuristics** — spam filters, dead-repo signals, escrow detection. Each one should be a pure function with a comment naming its false-positive risk.
- **Agent tooling** — MCP tools, feed fields maintainers ask for.

## Before opening a PR

```bash
npm ci                              # once: installs ESLint (lint tooling only)
npm run lint
npm run check                       # node --check on every script
npm test                            # offline, no install needed
node radar.mjs --json | tail -5     # pipeline still runs (needs network + gh)
npm run preflight                   # GO verdict expected (checks production)
```

CI runs lint, the tests on Node 20 and 22, and a gitleaks secret scan on every pull request.

One PR per idea. Describe the *why* in one paragraph; the diff shows the how.

## Reporting bad data

Open an issue with the listing URL and what's wrong (dead repo? wrong amount? spam?). Screenshots of the source page help. Wrong data is the worst bug this project can have — reports get priority.
