# Tip expiry and notification operations

Default: `TIP_PAYMENTS_MODE=disabled`. Publishing and retention keep their own
disabled/report-only gates. This runbook does not authorize activation, real
transfers, bank reconciliation or a production mutation.

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
