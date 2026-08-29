# Task 7 report — public media persistence

## RED/GREEN

- RED: `public-media-schema.integration.test.ts` was written before the media schema and initially failed because the exported tables and database objects were absent. The same test also exercises duplicate intents/variants, closed values, expiry and byte boundaries, required readiness, terminal attempt immutability, lifecycle transitions, private-column boundaries, and indexes.
- GREEN: the focused media schema plus migrator suite passes: 2 files, 13 tests.

## Schema and trigger contract

The migration adds `public_media_assets`, `public_media_upload_intents`, `public_media_derivatives`, and `public_media_processing_attempts`.

- Assets use the closed `avatar|cover|showcase` purpose, `jpeg|png|webp` source format, and `awaiting_upload|pending|processing|ready|failed|deleted` lifecycle. Allocation/source bytes, dimensions, source/master object identity, failure, readiness, cleanup review, timestamp, and private opaque-key checks are enforced.
- Upload intents are unique per asset and require bounded source bytes/pixels plus exactly `created_at + 15 minutes` expiry. Ownership and asset composite identity are restricted by foreign keys.
- Derivatives are unique per asset and fixed `master|thumb|display|large` variant, WebP-only, positive/bounded dimensions and bytes, versioned private object key, content hash, and non-null verification time.
- Processing attempts are ordered and unique per asset/attempt (1–8), have bounded worker/outcome fields, retry coherence, timestamp coherence, and append/terminal immutability guards.
- Asset lifecycle triggers reject invalid transitions, terminal escapes, readiness without a normalized master/dimensions and all four verified variants, and unreviewed `ready → deleted` cleanup. Derivative insert/update/delete is rejected for ready or terminal parents. Identity and media ownership foreign keys use `ON DELETE/UPDATE RESTRICT`.
- Worker, quota, cleanup, asset/variant, retry, and intent expiry indexes are present; no original filename, public URL, or secret field is persisted.

## Migration metadata and exports

- Migration: `0021_increment_3_public_media.sql`.
- Journal: index 21, total 22 entries; blank and index-20 upgrade paths are covered.
- Snapshot: `meta/0021_snapshot.json` regenerated from the authoritative Drizzle schema; `drizzle-kit check` reports no schema changes.
- `schema/index.ts`, database root exports, and Drizzle config include the media tables. `schema.ts` already wildcard-exports `schema/index.ts`, so no direct edit was needed.

## Verification

- PostgreSQL integration (`postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev`): focused media/migrator suite passed (13 tests); prior catalog schema regression passed (11 tests).
- `pnpm lint`: passed with two pre-existing warnings.
- `pnpm typecheck`: passed across the workspace.
- Full unit suite: 44 files, 395 tests passed.
- `drizzle-kit check`: passed.
- `git diff --check`: passed.

## Concerns / follow-up

The migration includes defense-in-depth SQL triggers and a composite intent ownership FK that Drizzle snapshots cannot express; these remain intentionally migration-owned. Media service/worker behavior and retention enforcement are subsequent tasks and are not implemented here.

Commit: `feat: add public media persistence` (this commit)
