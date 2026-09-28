# Authentik cutover

Use the exact reviewed candidate SHA and approved provider contract. This runbook
does not assert that production acceptance, backup or recovery has already passed.

## Preconditions

- Verify actual email inbox/signed callback, primary/TOTP, silent checks,
  backchannel revocation, disable/recovery, outage and two-client SSO. Synthetic
  tests do not satisfy these provider gates.
- Rehearse additive migrations, backup restore, owner pin, cutover and recovery on
  isolated synthetic data. Keep IDs, roles and all commerce/audit references.
- Record operator, acceptance, backup/restore and recovery evidence references,
  UTC rollback deadline and backup retention deadline (at least as long).
- Configure exact issuer/client/revision, callback, logout URL and web secret;
  worker receives public provider metadata only. Keep commerce modes unchanged.
- A verified active owner must have a pinned, unexpired link invitation for this
  provider, or a completed mapping. Use `link-owner-oidc.mjs` to dry-run then create
  an exclusive 0600 invitation in a private Linux ephemeral directory. Submit it
  at `/auth/owner-link`; never print it or place it in a URL.

## Commands and order

The web image contains `dist/ops/cutover-oidc.mjs` and
`dist/ops/link-owner-oidc.mjs` under `/app`. Required cutover environment is
`DATABASE_URL`, `APP_REVISION`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
`OIDC_PROVIDER_REVISION`. It needs no client secret or historical credential key.

```text
node dist/ops/cutover-oidc.mjs --owner-user-id OWNER_ID --operator OPERATOR_REF --acceptance ACCEPTANCE_REF --backup RESTORE_REF --recovery RECOVERY_REF --revision CANDIDATE_SHA --rollback-until ISO_UTC --backup-retained-until ISO_UTC
```

Default is a database read-only dry run. It validates owner readiness and absence
of active legacy email-delivery leases, returning only bounded row counts. Before
apply, quiesce authenticated mutations, drain requests, stop every old web issuer
and drain/stop its delivery workers. Do not overlap legacy and SSO issuers. An
expired lease does not prove an SMTP call has stopped; verify the worker stop.

Append `--apply --old-issuers-stopped --confirm CUTOVER_OIDC:CLIENT_ID:CANDIDATE_SHA`
only after those steps. Bounded table locks protect an atomic transition that
revokes existing sessions, consumes proofs/challenges/pending commands, retires
unsent legacy credential emails with audit dispositions, and records an immutable
cutover marker and owner audit with provider/evidence/retention dates.

No user, credential, role, session or commerce history is deleted. Identical
retries are idempotent; conflicting evidence refuses. Lock/database errors roll
back. After an ambiguous CLI failure inspect the marker/audit before retrying.

Start SSO web/worker, complete the pinned owner browser link and verify the same
owner ID plus fresh primary/TOTP. Database guards reject new/reactivated legacy
sessions and new legacy verification/social-link challenges after cutover. The
provider/client sidecar is checked at commit so SSO minting stays atomic. These
guards supplement stopping old binaries.

Verify public routes, login, logout/revoke-all, owner/admin, lease expiry and
pending-action review. Callback must never perform business work. Record deployed
source/build SHA and keep production evidence separate from local results.

## Rollback and retention

Before cutover use only a rehearsed preparation binary with expanded schema and
fresh sessions. After cutover use a verified SSO-compatible binary or forward fix.
The credential baseline cannot issue sessions through the guard. Do not remove
the marker, down-migrate history, restore revoked cookies or invent passwords for
IdP-only users. If no safe binary/provider exists, keep authenticated functions
unavailable while restoring SSO and serving public pages.

Preserve historical hashes/factor material with restricted access through the
recorded rollback window. Purge requires separate authorization after that
deadline. Verify backup retention at the backup system: the marker records an
operator attestation, not remote enforcement. Follow `owner-mfa-break-glass.md`
for owner recovery.
