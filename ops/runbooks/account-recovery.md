# Account recovery

1. Use only the normal single-use password-reset and verified-email paths. Support must never request passwords, TOTP seeds, recovery codes, session tokens, or provider tokens.
2. Email ownership alone does not reset or bypass TOTP. A recovery code may restore access only through the product’s existing factor-reset flow, which revokes other sessions and requires factor re-enrollment.
3. Do not manually link/unlink social identities or change canonical email in PostgreSQL.
4. For suspected abuse, preserve bounded throttle evidence and use fixed outcomes; never add email, IP, user agent, or account identifiers to metric labels.
5. If the sole owner loses every factor, use the separate owner break-glass runbook. Normal users have no hidden administrative bypass.
