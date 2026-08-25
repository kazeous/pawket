# Owner MFA break-glass

This is an offline one-shot procedure. There is no web reset endpoint.

1. Freeze creator review and reconciliation, open an incident, and identify the exact owner user ID.
2. Independently prove control of the repository-owner account and Coolify/host administrator account. Store reference IDs, not credentials or recovery material.
3. Wait 24 hours from authorization. Only an active refund deadline permits the fixed `active_refund_deadline` emergency reason; document why waiting would worsen the liability.
4. From a trusted administrative host, verify the reviewed source revision and run `pnpm recover:owner-mfa -- --user-id=... --incident-id=... --repo-proof=... --host-proof=... --authorized-at=... --revision=... --confirm=RECOVER_OWNER_MFA:<user-id>:<incident-id>`.
5. Require success showing sessions revoked and re-enrollment required. A refusal is fail-closed; do not edit the database manually.
6. Sign in normally, immediately enroll a new TOTP factor and recovery-code set, then establish a fresh MFA-authenticated owner session.
7. Confirm the immutable audit event and security-email disposition. Verify the owner role was neither granted nor transferred, then close the incident with both evidence references.
