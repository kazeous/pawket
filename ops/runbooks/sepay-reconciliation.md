# SePay connection and reconciliation operations

## Disabled release and contract gates

Deploy with `TIP_PAYMENTS_MODE=disabled` and `SEPAY_INGRESS_MODE=disabled`.
The production adapter remains `contract_pending`: no environment switch can
assert the missing SePay OAuth app, PKCE, stable tenant/account/event identity,
bank/VA/time/reference or remote revocation proofs. Synthetic tests are not
provider acceptance. Do not register an app, obtain credentials, add scopes,
enable production ingestion or perform real transfers under this runbook alone.

Platform client credentials belong in server-only settings. Creator OAuth grants
and webhook secrets belong in encrypted, versioned database records. The only
approved scopes are `bank-account:read` and `transaction:read`; never substitute
a general API Access token or add company/write/webhook-management permissions.
Use `SEPAY_ENVIRONMENT=test` only on isolated non-production origins, databases
and queues; production is `live`. The fixed redirect is the application origin
plus `/api/v1/creator/tips/sepay/callback`, without query or fragment.

Before an authorized rollout, verify migrations 0027 and 0028, exact web/worker
source and build SHA equality, health, and disabled flags. Stop all old payment
writers before admitting any cutover. An environment mode change is fleet-wide
only after every old instance stops; a creator pause/disconnect fences current
work through the database immediately. Roll back with payments and ingress off,
retain expanded schema and all evidence, and never run a down migration.

## Cutover and outages

The creator must resolve or allow ordinary expiry of every open manual tip on
the physical receiving account before enabling automation. Shared or ambiguous
ownership cannot be resolved by an operator overriding this check. Cutover is
durable across reconnect and account revisions. Provider-bound tips require
fresh independent OAuth readback for both automatic and creator-reviewed
confirmation. There is no offline manual override or unrestricted manual
fallback after cutover. Pause/disconnect can hide receiving instructions and
block new provider-bound tips; existing pending tips still expire normally.

`manual_only` preserves ordinary manual-attested behavior and fresh-provider
creator review but does not run automatic reconciliation. `sepay_optional` runs
automatic processing and expiry. Disabled mode performs no payment mutations.
Ingress has a separate gate. Durable inbox receipts remain recoverable when
automatic processing is paused, even after their queue delivery is acknowledged.

For a provider outage, inspect masked creator status, fixed error categories and
the read-only owner diagnostics. Never paste raw payloads, banking details,
OAuth responses or receipt capabilities into logs/tickets. A remote 429 stores
Retry-After in the database across web and workers. The shared environment
budget is 30 requests/minute; a list lookup reserves five pages. The documented
transport caps each request at 5 seconds, each lookup at five pages and starts
no further page after its 15-second budget. A currently executing bounded page
may finish after that deadline. There is no whole-account feed poll/backfill.

`SEPAY_PROCESSING_MAX_ATTEMPTS` bounds automatic retries (default 5).
`SEPAY_PROCESSING_BATCH_SIZE` (default 25) and
`SEPAY_PROCESSING_SCAN_INTERVAL_MS` (default 30000) bound DB recovery scans.
Retry exhaustion requires review. A creator may explicitly retry relevant
evidence after recovery; retry/dismiss/reopen never changes amount, destination,
terminal payment state or evidence. Dismissal is not a refund or money resolution.

## Durable recovery, conflicts and credentials

An HTTP 200 `{"success":true}` means a durable accepted/ignored/duplicate/conflict
disposition exists, not that a payment is confirmed. Database failure returns a
non-success response for provider retry. Queue failure cannot erase a committed
receipt: recovery scans due or expired-lease inbox work from PostgreSQL. Restart
the current revision after dependency recovery. Do not clear tables, delete
queue jobs as a substitute for reconciliation, replay arbitrary payloads or
change canonical transaction reservations. Confirmations and their business
outbox/notification handoff commit atomically and are safe to redeliver.

Each worker runs at most one recovery scan at a time. Provider lookup does not
hold the outbox polling loop; shutdown drains the in-flight scan before closing
the database, within the worker's bounded shutdown deadline.

Contradictory authenticated events sharing one provider ID enter review and do
not overwrite first evidence. Inspect masked facts and a fresh scoped readback;
never assign a transaction to a different tip or override exact matching.
If provider retries carry an unsupported timestamp/signature profile, gather
redacted provider evidence and review the contract; do not widen tolerance.

An uncertain token exchange/refresh requires reconnect; do not reuse a possibly
spent token or restore an old grant row. Disconnect immediately disables local
use and truthfully reports remote revocation as unverified until proved.
Never delete a shared SePay application to emulate per-grant revoke. Lost
webhook-secret reveal requires the creator's explicit assured rotation command.
Follow `pii-key-rotation.md` for AAD-bound encryption keys and retained-key access;
do not bulk export decrypted grants/evidence. Keep old keys while retained
financial evidence requires them, subject to an accepted rotation procedure.

## Health, alerts and retention

Worker readiness reports `sepay` as `disabled`, `not_configured`,
`contract_pending` or `configured`, separately from recovery freshness.
`contract_pending` is not live integration readiness. An enabled failed/stale
recovery scan makes worker readiness fail. `PawketSePayRecoveryUnhealthy` checks
that configured scanning succeeds; `PawketSePayInboxDelayed` identifies pending
receipts older than fifteen minutes. `PawketSePayRetryExhausted` requires review.
Inspect `sepay_recovery_failed`, outbox health and database availability before
retrying. Callback/authorization query values and headers must stay redacted.

`pawket_sepay_operations_total` has fixed operation/outcome labels for ingress,
lookup, reconciliation and recovery. Latency and inbox gauges contain aggregate
counts/age only. Never add creator/connection/transaction/account/reference
labels. A success counter is not proof of money movement.

Raw accepted payload retention is proposed at 30 days with evidence holds.
Financial confirmation, token-revision and backup policies still require
separate privacy/retention acceptance before live activation. This release
enables no deletion job. Existing report-only/global-pause controls remain
authoritative; retain raw and financial evidence during disputes, recovery and
the rollback window. Do not clear retained records to silence backlog alerts.
