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
- Informational VERSION probes have a separate 5-second timeout and are cancelled on worker stop; unknown signature age exports as `-1`.

## Cleanup guarantees and costs
- Each copy registers irreversible `clean_copy_intent` under the current scan claim before contacting storage. Terminal records with this intent remain eligible for clean-bucket reconciliation indefinitely, and never receive a final `clean_purged_at` stamp. A timed-out or crashed request can still finish at the provider arbitrarily later. Repeated all-version deletion catches those writes; live clean and attached winners are excluded.
- This deliberately costs recurring bounded list/delete calls for every terminal file that ever started a copy. The worker walks candidates by immutable creation time and ID, carrying a purge cursor between sweeps and wrapping at the end. Failed objects stay retryable without blocking later files. A worker restart restarts the cursor; persistent restarts can delay a full pass.
- Storage operations abort after at most 60 seconds including retries/pagination, with a 5-second connection timeout and a rejecting 30-second request timeout. The scan owns opened-body destruction and its scan deadline. A sweep can take multiple bounded operations per row; watch maintenance health and `purge_failed` counts, investigate provider access/retention failures, and let later cursor passes retry.
- Migration 0038 conservatively marks existing uploaded rows as possible copy writers and clears their old clean purge stamps. It also erases filenames of existing ended unattached records. Database transitions automatically erase these names on rejection, scan failure, expiry or discard and prohibit restoration. Active clean draft names remain until their 24-hour TTL; attached and retention-deleted order names retain the order metadata policy.

## Alerts
- **PawketCommissionFileScannerDown / SignaturesStale:** `docker logs <clamd>`; check memory (signature reload needs about 2–3 GB) and outbound access to the ClamAV mirror. Restarting `clamd` is safe.
- **PawketCommissionFileScanBacklog:** check the alerts above first. Files keep retrying for 24 hours and then become `scan_failed`; the buyer is asked to upload again.
- **PawketCommissionFileMaintenanceUnhealthy:** check worker logs for `commission_files_maintenance_failed` and database health.

## Never
- Never copy a file from quarantine to clean by hand, and never mark a file `clean` in SQL.
- Never paste presigned URLs, filenames or object keys into tickets or chat.
