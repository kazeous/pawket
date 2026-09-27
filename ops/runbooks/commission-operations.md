# Commission operations — Increment 6

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

This release ends at paid / in progress. Real commission intake remains gated by
accepted I7 delivery, I8 dispute/refund handling, owner-approved policy text,
retention and support ownership. SePay retains all I5 provider contract gates.
This runbook does not authorize activation, credentials or a real transfer.
Money goes directly to the creator; no platform wallet or escrow.

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
process before admitting live payments. I6 has no fulfillment completion/refund
action. Do not collect raw bank data or briefs in operational tickets or logs.

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
  an automatic refund. I6 cannot record fulfillment completion.

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
