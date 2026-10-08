# Commission operations — Increments 6 and 7

For Increment 8 Stage A order exits, switch dependencies, case-scoped owner
access and commission refund alerts, follow [Commission resolution](commission-resolution.md).

## Release and activation

Ship with `COMMISSION_INTAKE_MODE=disabled` and `COMMISSION_PAYMENTS_MODE=disabled`
on every web and worker instance. Apply additive migrations 0029 and 0030 before
starting this revision. Verify embedded web/worker/migration SHA, readiness,
outbox dispatch and legacy tip flows. Synthetic policy fixtures must never
authorize a production order; the bootstrap policy is technical only.

After migrations, replace and drain every I5 worker before routing traffic to
I6 web instances. Confirm all active workers report the verified I6 revision
and readiness, then replace the web fleet with both commission controls disabled.
Package drafts and capacity settings remain writable during this pause and emit
commission catalog events; disabled intake is not a no-event fence. I5 workers
reject these event types. The rehearsed I5/I6 overlap applies only while no
commission catalog, order or event records exist; it does not authorize serving
the I6 package editor while an I5 consumer remains active.

On Coolify this order is automatic. A deploy gracefully stops and removes every
running container of the application before `docker compose up`, and
`compose.prod.yaml` starts web only after migrate has completed and the new
worker reports healthy. Two checks remain manual after every deploy. Coolify
ignores errors while stopping old containers and names each deploy's containers
differently, so confirm exactly one web and one worker container exist for the
application and the deploy log has no "Error stopping container"; stop any
leftover older worker before accepting the release. If the new worker never
becomes healthy, `docker compose up` fails and web is not started: redeploy the
previous revision or fix forward. Any deployment outside Coolify must follow
the same worker-first order by hand.

I6 ended at paid / in progress; I7 Stage B adds delivery and completion below.
Real commission intake remains gated by
accepted I7 delivery, I8 dispute/refund handling, owner-approved policy text,
retention and support ownership. SePay retains all I5 provider contract gates.
This runbook does not authorize activation, credentials or a real transfer.
Money goes directly to the creator; no platform wallet or escrow.

## Stage B rollout and enablement

Ship with `COMMISSION_FULFILLMENT_MODE=disabled`, `COMMISSION_FILES_MODE=disabled`
and `COMMISSION_FILE_RETENTION_MODE=report_only` on every web and worker instance.
Apply additive migrations 0041–0044 before starting the Stage B revision: order
fulfilment and pauses, threads and file contexts, copy-intent closure, then quota
release for closed copy intents. Follow the worker-first deployment order above;
every active worker must understand the new states and outbox events before web
can serve them. Keep the switches off while verifying revision, readiness,
outbox health and existing commission/payment flows.

After the owner-approved private-storage and scanner prerequisites in
[Commission files](commission-files.md) are met, fulfilment enablement requires
these gates in order:

1. Enable `COMMISSION_FILES_MODE` on web and worker with owner authorization.
2. Pass the OCI single-PUT check at 250 MiB (262,144,000 bytes), with verified
   stored bytes, from a normal home connection in an owner-authorized
   environment. Local S3Mock results do not close this gate; resumable multipart
   uploads remain deferred.
3. Obtain the owner's copy sign-off on the actual buyer/creator screens, including
   an open draft, delivered, completed and paused states at mobile and desktop
   widths. Provisional copy approval does not replace this check.
4. Only after these gates and explicit owner enablement approval, enable
   `COMMISSION_FULFILLMENT_MODE` consistently on web and worker. Configuration
   rejects fulfilment enabled with files disabled. Keep retention `report_only`.

Verify a healthy fulfilment scan and the durable resume observation before
accepting activation. Production auditing is read-only; synthetic production
orders or uploads require separate owner authorization. This runbook does not
authorize any gate or switch change.

## Fulfilment states and commands

| State | Behaviour |
| --- | --- |
| `in_progress` | Paid; slot occupied. Parties can send messages and the creator can send a draft or final when fulfilment is enabled. |
| `delivered` | A final with 1–20 clean files has committed; slot stays occupied. The buyer can accept or request changes before the effective deadline. The creator cannot submit another draft or final. |
| `completed` | Terminal; thread is read-only. Completion releases the occupied slot exactly once, together with the order event and outbox evidence. |

Approving a draft uses no revision round. Requesting changes requires a note and
uses one round from the locked allowance; a final change request returns the
order to `in_progress` and clears its delivery/review timestamps. A new draft or
final supersedes an unanswered draft without using a round. Exhausted rounds
still allow messages while the thread is writable. Sent messages are append-only.
Only the buyer and creator can read the private thread and files; the owner role
has no private-content access.

`reviewEndsAt = deliveredAt + reviewWindowDays × 24 h` uses the locked terms.
`completionDueAt` is the effective deadline after recorded pause grace. Buyer
final responses expire at `now >= completionDueAt`, even if the worker has not
completed the order yet. Completion records `buyer_accepted` or
`review_window_elapsed`; both paths check the completion-hold port inside the
transaction. The I7 hold implementation returns false. Delivery lateness is a
marker against immutable `dueAt`; it causes no automatic refund or cancellation.
Fulfilment never writes payment intents or moves money.

Submit and respond commands carry `expectedVersion`; a `version_conflict` needs
a refreshed detail view before a new command. For `dependency_unavailable` on
these commands, check the deployed wrapped HTTP runtime and role-specific OIDC
registry: creator submit is `orders.commission_submit`, buyer respond is
`orders.commission_respond`, both with `fresh: false`. Messages and file grants
use their own service authorization rather than this command registry.
Messages also have a per-actor, per-order `COMMISSION_MESSAGE_LIMIT` (default 60
per `COMMISSION_RATE_WINDOW_SECONDS`, default 3,600 seconds), in addition to the
existing account/network command limits. A 429 can come from either layer.

## Pause and recovery

1. Set intake disabled to stop new requests, quotes and acceptance. Private
   history, package drafts and authorized unpaid close commands remain available.
2. Set payments disabled if instructions or confirmations must also stop. Apply
   the same mode across the fleet and wait for old instances to drain; an env
   edit cannot stop an already running instance. SePay ingress is separate.
3. Keep the worker running. Commission expiry and eligibility cleanup continue
   with both controls disabled. A pause never extends request, quote or QR TTL.
   Terminal orders do not reopen after resume, a late transfer or a retry.
4. Recover DB/queue dependencies and restart the same verified revision. Inspect
   cleanup freshness, expiry backlog and outbox retry health. A busy eligibility
   fence is deferred and revisited after the scan cursor wraps; it is not proof
   that the participant is ineligible. Do not release slots by editing rows.

Page/package intake pause does not invalidate an existing lawful payment.
Account replacement, suspension and security holds hide/block pending affected
payments immediately; cleanup then closes unpaid orders and releases reservations.
Paid orders retain their financial record, occupied slot and delivery obligation.

### Fulfilment pause and resume

1. Set `COMMISSION_FULFILLMENT_MODE=disabled` consistently across web and worker;
   replace/drain old instances. This stops new messages, submissions, buyer
   responses and automatic completion. Private history remains readable; file
   grants depend separately on `COMMISSION_FILES_MODE`.
2. Keep the worker running and its `commission_fulfillment` scan healthy. Each
   scan observes the mode even while disabled. It opens one durable pause when
   disabled and closes it when enabled, under a database advisory lock. The
   timestamps record worker observation, not the time an environment value was
   edited. Confirm `pawket_commission_fulfillment_paused=1` after the off
   observation; an unhealthy scan can leave pause observation incomplete.
3. A pause that covers the effective review deadline removes that deadline while
   open. When the worker observes resume, the affected buyer gets 48 hours after
   that recorded resume to respond; automatic completion waits until then. A
   later pause covering the adjusted deadline extends it to that pause's end
   plus another 48 hours. Pauses ending at or before the deadline or starting
   after it do not extend it. Request, quote, QR and delivery deadlines are unchanged.
4. Resume only after recovery and the enablement gates above; files must be
   enabled first. Confirm the durable pause closed,
   `pawket_commission_fulfillment_paused=0`, fresh scan success and recovered
   buyer controls. A bounded completion scan revisits waiting/held orders after
   its cursor wraps; do not force them to complete.

**`commission_fulfillment_pauses` must never be edited by hand.** Never insert,
close, backdate or delete a pause through SQL. Recover mode observation through
the verified worker; its append-only pause history defines buyer deadlines.

## Payment exceptions

Inspect only the creator's authorized private detail and purpose-labelled SePay
review queue. Manual confirmation needs exact amount, reference and bank evidence,
recent authentication and enrolled TOTP. A buyer's claim is not confirmation.
Shared physical-account cutover includes tips and commissions. Provider-bound
commissions require fresh scoped provider readback and `sepay_optional`; they
cannot use offline manual confirmation. Global payment disable also blocks review.

Wrong/partial/excess/late transfers, reused evidence and unmatched references
remain exceptions. Never move evidence to another tip/order, force a state to
paid, reopen an expired order or label cancellation as refunded. Dismissal in
SePay review does not resolve money. Use the separately approved support and I8
process before admitting live payments. I7 completion is not a refund action;
post-payment cancellation/refund handling remains an I8 gate. Do not collect raw
bank data or briefs in operational tickets or logs.

## Telemetry and retention

`pawket_commission_cleanup_configured` stays on during pauses.
`commission_cleanup` scan health and last-success time cover expiry, invalidation
and a read-only aggregate report. The report has a five-second SQL budget, exposes
no identifiers or decrypted content, and cannot modify data. Each worker allows
one scan in flight and drains it at shutdown.

- `PawketCommissionCleanupUnhealthy`: missing, unhealthy or stale cleanup for five
  minutes. Check dependencies and `commission_cleanup_failed`; never enable
  payments to repair this alert.
- `PawketCommissionExpiryDelayed`: an unpaid closing deadline is over fifteen
  minutes behind for five minutes. Inspect worker health, lock contention and
  bounded batch settings. Expired QR remains unusable before cleanup catches up.
- `PawketCommissionDeliveryOverdue`: paid orders remain beyond their recorded
  dueAt for an hour. This is a review signal, not proof of delivery failure or
  an automatic refund. Stage B completion requires a final delivery and buyer
  acceptance or expiry of its effective review deadline.

### Fulfilment health and first checks

`PawketCommissionFulfillmentUnhealthy` is critical. When
`pawket_commission_fulfillment_configured=1`, it fires after five minutes without
both `pawket_worker_scan_healthy{scan="commission_fulfillment"}=1` and a last
successful scan less than 900 seconds old. Missing scan series also qualify.
The configured gauge stays 1 while fulfilment is disabled, because pause
observation must still run. A deliberate pause alone must not fire this alert.

1. Check worker revision, readiness and Prometheus scrape health; confirm one
   current worker and consistent non-secret switch values across the fleet.
2. Check database connectivity, migrations 0041–0044 and lock contention, plus
   queue/worker health. Inspect the fixed log category
   `commission_fulfillment_failed`; do not collect private payloads.
3. Check the scan health/last-success series and the paused gauge against durable
   pause observation. The scan runs every `COMMISSION_SCAN_INTERVAL_MS`
   (default 60,000 ms), with one scan in flight, drained on shutdown. Enabled
   scans observe the mode then complete a bounded page using
   `COMMISSION_SCAN_BATCH_SIZE` (default 100); disabled scans only observe.
4. Recover dependencies and restart the same verified Stage B revision if
   needed. Confirm fresh successful scans and the expected pause state. Never
   enable fulfilment to clear an alert or edit rows to bypass a hold/deadline.

For read-only pause diagnosis, this aggregate exposes no row identifiers or
private content:

```sql
SELECT count(*) FILTER (WHERE ended_at IS NULL) AS open_pauses,
       min(started_at) FILTER (WHERE ended_at IS NULL) AS open_pause_started_at,
       max(ended_at) AS last_resume_observed_at
FROM commission_fulfillment_pauses;
```

`pawket_commission_orders_current{state=~"delivered|completed"}` and
`pawket_commission_completions{kind=~"buyer_accepted|review_window_elapsed"}`
are inventory gauges, not event counters.
`pawket_commission_completion_backlog` counts delivered orders past their
original `reviewEndsAt`, including orders waiting for pause grace or a hold;
a nonzero value alone does not prove automatic completion failed.
`pawket_commission_late_deliveries` counts late final submissions and
`pawket_commission_submissions{kind=~"draft|final"}` counts submissions.
These aggregate gauges come from the separate `commission_cleanup` report;
check its freshness too.

Lifecycle/expiry gauges, overdue count and operation outcomes use fixed labels.
Never add user/order IDs, references, bank details or private text as labels.
Global outbox retry alerts also cover commission technical consumers; validation
failure leaves the event unacknowledged. Commission events do not send tip email.

Retention inventory reports unaccepted requests closed at least 90 days ago and
all accepted orders separately. The 90 days is a proposed inventory cutoff, not
an approved deletion schedule. Every reported record remains protected; no
commission dataset is added to the enforcement sweep. Do not minimize/delete
briefs, snapshots, payment evidence or history even if global retention is enabled.
Evidence holds must survive any future policy adoption; I6 authorizes no hold
release or deletion. Report-only operation continues during payment pauses.

## Rollback

Before any commission catalog, order or event records exist, use only an I5
binary/schema combination that passed the rolling-overlap rehearsal. Retain the
additive schema. After any such records exist, I5 is unsafe even with intake
disabled: use a last-known-good revision that understands commission purpose,
or forward fix.
Pause intake and payments, preserve evidence and drain writers. Never down-migrate,
drop tables or delete events to make an old binary start. Production auditing is
read-only unless a separate owner instruction authorizes mutations.

For Stage B, rollback is forward-only once any `delivered` or `completed` row
exists. Every replacement web/worker revision must understand those states,
their thread/submission events and migrations 0041–0044. An older worker must
never process them, even with switches disabled. Pause fulfilment consistently
and keep a compatible worker observing the pause; pause intake/payments too when
the incident requires it. Preserve all records and pause history, then fix
forward. Never down-migrate or change states, reservations, files or events to
make an older revision start.
