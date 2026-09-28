# Owner account recovery through authentik

Pawket has no local factor reset or fallback credential path. The retired
`recover:owner-mfa` command refuses before reading config or connecting to the
DB. Recovery retains the same authentik UUID subject and local owner ID; the
owner-link command cannot transfer an existing mapping.

1. Freeze sensitive owner work and open an incident. Identify the existing owner
   ID and issuer/subject using authorized metadata without exporting tokens.
2. Follow owner-approved external manual controls: attest repository-owner and
   host-administrator control, record bounded evidence references, and observe
   the accepted 24-hour waiting period. Only the accepted, documented active
   refund-deadline exception may shorten it. Pawket does not independently verify
   external attestations or perform authentik recovery for the operator.
3. Keep `OIDC_OWNER_RECOVERY_MODE=disabled` until acceptance and rehearsal exist.
   `external_manual` requires `OIDC_OWNER_RECOVERY_ACCEPTANCE_REFERENCE` and
   `OIDC_OWNER_RECOVERY_REHEARSED_AT` in trusted deployment config. These fields
   record readiness; they grant no credential or MFA bypass.
4. Recover the existing account at authentik through its approved administrator
   procedure. Re-enroll TOTP, revoke prior IdP sessions and verify backchannel
   results. Never mark email verified or invent primary/TOTP timestamps.
5. Log in with fresh primary/TOTP. Verify the same owner ID, subject mapping and
   role. In Pawket security settings choose “Đăng xuất mọi phiên Pawket”; this
   revokes sessions/proofs/pending actions, advances the local access revision
   and fences in-flight callbacks. Log in again to verify access.
6. Verify old browsers cannot mutate, including when backchannel is dropped: the
   IdP lease expires within five minutes from the start of its last accepted
   transaction. Recovery evidence alone must fail owner actions; only fresh
   primary plus TOTP passes.
7. Record incident/provider-event/audit references and UTC times. Confirm roles
   and commerce history were preserved, then reopen owner work.

If the existing subject cannot be recovered, stop and escalate the identity
conflict. Do not create a replacement owner, merge by email, edit mappings in SQL
or reactivate historical sessions. Public pages can continue during recovery.
