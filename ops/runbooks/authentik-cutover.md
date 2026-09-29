# Authentik cutover

Use the exact reviewed candidate SHA and approved provider contract. This runbook
does not assert that production acceptance, backup or recovery has already passed.

## Preconditions

- Verify actual email inbox/signed callback, primary/TOTP, silent checks,
  backchannel revocation, disable/recovery, outage and two-client SSO. Synthetic
  tests do not satisfy these provider gates.
- Verify that every authentik user type admitted by the Pawket application can
  open the configured account portal and manage credentials and TOTP. Authentik
  2025.10.3 rejected an External fixture at /if/user/#/settings with an
  internal-users-only message; the current policy admits External users. Resolve
  this mismatch and test a fresh buyer before activation.
- Apply `deploy/authentik/pawket-enrollment-v1.yaml` after `pawket-flows-v1.yaml`.
  It adds Pawket-only sign-up and password reset to the Pawket login stage.
  Set the Turnstile secret on the `pawket-turnstile-v1` captcha stage (never in
  Git); until then captcha fails closed. On 2025.10.3 the admin edit form saves
  the stage but silently drops the private key, so set it in the authentik
  server container with a hidden prompt:
  `ak shell -c "import getpass; from authentik.stages.captcha.models import CaptchaStage as C; s=C.objects.get(name='pawket-turnstile-v1'); s.private_key=getpass.getpass('Turnstile secret: ').strip(); s.save(); print('saved len', len(s.private_key))"`
  (expect 35). A dummy token posted to the flow must then fail with "Invalid
  captcha response", not "Failed to validate token" (siteverify rejected the
  secret or was unreachable). Verify a fresh
  sign-up (inactive until the email link, Internal, no groups, one buyer in
  Pawket, one verification mail) and a reset that ends the user's other IdP
  sessions and Pawket sessions before activation.
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

## Consistent cutover backup

The dedicated Coolify Pawket volume backup is
`6l6bns9ntlazj6zczumwlz4m` for `u1uutbkhr7anco5v9mzmroh5_postgres-data`.
Its yearly schedule is disabled. It is configured to stop containers during
archive, keep a local copy, upload to the connected AWS S3 Backup destination
(`coolify-vm-kazeous`), and retain local and S3 copies for 31 days. No cutover
archive exists merely because this configuration is saved.

After draining authenticated writes and stopping old issuers/workers, trigger
this backup manually. Coolify's stopped-container archive can restart services
afterward: recheck and stop every old web issuer and delivery worker again
before migration or starting the new binary. Verify the execution completed,
the local archive and the S3 object are present, and record their time,
size/checksum, immutable
storage references and actual retention deadline without exposing archive
contents. Restore a copy into an isolated database/volume and check migration
count, user/owner and commerce row counts before citing it in the cutover
marker. The volume archive is not a pg_dump; never restore it over the live
production volume for a rehearsal. Keep writes stopped through the archive's
consistency window, then proceed with the controlled migration.

Set rollback-until to an actual UTC timestamp seven days after cutover and
backup-retained-until to the verified archive's retention date at least 30
days after archive creation. If upload, restore or retention cannot be proven,
do not apply the cutover marker or merge a binary that can start the new SSO
runtime without these gates.

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
