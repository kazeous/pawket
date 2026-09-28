# Account recovery

1. Use recovery and email verification at the configured reyuuGAMES authentik account portal. Pawket credential APIs return `410 AUTH_MOVED`; old Pawket email links cannot reset or verify anything. Support must never request passwords, TOTP seeds, recovery codes, session tokens, or provider tokens.
2. Email ownership alone does not reset or bypass TOTP. Complete approved recovery and factor re-enrollment at authentik. Recovery/static/WebAuthn evidence does not satisfy Pawket's TOTP requirement. Revoke IdP sessions, then establish fresh primary and enrolled TOTP evidence before owner or sensitive actions.
3. Preserve the issuer/UUID subject and local user ID. Do not merge by email or change canonical email in PostgreSQL. After recovery use Pawket security settings to revoke all local sessions, then log in again. Verify backchannel revocation and the maximum five-minute lease independently.
4. For suspected abuse, preserve bounded throttle evidence and use fixed outcomes; never add email, IP, user agent, or account identifiers to metric labels.
5. If the sole owner loses every factor, use the separate owner break-glass runbook. Normal users have no hidden administrative bypass.
