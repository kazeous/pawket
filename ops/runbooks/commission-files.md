# Commission files

Private files for commission briefs (Increment 7, Stage A), thread messages and creator submissions (Stage B). Bytes live in two private buckets; Postgres holds the record and scan evidence.

Production bucket provisioning, scanner rollout, uploads/downloads enablement, and retention enforcement require explicit owner approval. This runbook does not authorize these actions. Production defaults remain literal `disabled` and `report_only`.

## Switches

- `COMMISSION_FILES_MODE` (web, worker): `disabled` stops new uploads and downloads. Scans and maintenance for existing files keep running.
- `COMMISSION_FULFILLMENT_MODE` (web, worker): `disabled` stops new thread/submission upload grants and fulfilment commands; private history remains readable. `enabled` requires `COMMISSION_FILES_MODE=enabled`. Pause observation continues; see [Commission operations](commission-operations.md#fulfilment-pause-and-resume).
- `COMMISSION_FILE_RETENTION_MODE`: `report_only` counts files past retention; `enforce` deletes them and requires `COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE` (owner approval).

## Contexts and limits

| Context | Use and access | Detected types | Maximum per file | Maximum attached files |
| --- | --- | --- | --- | --- |
| `brief` | Buyer references, bound to the package before intake and attached when the order is created | JPEG, PNG, WebP, GIF, PDF | 25 MiB (26,214,400 bytes) | 10 per brief |
| `thread` | Buyer or creator message attachments, bound to the order and message author | JPEG, PNG, WebP, GIF, PDF | 25 MiB (26,214,400 bytes) | 10 per message |
| `submission` | Creator draft/final files, bound to the order and creator | JPEG, PNG, WebP, GIF, PDF, PSD/PSB, CLIP, ZIP | 250 MiB (262,144,000 bytes) | 20 per submission |

Thread grants require an `in_progress` or `delivered` order. Submission grants
and commands require the creator and an `in_progress` order. Attaching files
requires clean scan results and the matching context, order and owner. A
`completed` order accepts no new files or messages. Types are
detected from bytes; client extensions and MIME claims are not trusted. Only
JPEG/PNG/WebP/GIF up to 25 MiB can preview inline; PDF, PSD/PSB, CLIP and ZIP are
download-only, as are larger submission images. Private access is limited to
the parties; the owner role has no file access.

## Order quota

Each order has a combined 1 GiB (1,073,741,824 bytes) quota across brief, thread
and submission contexts. Accounting uses `declared_bytes` for files bound by
`order_id` or `upload_order_id`: awaiting-upload, scanning, clean and attached
files count. A rejected, scan-failed, expired, discarded or deleted row stops
counting only after both `quarantine_purged_at` and `clean_purged_at` are set by
successful all-version cleanup. Changing state alone does not free space.

Migration 0044 makes fully purged terminal rows leave the quota even when their
irreversible `clean_copy_intent` stays true. Until closure and both purge stamps,
these rows still count. New thread/submission grants are serialized by an
order advisory lock and checked against `commission_order_file_bytes()` in the
database; `order_quota_exceeded` returns 409. Inspect maintenance health and
allow cleanup to finish; never clear intent, purge stamps or rows by hand to
recover quota.

## Buckets and credentials (owner setup before any enablement)

1. Create two private OCI buckets, for example `pawket-commission-quarantine` and `pawket-commission-clean`, with versioning enabled and no public access.
2. Configure quarantine-only lifecycle: expire current objects after 2 days and noncurrent versions after 1 day. This clears orphan versions from re-PUTs after the 15-minute upload grant expires. Record owner acceptance and verify both lifecycle rules before enablement. Do not apply this lifecycle to clean or automatically change clean retention.
3. Create two Customer Secret Keys on two separate users or groups:
   - Web: object write to quarantine only, object read to clean only. No list, delete or read on quarantine.
   - Worker: read, list versions and delete on quarantine; write, read, list versions and delete on clean.
4. CORS on the quarantine bucket: allow `PUT` from the exact `APP_BASE_URL` origin with headers `content-type` and `content-length`. No CORS on clean.
5. Set the `COMMISSION_FILES_*` variables in Coolify. Web gets the web key, worker gets the worker key.
6. Prove each permission. With the web key, a `HEAD` on quarantine must fail and a presigned `GET` on clean must work. Record the result in `docs/audits/`.

## Stage B enablement check

After the private-bucket, permissions, CORS and fresh-scanner prerequisites are
accepted, fulfilment requires, in order: files mode enabled, the OCI single-PUT
check at 250 MiB passing, and the owner's copy sign-off on the actual screens.
Only then may separately authorized fulfilment enablement proceed on web and
worker. Keep `COMMISSION_FILE_RETENTION_MODE=report_only`.

The OCI check must upload exactly 262,144,000 bytes of synthetic allowed content
from a normal home connection in an owner-authorized environment. Verify the
browser's presigned single PUT with the configured CORS, then verify stored byte
count and SHA-256 with an authorized read. This is a storage compatibility check:
application submission grants remain unavailable while fulfilment is disabled.
The separate storage proofs must also cover clean-bucket copy, GET response
overrides and all-version deletion; the scanner must have fresh signatures.
Record redacted pass/fail evidence without filenames, object keys or presigned
URLs. Local tests do not establish OCI reliability. If the single PUT fails or
is unreliable, leave fulfilment disabled and return the deferred multipart
decision to the owner; do not invent an upload workaround. Synthetic production
uploads require separate owner authorization.

Use the worker-first sequence and forward-only rollback rules in
[Commission operations](commission-operations.md#rollback). Once a `delivered`
or `completed` row exists, an older revision that cannot process Stage B is
unsafe even with the switches off.

## Scanner

- `clamd` runs in the `clamd` service, internal network only. Signatures update automatically.
- Signatures older than 24 hours count as unavailable, so files wait instead of passing.
- The scanner is not part of worker readiness. If it is down, uploads wait. Deploys and the site keep working.
- Informational VERSION probes have a separate 5-second timeout and are cancelled on worker stop; unknown signature age exports as `-1`.

## Cleanup guarantees and costs

- Each copy registers irreversible `clean_copy_intent` under the current scan claim before contacting storage. Terminal records with this intent are re-reconciled while `clean_purged_at` is missing. Migration 0043 permits a final clean purge stamp only once `ended_at` is at least 24 hours old and another clean-bucket `deleteAllVersions` succeeds. This closes the copy intent operationally without clearing its flag; once both bucket purge stamps exist, the row leaves the purge loop. Live clean and attached winners are excluded from clean-bucket deletion.
- This costs recurring bounded list/delete calls until closure; storage failures remain retryable after 24 hours and do not release quota. The worker walks candidates by immutable creation time and ID, carrying a purge cursor between sweeps and wrapping at the end. Failed objects stay retryable without blocking later files. A worker restart restarts the cursor; persistent restarts can delay a full pass.
- Storage operations abort after at most 60 seconds including retries/pagination, with a 5-second connection timeout and a rejecting 30-second request timeout. The scan owns opened-body destruction and its scan deadline. A sweep can take multiple bounded operations per row; watch maintenance health and `purge_failed` counts, investigate provider access/retention failures, and let later cursor passes retry.
- The 24-hour closure window exceeds the capped 60-second storage request budget; a cancelled copy cannot complete 24 hours later. Closure still needs a successful clean-bucket all-version deletion, not age alone.
- Migration 0038 conservatively marks existing uploaded rows as possible copy writers and clears their old clean purge stamps. It also erases filenames of existing ended unattached records. Database transitions automatically erase these names on rejection, scan failure, expiry or discard and prohibit restoration. Active clean draft names remain until their 24-hour TTL; attached and retention-deleted order names retain the order metadata policy.

## Completed-order retention

- All attached files, including brief references and thread/submission files,
  become due 180 days (180 × 24 h) after `completedAt`, unless an evidence hold
  is active. The I7 evidence-hold port returns false; future hold integration
  must keep held files protected. `in_progress` and `delivered` files are not
  due under this rule.
- Production ships `COMMISSION_FILE_RETENTION_MODE=report_only`: maintenance
  counts eligible files without marking them deleted or deleting their retained
  bytes. Reporting uses bounded pages and a retention cursor, so a batch count
  is not a whole-order inventory. Expired/failed/abandoned-file cleanup still
  runs independently of retention mode and files mode.
- Enforcement needs separate owner approval and
  `COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE`. In `enforce`, maintenance
  marks due attached files `deleted`; subsequent purge sweeps remove every
  version from both buckets. Copy-intent closure and quota release follow the
  rules above. The unpaid-closed rule remains 30 days after close.
- Order records, encrypted message/submission text and attached-file metadata
  remain under the separate paid-order retention gate. Byte retention does not
  authorize deleting that history. Parties should download the final files
  before the deletion date shown on the completed-order screen.

## Alerts

- **PawketCommissionFileScannerDown / SignaturesStale:** `docker logs <clamd>`; check memory (signature reload needs about 2–3 GB) and outbound access to the ClamAV mirror. Restarting `clamd` is safe.
- **PawketCommissionFileScanBacklog:** check the alerts above first. Files keep retrying for 24 hours and then become `scan_failed`; the buyer is asked to upload again.
- **PawketCommissionFileMaintenanceUnhealthy:** check worker logs for `commission_files_maintenance_failed` and database health.

## Never

- Never copy a file from quarantine to clean by hand, and never mark a file `clean` in SQL.
- Never paste presigned URLs, filenames or object keys into tickets or chat.
