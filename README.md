# Pawket

Pawket's platform foundation. The repository currently provides independent
web and worker runtime shells; product capabilities are intentionally deferred.

## Production deployment on Coolify

`compose.prod.yaml` is the production deployment source of truth. It builds
the `web`, `worker`, and one-shot `migrate` targets from the repository
`Dockerfile`, and runs PostgreSQL and Valkey only on the internal Compose
network. Only the web container exposes port 3000 for Coolify's reverse proxy;
the data services publish no host ports.

Configure these required values in Coolify:

- Non-secret variables: `APP_ENV=production`, `APP_BASE_URL`,
  `AUTH_TRUSTED_ORIGINS`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_PROVIDER_REVISION`, `OIDC_ACCOUNT_PORTAL_URL`, `PII_ACTIVE_KEY_ID`, `SECURITY_EMAIL_ADAPTER=smtp`,
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`,
  `VERIFICATION_DEPOSIT_AMOUNT_VND`, `VN_BUSINESS_CALENDAR_VERSION`,
  `VN_BUSINESS_HOLIDAYS`, and the explicit `AUTH_*` session and step-up lifetime values.
  Coolify's predefined `SOURCE_COMMIT` is the exact deployed commit SHA; enable
  **Include Source Commit in Build** and do not maintain a separate manual
  production `APP_REVISION`. The business-calendar version
  and holiday list are immutable inputs used to compute the 5–7 business-day
  verification-transfer refund window.
- Secrets: `DATABASE_URL`, `VALKEY_URL`, `METRICS_TOKEN`, `POSTGRES_DB`,
  `POSTGRES_USER`, `POSTGRES_PASSWORD`, `OIDC_CLIENT_SECRET`,
  `PII_KEYRING_JSON`, `PII_LOOKUP_HMAC_KEY`, `BOOTSTRAP_OWNER_EMAIL`, and the
  `OPERATING_BANK_*` values, plus `SMTP_USERNAME` and `SMTP_PASSWORD`. The
  PostgreSQL URL and the three PostgreSQL
  bootstrap values must describe the same database and credentials.
  `METRICS_TOKEN` must contain at least 32 characters. Keep retired PII keys in
  the keyring until all matching envelopes have been rotated.

Pawket delegates sign-in, email verification, primary authentication and TOTP to
its dedicated authentik client. Use the exact HTTPS per-provider issuer, callback
`APP_BASE_URL/api/v1/auth/oidc/callback` and backchannel logout endpoint
`APP_BASE_URL/api/v1/auth/oidc/backchannel-logout`. Use an RS256 signing key and the
reviewed email/assurance claims contract. Web receives the confidential client
secret; workers receive only issuer, client ID and provider revision. Pawket no
longer has direct social, password or local MFA authentication.

Use `link:owner-oidc` to dry-run a pinned mapping for the existing owner. Apply
requires exact revision/confirmation, evidence references and an exclusive0600
invitation file in the Linux container. Fresh primary authentication and TOTP in
the browser complete the link. It neither grants a role nor merges by email.
The old `recover:owner-mfa` command always refuses; recover at authentik and follow
the audited local session-revocation runbook. `OIDC_OWNER_RECOVERY_*` records the
external recovery acceptance and rehearsal; it enables no local credential path.

Before cutover, complete real provider acceptance, owner binding and rollback
rehearsal. Record rollback deadline, responsible operator and backup retention.
Stop and drain the old credential issuers before activating SSO. Preserve user
IDs, roles, domain references and historical credentials during that window;
purging old credential material is a separate authorized cleanup afterward.
Use `cutover:oidc` for the read-only preflight and audited transition described in
[`ops/runbooks/authentik-cutover.md`](ops/runbooks/authentik-cutover.md). The shared
database marker prevents legacy session issuance after cutover; it does not
replace stopping and draining old web/delivery processes.

Pawket uses hashed opaque session cookies, local roles and a five-minute IdP
lease. Sensitive drafts are encrypted and bound to the original account/session
and exact command. Returning from authentik opens a review; explicit confirmation
is required before a business action. Local logout affects Pawket; account-wide
sign-out belongs to the account portal.

Old reset/verification/change-email jobs are audited as `auth_moved` without
sending or decrypting obsolete links. Drain active delivery leases at cutover.
Business and security notices continue. Worker readiness includes a recent
successful bounded OIDC transient-data cleanup scan.

Security and domain email delivery is durable at least once. The handoff ID is
stable at the sender boundary, but ordinary SMTP has no idempotency guarantee:
if a provider accepts a message before Pawket persists `sent_at`, a lost
acknowledgement or worker crash can cause the same safe notice to be sent again.
PostgreSQL domain state, handoff ID, `sent_at`, attempt count, and attention
status are authoritative; receiving one message is not proof that its related
business transition succeeded or failed.

Provider sends stop after three unknown outcomes. Attempts one and two leave a
fixed retryable `delivery_outcome_unknown`; a third sender exception moves the
handoff to terminal `attention_required`, clears its destination and secret
envelopes, and leaves `sent_at` unset. This limit is reachable within the
system queue's eight exponential job attempts despite the handoff's 60-second
availability delay. The terminal state means delivery is unknown—one or more
messages may already have been accepted—and is not authorization for a blind
replay.

Before rolling out this worker behavior, include unsent nonterminal handoffs
with `attempts >= 3` in the email-delivery preflight. Do not replay or rewrite
them manually. On their next job invocation, the compatible worker atomically
moves rows with no lease or an expired lease to `attention_required` without
decrypting or contacting SMTP; an unexpired processing lease remains owned
until it expires. Existing terminal rows are acknowledged without incrementing
the attention metric again. The three-attempt bound still depends on the
system queue's eight-attempt exponential policy and the handoff's 60-second
availability delay, so review those settings together.

For mixed-revision rollout of creator application outcome events, deploy the
compatible worker before the web/admin producer. The worker accepts the prior
bounded payload while the updated producer adds `decisionAction`; if worker-first
ordering cannot be guaranteed, pause and drain application-outcome events until
both services run the same revision.

The release sequence is part of the topology: healthy PostgreSQL starts the
`migrate` service, and that one-shot service must complete successfully before
Coolify starts web or worker or shifts traffic. Use
`/api/health/ready` as the traffic health gate. `/api/metrics` is private and
requires `Authorization: Bearer <METRICS_TOKEN>`; never expose or log the
token.

The worker exposes internal-only liveness, readiness, and protected metrics on
port 9464. Compose does not publish this port to the host or proxy. Production
readiness fails when the runtime revision differs from the source revision
embedded in the image.

Production runs on Oracle Ampere A1, so release images must be built for
`linux/arm64`. The Dockerfile also supports native local images for validation;
do not publish those local tags as production artifacts.

Database backup and PostgreSQL WAL archiving are deliberately deferred. They
remain an increment-10 go-live requirement and are not provided by this
foundation topology.

Validate the production Compose source locally or in CI after setting the
required variables:

```text
corepack pnpm compose:validate
```

The validator requires exactly one service-level `exclude_from_hc: true` on
the `migrate` service, removes only that Coolify extension in memory, and
streams the projected source to strict Docker Compose validation without
writing rendered configuration to disk. CI and Task 8 must call this command
instead of running `docker compose -f compose.prod.yaml config --quiet`
directly, because strict Docker Compose does not recognize Coolify's extension.

## Verification gate

Pull requests and pushes to `main` run the same release gate defined by
`.github/workflows/verify.yml`: frozen pnpm installation, lint, typecheck, unit
tests, PostgreSQL/Valkey integration tests, application build, Coolify Compose
validation, and cache-only `linux/arm64` builds for the web, worker, and
migration targets. Run the gate locally with the same `corepack pnpm` commands;
Compose validation must go through `corepack pnpm compose:validate` so the
Coolify-only health-check extension remains in the deployment source.
