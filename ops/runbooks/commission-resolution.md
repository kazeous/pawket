# Commission resolution — Increment 8 Stage A

This runbook covers cancellation proposals, disputes, commission refunds,
late-payment claims and suspension/freeze effects. Money stays with the parties:
Commission refunds are always sent by the creator through their bank, never by
the owner or Pawket. Pawket records obligations and
evidence; neither a close nor a send record proves money was recovered.

Use with [Commission operations](commission-operations.md) and
[Commission files](commission-files.md). The order-exit and case-scoped access
rules here supersede the historical I6/I7 statements that paid cancellation is
unavailable and that the owner has no private-content access.

## Release and switch order

Ship resolution, payments, intake, fulfilment and files disabled; keep file
retention `report_only`. Apply additive migrations 0045–0051, including the
refund calendar update and effective-resolution-deadline function. Drain old
workers, start compatible workers, check revision/readiness and scan health,
then replace web. Every worker must understand the new states and events before
web serves them. Check for leftover workers as described in Commission operations.

Activation requires separate owner authorization, the existing private-storage,
scanner, OCI upload and fulfilment gates, copy sign-off, an `owner_reviewed`
commission policy revision, and the separate legal and real-payment gates.
The Vietnamese refund policy in local `docs/` is a draft; it is not published
by this release. SePay retains its provider-evidence gate.

Enable consistently across web and worker, in this order:

1. `COMMISSION_FILES_MODE=enabled`, after the storage/scanner gates.
2. Switch fulfilment and resolution on together:
   `COMMISSION_FULFILLMENT_MODE=enabled` and `COMMISSION_RESOLUTION_MODE=enabled`,
   after the fulfilment gates and with a resolved, approved
   `VN_BUSINESS_CALENDAR_VERSION` and holiday data. Verify that the worker has
   durably observed resume and that the resolution scan is healthy.
3. Enable `COMMISSION_PAYMENTS_MODE=manual_only` (or separately authorized
   `sepay_optional`) only after resolution is enabled. Enable intake only when
   the remaining launch gates are closed and the owner authorizes it.

Fulfilment and resolution must be switched on and off together. Once paid orders
exist, never run `COMMISSION_FULFILLMENT_MODE=enabled` with
`COMMISSION_RESOLUTION_MODE=disabled`: delivered orders would auto-complete
while buyers cannot open disputes.

Configuration rejects active commission payments without both fulfilment and
resolution, resolution without fulfilment, and fulfilment without files. To
pause resolution, disable intake and commission payments first, drain affected
instances, then disable fulfilment and resolution together consistently across
web and worker. Disable files afterwards only if the incident requires it. Keep a compatible
worker running; changing environment values does not stop old instances.

## Pause observation and time

The `commission_resolution` scan observes the mode even while disabled. It
opens/closes `commission_resolution_pauses` under its advisory lock. The recorded
time is the worker's observation, not the environment edit. Reads remain
available; commands and maintenance transitions stop while a resolution pause
is open. The overdue-refund intake fence does not apply while resolution is off.

A resolution deadline covered by an off period is unavailable while that period
is open and moves to the recorded resume plus 48 hours afterwards. This includes
proposal responses, dispute/claim windows, refund send/receipt deadlines and
ruling corrections. A pending proposal or open dispute continues to hold
completion; do not bypass it while paused. Review-time restoration also respects
the fulfilment pause history. Repeated pauses are applied to the effective
deadline. Inspect effective dates in the authorized UI, not just raw columns.

Confirm a durable closed pause, `pawket_commission_resolution_paused=0`, fresh
scan success and working party controls before accepting recovery. Never insert,
backdate, close or delete either resolution or fulfilment pause rows by SQL.
Destination purge is a privacy-retention action: it waits while resolution is
paused, then uses terminal time plus 30 days, without adding pause grace.

Read-only aggregate pause diagnosis:

```sql
SELECT count(*) FILTER (WHERE ended_at IS NULL) AS open_pauses,
       min(started_at) FILTER (WHERE ended_at IS NULL) AS open_pause_started_at,
       max(ended_at) AS last_resume_observed_at
FROM commission_resolution_pauses;
```

## Alerts and first checks

| Signal | Meaning | First response |
| --- | --- | --- |
| `PawketCommissionRefundOverdue` | `pawket_commission_refund_overdue > 0` for 1 hour; **info**. At least one commission obligation awaits a send after its effective due date. | Inspect the commission `refund_overdue` queue, destination/deadline state and the creator's intake banner. This is a review signal; the creator sends the money. |
| `PawketCommissionResolutionScanStale` | Scan unhealthy or last success at least 900 seconds old, for 15 minutes; **warning**. | Check worker revision, database/queue connectivity, scrape freshness and lock contention; inspect only the fixed `commission_resolution_failed` log category. |
| `pawket_commission_resolution_paused=1` | Last durable observation found an open pause. | Match the fleet's intended mode to the durable observation. A deliberate pause still needs a healthy scan. |
| Global outbox retry/validation alerts | A consumer could not validate or process durable source evidence. | Check compatible consumer revision and source/state IDs; preserve the unacknowledged event and retry after recovery. Never discard evidence to clear the alert. |

The resolution scan runs every `COMMISSION_SCAN_INTERVAL_MS` (default 60,000 ms),
with bounded batches (`COMMISSION_SCAN_BATCH_SIZE`, default 100), one scan in
flight and shutdown draining. Worker readiness tolerates three scan intervals
since the last success; one failure does not erase that last success. Alert
timing and readiness timing differ. Bounded cursors may need to wrap before a
waiting row is revisited. No scan success is proof that the money arrived.

## Reading a stuck case

Start at `/admin/cases`; filter by kind/state and check the queue's next deadline.
Age/deadline filters apply to loaded rows, so load older pages as needed. Open
the case summary before requesting evidence. Private evidence is accessible
only while its case is open. Each view/preview/download requires fresh owner
step-up and appends `trust_case_access_log`. Refund destinations are available
only in refund cases. Private evidence closes when the case resolves.

| Record/state | Expected next step and diagnosis |
| --- | --- |
| Pending proposal | Other party accepts/declines, proposer withdraws, or the worker expires it after 72 hours. A fulfilment move makes it stale/lapsed. At most 3 proposals per party per order. On delivered orders it holds completion. |
| Open dispute | Parties can supplement statements (10 each, 4,000 code points each); owner reviews/questions/rules. Response deadline is 5 days, extendable only up to opening plus 14 days. A response deadline alone does not resolve the dispute. Completion remains held. |
| Resolved dispute/ruling | Read the summary and timeline. `complete` requires delivered; `close` can end a live paid order. A money-only correction is available for 30 days, subject to effective pause grace; it never reopens the order or reverses a transfer. |
| `awaiting_destination` | Buyer enters/corrects the account with recent reauthentication. No transfer deadline runs before entry. At 30 days without an account it appears in the owner's aging view. Pawket cannot verify the account. |
| `awaiting_send` | Creator reveals the destination (audited, recent reauthentication), transfers externally, then records the send. Deadline is 23:59:59.999 Vietnam time on the fifth Vietnam business day after entry. A correction before any send restarts it. |
| `sent` | Buyer confirms or denies within 7 days of recording. Silence becomes `presumed_received` through maintenance at the effective confirmation deadline. This is a procedural state, not bank verification. |
| `not_received` / `refund_not_received` | Owner reviews evidence and accepts receipt, requires a new send with a new 5-business-day deadline, or waives. Earlier sends remain evidence. |
| `refund_overdue` | Creator records a send; owner may extend the deadline (at most 30 days ahead) or waive with a reason. Intake resumes only when all effective overdue obligations are cleared. |
| `awaiting_creator` late claim | Creator confirms the amount actually received or denies, within 5 days. Denial or silence opens `late_payment` for owner review. One claim per eligible closed unpaid order within 30 days; the order never reopens. |
| Resolved late claim | `refund_owed` creates an obligation; `rejected` does not. Provider late-match support is fixture-tested; SePay live wiring remains deferred. |

Use the supported party/owner commands, with reasons, request IDs, idempotency
and version checks. An uncertain result must be checked/retried with the same
bytes and key; refresh after a version conflict. Do not replace a persisted
destination, send or ruling by editing rows. Owner actions are admin-audited;
refund reveals are separately audited. Keep private reasoning, bank references,
accounts, message text, filenames, keys and file URLs out of operational logs,
metrics, tickets, outbox payloads and snapshots. Record environment, revision,
time, non-private state/IDs and the observed outcome in a local incident note.

## Intake, suspension and files

An effective overdue `awaiting_send` obligation blocks new requests/checkouts,
request acceptance, new quotes and quote acceptance under the creator lock.
Existing issued intents and paid orders keep their paths. Public pages show
only `Tạm ngưng nhận đơn`; only the creator workspace explains the refund cause.
Recording every overdue send, extending deadlines or waiving obligations lifts
the fence automatically; resolving one case may leave another overdue refund.

Creator capability suspension stops new intake; paid fulfilment and refunds
continue. Buyers may cancel live paid orders with full refund obligations while
the creator remains suspended. The owner can freeze all live paid orders of a
suspended creator atomically, with step-up and a reason; this closes them with
full obligations and read-only threads. Freeze cannot restore those orders.
Account suspension may prevent sign-in and therefore party action; it does not
cancel obligations. A buyer unable to enter a destination has no send deadline.

After a paid close, the buyer retains their own uploads, brief references and
thread text, loses access to creator thread/submission files, and can still read
creator refund-send evidence. The creator retains authorized files and
refund actions. Existing downloaded copies cannot be recalled. Paid-close and
resolution-evidence retention is 180 days after terminal close, with open-case
holds and at least 30 days after the last hold ends; unpaid brief references
retain their 30-day rule. Retention enforcement stays `report_only` until
the owner approves it. Full refund destinations purge 30 days after a terminal
obligation; the bank label and last four digits remain.

## Forward-only rollback

Once any resolved order or refund obligation exists, rollback is forward-only.
Every replacement web/worker must understand the exit states, cases, obligations,
holds and migrations 0045–0051. An older worker must never process them even
with commerce disabled. Pause new intake/payments, then fulfilment and resolution together
when required; keep a compatible worker observing the pause. Preserve schema,
events, reservations, obligations, evidence and pause history. Fix forward;
never down-migrate, delete records, rewrite a close as completion, force a
receipt, or reopen orders to start an older binary. Deployment/readiness checks
do not replace independent flow verification. Production audit is read-only
unless separately authorized by the owner.
