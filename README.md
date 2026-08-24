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

- Non-secret variables: `APP_ENV=production`, `APP_REVISION`, `APP_BASE_URL`,
  `AUTH_TRUSTED_ORIGINS`, `PII_ACTIVE_KEY_ID`, `SECURITY_EMAIL_ADAPTER=smtp`,
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`,
  `VERIFICATION_DEPOSIT_AMOUNT_VND`, `VN_BUSINESS_CALENDAR_VERSION`,
  `VN_BUSINESS_HOLIDAYS`, and the explicit `AUTH_*` lifetime and lockout values.
  `APP_REVISION` is the exact deployed commit SHA. The business-calendar version
  and holiday list are immutable inputs used to compute the 5–7 business-day
  verification-transfer refund window.
- Secrets: `DATABASE_URL`, `VALKEY_URL`, `METRICS_TOKEN`, `POSTGRES_DB`,
  `POSTGRES_USER`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRETS`,
  `PII_KEYRING_JSON`, `PII_LOOKUP_HMAC_KEY`, `BOOTSTRAP_OWNER_EMAIL`, and the
  `OPERATING_BANK_*` values, plus `SMTP_USERNAME` and `SMTP_PASSWORD`. The
  PostgreSQL URL and the three PostgreSQL
  bootstrap values must describe the same database and credentials.
  `METRICS_TOKEN` must contain at least 32 characters. Keep retired PII keys in
  the keyring until all matching envelopes have been rotated.

`BETTER_AUTH_SECRETS` uses Better Auth's native comma-separated versioned format,
with the current key first, for example `2:<current>,1:<previous>`. Versions must
be unique non-negative integers and secret values must contain 32–512 characters.

Google and Discord OAuth are optional. Enable either provider only by setting
both its client ID and client secret; leaving both blank disables it. Phone and
SMS verification are intentionally absent from Increment 2 and require a later
system addition.

The release sequence is part of the topology: healthy PostgreSQL starts the
`migrate` service, and that one-shot service must complete successfully before
Coolify starts web or worker or shifts traffic. Use
`/api/health/ready` as the traffic health gate. `/api/metrics` is private and
requires `Authorization: Bearer <METRICS_TOKEN>`; never expose or log the
token.

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
