# Owner MFA break-glass

This is an offline one-shot procedure. There is no web reset endpoint. Recovery
is unavailable while `OWNER_MFA_RECOVERY_MODE=disabled` and must remain disabled
until an owner-approved acceptance record and a completed rehearsal exist.

Setting `OWNER_MFA_RECOVERY_MODE=external_manual`,
`OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE=<bounded-record-reference>`, and
`OWNER_MFA_RECOVERY_REHEARSED_AT=<ISO-8601-offset-timestamp>` is itself a
privileged external deployment action. The acceptance reference and rehearsal
timestamp must be supplied through the deployment environment; the recovery
command cannot create or change them. The acceptance reference must match
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$` exactly; whitespace, control characters,
non-ASCII characters, and other punctuation keep recovery unavailable.

1. Freeze creator review and reconciliation, open an incident, and identify the exact owner user ID.
2. Have the operators attest to control of the repository-owner account and Coolify/host administrator account under the accepted external procedure. Store bounded reference IDs, not credentials or recovery material. Pawket records these attestations; it does not independently verify either control.
3. Record the operator-supplied authorization start time and wait 24 hours. Only an operator-attested active refund deadline permits the fixed `active_refund_deadline` emergency reason; document why waiting would worsen the liability. Pawket validates the supplied timestamp and fixed reason but does not independently verify when authorization began or whether the emergency need exists.
4. From a trusted administrative host, verify the reviewed source revision and run `pnpm recover:owner-mfa -- --user-id=... --incident-id=... --repo-proof=... --host-proof=... --authorized-at=... --revision=... --confirm=RECOVER_OWNER_MFA:<user-id>:<incident-id>`.
5. Exit `0` means recovery completed and database cleanup succeeded. Exit `3` with `DATABASE_CLOSE_FAILED` means recovery already committed/completed but closing the database client failed: do not rerun or describe it as refused/rolled back; preserve the fixed warning, verify the immutable audit and security-email state, and investigate the administrative process/host. Exit `1` remains a recovery refusal; if it also carries the fixed cleanup warning, preserve the refusal code and investigate cleanup separately. Do not edit the database manually.
6. Sign in normally, immediately enroll a new TOTP factor and recovery-code set, then establish a fresh MFA-authenticated owner session.
7. Confirm the immutable audit event records the fixed `external_manual_controls` category, accepted-control reference, rehearsal timestamp, and bounded operator attestations. Confirm the security-email disposition and verify the owner role was neither granted nor transferred, then close the incident with both attestation references.
