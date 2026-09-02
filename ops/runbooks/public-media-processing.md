# Public media processing incident

## Detection

Investigate `PawketPublicMediaProcessingStuck`, `PawketPublicMediaTerminalFailures`, or `PawketPublicMediaCleanupFailures`; a worker readiness failure on `publicMediaCleanupScan`; or a sustained increase in the bounded pending-media gauge. Confirm the exact deployed source/build revision before interpreting any queue evidence.

## Safe evidence to collect

Record the incident window, revision, worker readiness, bounded backlog age, closed operation/outcome/purpose/variant metrics, queue job state, database asset state, attempt count, lease timestamps, and terminal failure code. Asset IDs may be kept in the restricted incident record when needed for reconciliation, but never put IDs, creator data, filenames, signed URLs, storage credentials or keys, source bytes, report prose, IP data, or user agents into logs, metrics, alerts, or general tickets.

## Disabled-mode behavior

Keep `CREATOR_PUBLISHING_MODE=disabled` and `PUBLIC_MEDIA_RETENTION_MODE=report_only`. Disabled publishing rejects fresh upload and publication commands; it is not an excuse to delete or expose private objects. Existing durable jobs may be inspected and recovered without opening the public catalog.

## Retry and recovery

Treat PostgreSQL state, the pinned source version, processing attempt, and outbox/job identifier as authoritative. Let lease-aware worker redelivery reclaim expired work, restore Valkey or object storage first, and then verify a single idempotent retry. For storage readiness, the runtime principal needs `s3:ListBucket` only on the quarantine and derivative buckets for `HeadBucket`, plus the separately reviewed object-level permissions. Re-run the exact processor contract on synthetic media before resuming ordinary work.

## Rollback

Freeze new work with publishing still disabled, deploy the last reviewed revision with matching source/build attestation, and allow database leases to expire normally. Roll back application code and configuration together; do not roll back or rewrite an already-applied migration, pinned version, immutable publication revision, or terminal processing fact.

## Escalation

Escalate terminal or repeated failures to the owner and storage operator with the revision, UTC window, bounded failure code, affected internal asset IDs in restricted evidence, and provider incident reference. Escalate suspected source corruption, unauthorized access, or lost object versions as a security/data-recovery incident. A change to accepted formats, retry bounds, retention, or public visibility requires a separately reviewed product and security decision.

## Forbidden actions

- Do not expose source objects, filenames, signed URLs, object keys, credentials, or media bytes.
- Do not edit attempts, leases, hashes, pinned versions, or immutable publication facts by hand.
- Do not replay unknown-outcome work blindly or create a second job identity.
- Do not enable retention enforcement during recovery.
- Do not enable creator publishing as a diagnostic step.
- Do not copy production media into an uncontrolled debugging system.
