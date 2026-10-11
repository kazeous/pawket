# Trust enforcement operations

## Switch and deadlines

`TRUST_ENFORCEMENT_MODE` defaults to `disabled` in web and worker. Enabling commerce or enforcement requires recorded owner approval. Keep both services on the same approved value and revision.

The switch gates new private reports, content hides/restores, owner penalties, appeals and enforcement command checks. Increment 3 page/showcase reporting and triage remain available regardless of this switch. Disabling enforcement does not erase recorded penalties or undo existing identity standing.

Every worker scan records the mode durably in `trust_enforcement_pauses`. Appeal windows are 14 days; a pause inside a window moves its effective deadline to resume time plus 48 hours through `trust_enforcement_effective_deadline`. An open pause defers that deadline. Penalty end dates and the 90-day help-link read window are never extended.

## Expiry and readiness

Maintenance starts immediately and runs every 60 seconds in either mode, with one scan in flight. The default batch is 100 per dataset. An active penalty is eligible when `ends_at <= now`; indefinite suspensions and removals have no automatic expiry. Each penalty ends in its own transaction through `end(..., "expired")`, taking the creator fence, capability, page and user locks before `FOR UPDATE SKIP LOCKED` on the penalty. Standing is recomputed from remaining penalties and the legacy baseline (R9); a legacy suspension/removal is not undone. Restored capabilities are not automatically republished. Actorless standing events use `penalty_expired`.

A failed penalty rolls back independently; others and help cleanup continue. It is retried on a later scan. Expired help sessions (30 minutes) and expired help-link request records are deleted in bounded batches. Links at `read_until` are revoked; tokens are not renewed by maintenance. Session validation already rejects elapsed/revoked links while cleanup catches up.

Worker `/health/ready` includes `trustEnforcementScan`: `not_configured` only without a configured database, `down` before the first success or when the last full success is more than 180 seconds old, otherwise `up`. A configured database with missing scan wiring stays `down`. A partial penalty failure does not renew the last-success timestamp. Shutdown drains an in-flight scan before closing the database.

Metrics use the fixed scan label `trust_enforcement`:

- `pawket_worker_scan_healthy{scan="trust_enforcement"}` is 1 after a complete success and 0 while scanning or after a failure.
- `pawket_worker_last_success_timestamp_seconds{scan="trust_enforcement"}` records the last complete success.
- `PawketTrustEnforcementScanStale` is a warning after unhealthy maintenance, or a success timestamp at least 900 seconds old, persists for 15 minutes. It mirrors the resolution alert; readiness uses the shorter 180-second threshold.

## Read the queue and investigate

Use the worker revision/health endpoint and authenticated metrics endpoint through the usual operator access. Check database/Valkey connectivity, scrape freshness, migration compatibility and database lock contention. Logs contain fixed categories and counts: `trust_enforcement_completed`, `trust_enforcement_failed`, and `trust_enforcement_penalty_failed` (penalty ID only). Never copy raw exception contents, reason text, email addresses, token hashes, tokens or decrypted envelopes into an incident.

Read-only queue queries, using the application's database search path:

```sql
SELECT count(*) AS due_penalties, min(ends_at) AS oldest_due_at
FROM trust_penalties WHERE state = 'active' AND ends_at <= now();

SELECT id, kind, target, restriction, state, ends_at, version
FROM trust_penalties WHERE state = 'active' AND ends_at <= now()
ORDER BY ends_at, id LIMIT 100;

SELECT count(*) AS expired_sessions FROM trust_help_sessions WHERE expires_at <= now();
SELECT count(*) AS expired_requests FROM trust_help_link_requests WHERE expires_at <= now();
SELECT count(*) AS elapsed_links FROM trust_help_links WHERE revoked_at IS NULL AND read_until <= now();
SELECT started_at, ended_at FROM trust_enforcement_pauses ORDER BY started_at DESC LIMIT 10;
```

Compare counts across successive successful scans. More than one batch may be needed to drain a backlog. For a recurring failed ID, inspect its state/version and associated state events without reading private text; investigate the fixed failure category and lock order. Restore connectivity or deploy a reviewed forward fix, then confirm freshness and declining queue counts. Do not mark penalties expired with direct SQL or bypass normal standing/event updates.

## Help-link support

Locked users receive `/help/locked#t=<token>` through the enforcement notice handoff. The fragment keeps the token out of server/proxy logs. The page exchanges it for the HttpOnly, Secure, SameSite=Strict `pawket_help` cookie, scoped to `/help/locked`, lasting 30 minutes. Appeal use follows the effective 14-day window; the original penalty's read window lasts 90 days and is not extended by a resend or switch pause.

Resend only through the help form. The owner never sends tokens by hand, extracts a token from storage, or asks a user to paste a token into support. The form gives the same response for all outcomes, with limits of 3 requests per address HMAC per 24 hours and 10 per network HMAC per hour. If delivery fails, investigate the security email handoff's fixed status/failure code and verified destination availability without disclosing addresses or secrets. An elapsed read window cannot be reopened by manually issuing a link.

## Rollback

Once a penalty exists, recovery is forward-only. Keep expand-only migrations and recorded penalties/events; never roll back the schema, delete enforcement history or deploy a revision that cannot interpret it. With owner approval, `TRUST_ENFORCEMENT_MODE=disabled` can pause gated commands and appeal deadlines, while penalty expiry and help cleanup must keep running. Use the supported owner lift/appeal-decision commands to change standing, with their proof, audit and idempotency requirements. A worker rollback must retain this maintenance wiring and compatible identity/penalty ports. After any deploy, check health, revision agreement and scan freshness; full production audits follow the owner's final-audit schedule.
