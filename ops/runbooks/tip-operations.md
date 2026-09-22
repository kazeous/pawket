# Tip expiry and notification operations

Default: `TIP_PAYMENTS_MODE=disabled`. Publishing and retention keep their own
disabled/report-only gates. This runbook does not authorize activation, real
transfers, bank reconciliation or a production mutation.

## Owner-managed amount policy

The owner workspace links to `/admin/tip-policy`. An authenticated owner can
edit the minimum, maximum, and 3–10 ordered allowed presets, with recent TOTP
and a reason. The first three presets are the platform defaults. Limits stay
within 10,000–5,000,000 integer VND. Saved revisions and their previous values
are visible in owner-only history; changing these values needs no restart.

Every new tip uses the committed policy. A creator's selected trio is kept
when still allowed; otherwise new tips use the platform default trio, and the
creator workspace explains the fallback and offers reselection. The original
creator revision is preserved. Policy changes do not alter existing amounts,
bank destinations, references, expiry times, or confirmation evidence.

`TIP_AMOUNT_MIN_VND`, `TIP_AMOUNT_MAX_VND`, and `TIP_SUGGESTED_PRESETS_VND` are
obsolete. New code ignores them, including malformed leftover values.
`TIP_PAYMENTS_MODE` remains the deployment emergency/activation gate; policy
editing never enables payments or publishing. A missing database policy blocks
new tips and settings writes without preventing unrelated application startup.
Existing instructions and settlement still apply their own security checks.

On an uncertain save response, retry the same operation before editing again.
The saved result is returned without another revision. A version conflict
requires loading the latest policy and reviewing the intended values again.
Restoring earlier amounts means saving another audited revision, never changing
history or resetting a pointer with SQL.

## Policy migration and rollout

Before deploying migration 0026, verify the running policy still matches the
approved bootstrap values: 10,000 minimum, 5,000,000 maximum, and
20,000/50,000/100,000 presets. If it differs, stop and prepare a reviewed import;
do not overwrite a different live policy. Keep tips and publishing disabled
through the rollout and verify all writer instances use the new revision
before editing policy or considering separate activation approval.

Migration 0026 initializes policy once with explicit system provenance. It
adds nullable policy-revision bindings for legacy rows without inventing their
history. New setting/tip inserts require current policy evidence. Old binaries
therefore must not act as payment writers after the migration. Do not replay
the raw migration or use GET/startup as a bootstrap mechanism.

Retain the three old Coolify amount values through the rollback window as
unused compatibility settings. Their removal is a separate production change.
Rollback requires tips disabled, a verified older application revision, and
retaining expanded schema, policy/audit revisions and financial evidence.
Never run a down migration, delete policy history, or assume an old binary can
honor policy changes made in the new dashboard. Verify source/build equality,
migration completion, web/worker readiness and disabled public routes after
the authorized rollout. Record local and production evidence separately.

`PawketTipExpiryUnhealthy` means an enabled worker has a missing, failing or stale
expiry scan. Check exact revision attestation, PostgreSQL connectivity, worker
readiness and the fixed `tip_expiry_failed` log category. Each scan is bounded
by `TIP_EXPIRY_BATCH_SIZE` and `TIP_EXPIRY_SCAN_INTERVAL_MS`. Disabled workers
perform no tip transitions. Never change confirmed/rejected records to retry.
Once the dependency recovers, an ordinary scan retries eligible overdue pending
intents. Queue/receipt reads already hide expired instructions independently.

The `pawket_tip_operations_total` labels are fixed operation/outcome vocabularies.
Creation, claim and manual-confirmation success/replay counters run after the
transaction commits. QR counters describe local encoder attempts, not bank
acceptance or browser-image rendering. No counter proves that money arrived.
Never add a creator ID, reference, bank transaction ID or guest message as a label.

`PawketTipNotificationHandoffFailures` indicates that a source event could not
materialize its operational handoffs. Check the existing outbox age, attempts and
delivery-failure metrics. The worker resolves the persisted source and matching
business fact, then creates an encrypted email handoff and an in-app availability
fact idempotently. The creator queue and authorized receipt read business state
directly. No separate inbox or guest email collection is introduced here.

Email delivery can remain pending or require attention without changing payment
state. Use the existing security-email delivery runbook for bounded retries and
unknown provider outcomes. Do not copy a guest receipt capability into an email
or regenerate a payment to resend a notice. Synthetic validation uses the local
sink or injected transport and never sends a real message.

All five tip retention datasets report only, including when the legacy retention
runner is set to enforce. `processedCount` remains zero and all candidates stay
protected pending separately accepted privacy/retention policy. Confirmations and
bank evidence have no short-lived cleanup schedule. Receiving-account versions
referenced by a tip cannot be minimized. Do not disable these guards to clear an
alert; record the failed dataset/category and resolve the approved policy first.
