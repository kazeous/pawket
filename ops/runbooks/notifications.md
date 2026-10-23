# Notifications operations

## What the switch gates

`NOTIFICATIONS_MODE` (`disabled` | `enabled`) defaults to `disabled` in web and worker. While disabled:

- no notification rows, reminder ledger rows or notification email handoffs are written;
- the worker builds no notification maintenance (no digest, reminder or retention scan) and reports `notificationScan: "not_configured"`;
- the header bell renders nothing, `/notifications` and `/settings/notifications` return not found, and every `/api/v1/notifications/*` route returns 404 `{ "code": "not_available" }`.

The existing emails (`application_outcome`, `creator_status`, `refund_status`, `tip_status`, `enforcement_notice`, `security_notice`) behave the same in both modes. Domain state never depends on notifications: orders, disputes, refunds and penalties keep their own deadlines, scans and emails.

Enabling never replays past events. The reminder scan does pick up deadlines that are already open, once each (the ledger prevents duplicates). Configuration refuses any `COMMISSION_PAYMENTS_MODE` other than `disabled` unless `NOTIFICATIONS_MODE=enabled` (P9).

## Enabling checklist

1. The owner's approval to enable notifications is recorded (`docs/decisions/active-decisions.md`), with date and revision.
2. SMTP is healthy: the worker runs with `SECURITY_EMAIL_ADAPTER=smtp` and a complete `SMTP_*` configuration, `PawketEmailBacklogWarning`, `PawketEmailBacklogCritical` and `PawketEmailAttentionRequired` are quiet, and a recent security email was delivered.
3. Web and worker run the same revision and both set `NOTIFICATIONS_MODE=enabled`. Change both services together; a mixed pair shows a bell without a scan, or a scan without a bell.
4. After the deploy: the worker readiness body shows `notificationScan: "up"` within two minutes, `pawket_worker_scan_healthy{scan="notification"}` is 1, and the first scan's log line has no `notification_reminder_failed` or `notification_digest_failed` entries.

## What the scan does

The worker runs one maintenance pass every 60 seconds (one in flight, drained on shutdown):

- **Digests.** Unread thread-message items whose `email_due_at` has passed get one email each, at most one per order and recipient per hour (later bursts are deferred to the end of that hour). A digest more than one hour past due (a long outage, or the switch turned back on) is moved to `suppressed` instead of sent; the in-app item stays. Closed accounts and `messages` email opt-outs are suppressed at send time.
- **Reminders.** For each deadline clock (spec section 9) the scan reads pending subjects whose stored deadline is within 24 hours, reads the effective deadline through the owning module (resolution pauses, fulfillment pauses and enforcement pauses), and writes a ledger row in `notification_reminders` keyed by subject, clock, stage and effective deadline before creating the notices. A `due_24h` reminder goes to the acting party, 24 hours before the deadline, unless the clock started less than 36 hours before it. `delivery_due` and `dispute_response` also get a scan-made `deadline_missed` notice to both parties; every other clock's end is announced by its domain event. A pause or owner extension moves the effective deadline and so re-arms a reminder. Appeal-window reminders (content hides and restrictions only) are informational and respect the `moderation` email opt-out; every other reminder is action-required and always emailed.
- **Retention.** Items 90 days after creation and ledger rows 90 days after their effective deadline are deleted, at most one batch (200) of each per pass.

Each digest item and each reminder candidate runs in its own transaction. A failing one is rolled back, counted, logged by id, and retried on the next pass; the rest of the batch continues.

## Metrics, logs and the stale alert

- `pawket_worker_scan_healthy{scan="notification"}` is 1 after a pass with no failures and 0 while a pass runs or after any failure.
- `pawket_worker_last_success_timestamp_seconds{scan="notification"}` records the last pass with no failures.
- `pawket_notification_operations_total{operation,outcome}` counts `digest` (`queued`, `deferred`, `suppressed`, `failed`), `reminder` (`created`, `failed`), `retention` (`deleted`), `email` and `materialize` outcomes. Labels never carry kinds, recipients, links or content.
- Worker readiness reports `notificationScan`: `not_configured` while disabled, `down` before the first full success or when it is more than 180 seconds old, otherwise `up`. It is reported but is not a readiness dependency: a notification problem never takes the worker out of rotation (spec section 14).
- Logs carry fixed categories and ids only: `notification_maintenance_failed` (the pass threw), `notification_digest_failed` (`notificationId`), `notification_reminder_failed` (`clock`, `subjectId`; `subjectId` is null when a whole clock's read failed).

`PawketNotificationScanStale` is a warning when the scan has been unhealthy, or its last full success is at least 900 seconds old, for 15 minutes. It never fires while the switch is disabled, because the series is not published.

When it fires:

1. Check worker revision, readiness and database/Valkey connectivity through the usual operator access.
2. Read the failure categories in the worker log. A recurring `notification_reminder_failed` subject id usually means one subject row the clock reader cannot interpret, or a lock held for a long time; read that subject's state and version without opening private text. A failure with `subjectId: null` means a clock's read itself failed (schema or connectivity).
3. A recurring `notification_digest_failed` id: read that item's `email_state`, `email_due_at`, `read_at` and recipient `access_status`.
4. Restore connectivity or ship a reviewed forward fix; confirm the metric returns to 1. Do not insert ledger rows, mark items read or rewrite `email_state` by hand: the scan is idempotent and catches up by itself.

Read-only queries, using the application's search path:

```sql
SELECT count(*) AS pending_digests, min(email_due_at) AS oldest_due_at
FROM notifications WHERE email_state = 'pending' AND read_at IS NULL;

SELECT clock, stage, count(*) AS rows, max(created_at) AS last_written
FROM notification_reminders GROUP BY clock, stage ORDER BY clock, stage;

SELECT kind, variant, email_state, count(*) FROM notifications
WHERE created_at > now() - interval '1 day' GROUP BY kind, variant, email_state ORDER BY 4 DESC;
```

## A backlog of `attention_required` handoffs

A notification whose recipient has no verified address gets `email_state = 'attention_required'` and an `identity_email_handoffs` row with `purpose = 'notification'`, `status = 'attention_required'` and `failure_code = 'no_verified_destination'`. The in-app item is present; nothing is wrong with the scan. A steady trickle is normal (unverified buyers). A sudden rise means verification or the sender changed:

```sql
SELECT failure_code, count(*) FROM identity_email_handoffs
WHERE purpose = 'notification' AND status = 'attention_required' AND created_at > now() - interval '1 day'
GROUP BY failure_code;
```

SMTP-side failures follow `ops/runbooks/provider-outage.md`: handoffs retry three times and then become terminal `attention_required`. Never replay notification handoffs by hand; a reminder or digest email is a convenience, and the in-app item and the domain page remain the source of truth.

## Disabling

Setting `NOTIFICATIONS_MODE=disabled` in both services is safe at any time and loses no domain state: orders, disputes, refunds, penalties and their own emails are unaffected. The bell and inbox disappear; existing items and ledger rows stay in the database (and age out under retention once re-enabled). On re-enabling, past events are not replayed, open clocks are picked up once, and digests more than one hour overdue are suppressed rather than sent as a backlog. If commission payments are enabled, disabling notifications must be paired with disabling commission payments (configuration refuses the combination).
