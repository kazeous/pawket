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

- Non-secret variables: `APP_ENV=production` and `APP_REVISION`, where
  `APP_REVISION` is the exact deployed commit SHA.
- Secrets: `DATABASE_URL`, `VALKEY_URL`, `METRICS_TOKEN`, `POSTGRES_DB`,
  `POSTGRES_USER`, and `POSTGRES_PASSWORD`. The PostgreSQL URL and the three
  PostgreSQL bootstrap values must describe the same database and credentials.
  `METRICS_TOKEN` must contain at least 32 characters.

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
