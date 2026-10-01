# Release attestation

1. Freeze the release if any migration, build, readiness, or revision check fails.
2. In Coolify, enable **Include Source Commit in Build** and confirm `SOURCE_COMMIT` is a lowercase 40-character SHA. Do not type a separate `APP_REVISION`.
3. Confirm the migrate container exits successfully before the worker starts, and the worker is healthy before web starts; `compose.prod.yaml` enforces this order. Confirm exactly one web and one worker container exist for the application and the Coolify deploy log has no "Error stopping container"; stop any container left from an earlier deploy before accepting the release. The deployment monitor must publish the bounded `pawket_migration_runs_total{outcome}` result used by the alert rule.
4. Query web and worker `/health/live` and `/health/ready`. Require `revision`, `buildRevision`, and the intended Git SHA to be identical, with `revisionMatch: true`.
5. Query protected metrics and require `pawket_revision_match` to equal `1` for both services.
6. If mismatched, stop the rollout, retain logs without secrets, correct source-commit injection, and redeploy the same reviewed revision. Never relabel a stale image.

Record deployment ID, Git SHA, health evidence, migration outcome, operator, and UTC time. A green build alone is not acceptance.
