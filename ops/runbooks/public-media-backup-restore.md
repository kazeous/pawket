# Public media backup and restore

## Detection

Investigate `PawketPublicMediaStorageUnavailable`, failed `HeadBucket` checks, missing pinned versions, derivative hash mismatch, backup job failure, or a failed restore rehearsal. Treat an unavailable quarantine or derivative bucket as a storage incident even while publishing is disabled.

## Safe evidence to collect

Record the exact source/build revision, provider incident and UTC window, private bucket/versioning/IAM/CORS configuration evidence, backup identifier, synthetic object version, database derivative facts, expected and restored hashes, and isolated restore destination. Keep credentials, signed URLs, full object keys, real creator media, filenames, and media bytes out of logs and tickets.

## Disabled-mode behavior

Keep creator publishing disabled and media retention report-only throughout backup or restore work. Disabled mode prevents public exposure but does not prove object durability, backup completeness, least privilege, or recoverability.

## Retry and recovery

Use an isolated private destination with no public route. Back up a synthetic source object and its exact version plus the matching PostgreSQL asset, derivative variant, version, size, content type, and SHA-256 facts. Restore both object and database facts into the isolated destination, read the restored exact version, hash-verify it against the recorded derivative fact, and confirm authorization still denies unrelated versions. A database-only backup or object-only restore is incomplete.

The runtime principal requires `s3:ListBucket` scoped to the quarantine and derivative bucket ARNs so `HeadBucket` can prove availability. Keep object read/write/delete/version permissions separately scoped to the approved prefixes and duties. Buckets remain private, versioned, encrypted, and configured for the exact application origin without wildcard credentials.

## Rollback

If rehearsal or recovery fails, leave production unchanged, publishing disabled, and retention report-only. Remove only synthetic data from the isolated destination through the approved cleanup path after evidence is captured. Revert application/IAM changes as one reviewed unit; never delete production versions to imitate a rollback.

## Escalation

Escalate missing versions, hash mismatches, unauthorized access, backup gaps, or provider durability concerns to the owner, storage operator, and security lead. Do not accept storage activation until least privilege, bucket privacy, versioning, exact-origin CORS, backup, and restore evidence all reference the reviewed revision and environment.

## Forbidden actions

- Do not make either bucket or restored object public.
- Do not place credentials, signed URLs, keys, filenames, or real media in evidence.
- Do not restore into production as the first rehearsal.
- Do not claim success from a database-only backup or an object-only restore.
- Do not overwrite or delete the authoritative pinned production version.
- Do not enable publishing or retention enforcement to test storage recovery.
