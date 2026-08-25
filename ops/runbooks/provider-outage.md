# Provider outage

Identify the provider first; preserve PostgreSQL as the authority.

- SMTP: committed business state remains valid and delivery is at least once. A provider may accept a message before Pawket persists `sent_at`, so a lost acknowledgement or crash can produce a duplicate safe notice. Do not infer that a retry means the first send was rejected. Restore the sender and use the domain state plus the stable handoff ID, `sent_at`, attempt count, and attention status as authoritative evidence. Sender exceptions remain retryable for attempts one and two; the third unknown outcome becomes terminal `attention_required`, clears destination/secret envelopes, and keeps `sent_at` unset. That terminal state does not prove rejection: inspect provider-side evidence using the stable handoff ID and incident window, then follow a separately approved remediation. Never replay sent or unknown-outcome handoffs blindly.
- Google or Discord: disable only the affected login path if needed. Password and other configured identity paths continue; never bypass MFA or link identities manually.
- HIBP: password-changing operations fail closed when the production check is unavailable. Do not disable the compromised-password control to clear a queue.
- PostgreSQL: web and worker readiness must fail. Stop mutations and recover the database before queue work.
- Valkey: outbox rows remain authoritative. Restore Valkey/worker, then dispatch using outbox IDs as job IDs; do not reconstruct events from logs.

After recovery, verify worker poll timestamps, backlog ages, failed jobs, email dispositions, refund deadlines, and revision attestation. Record provider incident ID and UTC window without credentials or PII.
