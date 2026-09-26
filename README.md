# Curator Speed

A browser-first performance intelligence tool for OceanLiners.net and CuratorOS.

## First milestone

- Accept a page URL
- Fetch the page through the Worker
- Measure response time and transfer size
- Inspect HTML, images, scripts, stylesheets, fonts, cache headers, and redirects
- Generate prioritized, site-specific recommendations
- Export results as JSON for CuratorOS

## Intended deployment

Cloudflare Worker with static assets.

```bash
npm install
npm run check
npm run deploy
```

## CuratorOS export shape

The analyzer returns:

```json
{
  "type": "curator-performance-scan",
  "version": 1,
  "scannedAt": "2026-07-28T00:00:00.000Z",
  "page": {},
  "metrics": {},
  "resources": [],
  "findings": []
}
```

Findings are ranked as `high`, `medium`, or `low` and include a plain-language recommendation.

## Disaster recovery

The complete primary `CURATOR_SPEED_RECORDS` namespace can be exported through authenticated `GET /api/recovery-export`. Configure the Worker secret `RECOVERY_EXPORT_TOKEN`; the route remains disabled if the secret is absent. The shared `CURATOR_ERROR_RECORDS` namespace is intentionally excluded because its authoritative recovery export is owned by Error Bus. See [`RECOVERY_EXPORT.md`](RECOVERY_EXPORT.md).
