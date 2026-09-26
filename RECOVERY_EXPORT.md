# Curator Speed Recovery Export

Curator Speed provides a complete, read-only backup of the `CURATOR_SPEED_RECORDS` Cloudflare KV namespace at `GET /api/recovery-export`.

Configure the Worker secret `RECOVERY_EXPORT_TOKEN` and send it as `X-Curator-Recovery-Key`. If the secret is absent, the endpoint remains disabled.

The exporter paginates every key in `CURATOR_SPEED_RECORDS` and preserves exact key/value pairs. The shared `CURATOR_ERROR_RECORDS` binding is intentionally excluded because Error Bus owns that recovery boundary.

Use Shortcuts on iPad/iPhone with:
- URL: `https://speed.oceanliners.net/api/recovery-export`
- Method: GET
- Header: `X-Curator-Recovery-Key` = the configured recovery token
- Save File

Validate with:

```bash
node scripts/validate-recovery-backup.mjs /path/to/curator-speed-recovery-....json
```

There is intentionally no production restore endpoint.
