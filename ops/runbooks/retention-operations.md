# Retention operations

`RETENTION_MODE=report_only` is the production default and performs no deletion or minimization.

1. Review `system_retention_runs` counts for all six datasets and investigate any `failed` outcome. Counts contain no row IDs or PII.
2. Before enforcement, record policy/legal acceptance, set a non-secret policy version and acceptance timestamp, confirm incident/hold handling, take a recoverable database backup, and approve a bounded batch size.
3. Activate only with `RETENTION_MODE=enforce` and `RETENTION_ENFORCEMENT_PAUSED=false`. Missing approval metadata is rejected at startup.
4. Watch candidate/protected/processed metrics and database load. Pause immediately for an incident, unexpected protection count, partial failure, refund risk, or provider instability.
5. A failed batch rolls back that dataset transaction. Do not mark it complete or compensate by broad SQL. Fix the cause, re-run report-only, then resume the idempotent batch.
6. Deletion/minimization is not generally reversible. Rollback means pausing future work and restoring a separately approved backup when legally and operationally justified.

Refunds, liabilities, unmatched deposits, decisions, capability history, audit events, and outbox events are never retention targets.
