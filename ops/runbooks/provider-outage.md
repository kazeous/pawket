# Provider outage

Identify the provider first; preserve PostgreSQL as the authority.

- SMTP: committed business state remains valid. Monitor pending/oldest/attention email gauges, restore the sender, and let unsent handoffs retry. Never replay sent handoffs blindly.
- Google or Discord: disable only the affected login path if needed. Password and other configured identity paths continue; never bypass MFA or link identities manually.
- HIBP: password-changing operations fail closed when the production check is unavailable. Do not disable the compromised-password control to clear a queue.
- PostgreSQL: web and worker readiness must fail. Stop mutations and recover the database before queue work.
- Valkey: outbox rows remain authoritative. Restore Valkey/worker, then dispatch using outbox IDs as job IDs; do not reconstruct events from logs.

After recovery, verify worker poll timestamps, backlog ages, failed jobs, email dispositions, refund deadlines, and revision attestation. Record provider incident ID and UTC window without credentials or PII.
