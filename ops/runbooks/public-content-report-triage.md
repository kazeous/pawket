# Public content report triage

## Detection

Investigate `PawketPublicContentReportQueueOld`, the owner report queue, or a report-workbench readiness/error signal. The operational target is that no open report remains unassigned or unreviewed past the approved six-hour window.

## Safe evidence to collect

Record the exact deployed revision, report ID in restricted owner evidence, target type and target ID, exact reported publication revision, closed reason, created time, current visibility hold, prior bounded triage actions, and current creator capability. Keep report detail visible only in the authorized owner workbench. Never expose reporter identity, actor IDs, challenge hashes, pseudonymous network HMACs, raw IP addresses, user agents, private Identity/application/payment data, or private media facts.

## Disabled-mode behavior

Keep publishing disabled. Owners may rehearse and operate the private queue against synthetic or already-authorized records, but a triage action must not activate a creator page. Public routes remain neutral not-found while the mode is disabled.

## Retry and recovery

Assign one authorized owner, establish a fresh TOTP proof no older than five minutes, and compare the report with the exact immutable publication revision. Rehearse and verify dismiss, hide, and restore as separate audited actions. Retry only through the idempotent command path with the original command identity; re-read current revision and hold state after any conflict.

## Rollback

If an incorrect hide was applied, use the audited restore command after exact-revision review. A restore removes only the intended visibility hold and must not republish an unpublished or suspended creator. If code is faulty, keep publishing disabled and deploy the previous reviewed revision; preserve report and audit history.

## Escalation

Escalate suspected prohibited content, safety risk, legal/IP claim, privacy incident, or coordinated abuse through the relevant owner/legal/security path. Page/showcase triage is not creator-capability enforcement: request a separate, audited creator capability suspension when the whole creator account requires review. Suspension and reinstatement never auto-republish.

## Forbidden actions

- Do not reveal reporter identity or network-control evidence to creators or the public.
- Do not paste report prose or private media facts into logs, metrics, alerts, or broad tickets.
- Do not bypass TOTP, ownership, exact-revision, or idempotency checks.
- Do not delete reports or audit history to clear the queue.
- Do not treat hide/restore as authority to suspend/reinstate a creator.
- Do not enable publishing to test triage.
