# Commission files

Private reference files for commission briefs (Increment 7, Stage A). Bytes live in two private buckets; Postgres holds the record and scan evidence.

Production bucket provisioning, scanner rollout, uploads/downloads enablement, and retention enforcement require explicit owner approval. This runbook does not authorize these actions. Production defaults remain literal `disabled` and `report_only`.

## Switches
- `COMMISSION_FILES_MODE` (web, worker): `disabled` stops new uploads and downloads. Scans and maintenance for existing files keep running.
- `COMMISSION_FILE_RETENTION_MODE`: `report_only` counts files past retention; `enforce` deletes them and requires `COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE` (owner approval).

## Buckets and credentials (owner setup before any enablement)
1. Create two private OCI buckets, for example `pawket-commission-quarantine` and `pawket-commission-clean`, with versioning enabled and no public access.
2. Configure quarantine-only lifecycle: expire current objects after 2 days and noncurrent versions after 1 day. This clears orphan versions from re-PUTs after the 15-minute upload grant expires. Record owner acceptance and verify both lifecycle rules before enablement. Do not apply this lifecycle to clean or automatically change clean retention.
3. Create two Customer Secret Keys on two separate users or groups:
   - Web: object write to quarantine only, object read to clean only. No list, delete or read on quarantine.
   - Worker: read, list versions and delete on quarantine; write, read, list versions and delete on clean.
4. CORS on the quarantine bucket: allow `PUT` from the exact `APP_BASE_URL` origin with headers `content-type` and `content-length`. No CORS on clean.
5. Set the `COMMISSION_FILES_*` variables in Coolify. Web gets the web key, worker gets the worker key.
6. Prove each permission. With the web key, a `HEAD` on quarantine must fail and a presigned `GET` on clean must work. Record the result in `docs/audits/`.

## Scanner
- `clamd` runs in the `clamd` service, internal network only. Signatures update automatically.
- Signatures older than 24 hours count as unavailable, so files wait instead of passing.
- The scanner is not part of worker readiness. If it is down, uploads wait. Deploys and the site keep working.

## Alerts
- **PawketCommissionFileScannerDown / SignaturesStale:** `docker logs <clamd>`; check memory (signature reload needs about 2–3 GB) and outbound access to the ClamAV mirror. Restarting `clamd` is safe.
- **PawketCommissionFileScanBacklog:** check the alerts above first. Files keep retrying for 24 hours and then become `scan_failed`; the buyer is asked to upload again.
- **PawketCommissionFileMaintenanceUnhealthy:** check worker logs for `commission_files_maintenance_failed` and database health.

## Never
- Never copy a file from quarantine to clean by hand, and never mark a file `clean` in SQL.
- Never paste presigned URLs, filenames or object keys into tickets or chat.
