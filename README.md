# Bounty Radar

Source tooling for collecting and filtering open-source bounties, jobs and challenges, with a static board, RSS/JSON outputs and an MCP interface.

## Demo status

The previously advertised GitHub Pages board returned a GitHub Pages 404 during the 11 October 2026 browser check. The API stats endpoint returned HTTP 502 during the same audit. Neither is presented here as a working demo. No replacement URL is advertised until a deployment is verified.

The stored screenshot below is historical, not proof of current availability or current listings.

![Historical board screenshot](docs/screenshot.png)

## Inspect the implementation

- `radar.mjs`: source collection, filtering and scoring.
- `build-site.mjs`: static HTML, RSS and JSON output.
- `mcp-server.mjs`: tools over stdio.
- `worker/src/index.js`: optional queryable API implementation.
- `.github/workflows/sweep-and-publish.yml`: scheduled collection and Pages deployment.

Filters reduce noise; they do not guarantee that a listing is payable, unclaimed or available today. Recheck the original listing before acting. No current bounty totals, traffic or earnings metrics are claimed here.

## Run locally

Use Node 20 or newer and an authenticated `gh` command where the script requires GitHub access.

```bash
node radar.mjs
node radar.mjs --json
node notify.mjs feed.json --dry-run
node mcp-server.mjs
```

Use dry-run output before configuring notifications. Do not publish webhook URLs, API tokens or keys. Provider credentials and alert channels require separate setup. See the source scripts for the required environment and inputs.

## Deployment and operating limits

The static pipeline uses GitHub Actions and Pages; the optional API is separate. Existing source configuration does not establish that either deployment is healthy. Hosting allowances and provider limits may change. This README makes no free-forever or no-hosting-bill guarantee.

The workflow includes alert and follow-up dispatch steps. Review those side effects before a manual production run. Alerts, launch integrations and optional billing need their own configuration and review.

## License

See [LICENSE](LICENSE). Source data and linked opportunities retain their own terms.
