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
- Both Pawket blueprints need the reyuuGAMES email templates in `/templates`
  first; see `authentik-branding.md`.
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
- Sign with an RSA-2048 key (`pawket-oidc-signing-rsa2048-v1`), not authentik's
  generated RSA-4096 default. Authentik 2025.10.3 loads and validates the key on
  every token, JWKS and discovery request; on the aarch64 host that took
  1284 ms for 4096 bits against 179 ms for 2048, and under load token requests
  crossed Pawket's 5 s OIDC timeout. Pawket pins RS256, so an EC key needs a
  code change first. The admin UI only generates RSA-4096; create the key in
  the authentik server container:
  `ak shell -c "from authentik.crypto.builder import CertificateBuilder; from cryptography.hazmat.primitives.asymmetric import rsa; b=CertificateBuilder('pawket-oidc-signing-rsa2048-v1'); b.generate_private_key=lambda: rsa.generate_private_key(public_exponent=65537, key_size=2048); b.build(validity_days=3650); c=b.save(); print('created', c.name, 'bits', c.private_key.key_size)"`
  Then set it as the provider's signing key and check that JWKS lists one
  2048-bit RS256 key.
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

## Approved Coolify order

A Coolify compose deploy always runs `migrate`, then `web`, then `worker`; it has no
build-only or migrate-only step. The owner approved deploying first and applying
the pin and marker immediately afterwards. The SSO runtime never accepts legacy
sessions (it requires the OIDC session sidecar), never sends legacy credential
email (the worker retires those purposes), and the owner cannot sign in before
the pin. The only pre-marker exposure is new-buyer sign-in, whose sessions the
marker revokes. Rehearsed on isolated linux/arm64 images in both orders.

1. Set the Pawket application's Auto deploy to "Manual deployments only" and
   confirm it saved. Merge the PR and confirm Coolify started no deployment.
2. Drain and back up as above. If the backup restarts the old containers, stop
   them again. Keep the application stopped until the isolated restore check
   passes.
3. Deploy the release (merge) commit manually. Confirm `migrate` exited 0, 37
   migrations, and web readiness reports the release SHA as `revision`.
4. Straight away, in the web container terminal, run the owner-link dry run and
   apply (invitation file under `/tmp`, mode 0600, never printed), then the
   cutover dry run and apply. `--revision` and both confirmations use the
   release SHA, which is the deployed `APP_REVISION`, not the PR head.
5. Complete the owner browser link, then R6 acceptance.

Rollback before the marker: deploy `891244f` (or the current baseline) manually;
the baseline was rehearsed on the expanded schema. Coolify keeps no rollback
images for this application, so this is a rebuild of about 3–4 minutes.

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

## Second-factor claims

Merge the owner interactive-login fix (PR #29) first. Apply PR A's updated
`deploy/authentik/pawket-flows-v1.yaml` in authentik, run the owner gate below,
and only then merge and deploy Pawket PR B (including migration 0039). Merging
PR A does not apply the blueprint or change Pawket's runtime.

The mapping keeps contract version 1, policy `pawket-v1`, and the legacy
`totp_enrolled` / `totp_at` claims. New `mfa_enrolled` / `mfa_at` claims count
only confirmed TOTP and WebAuthn devices belonging to the user and validated
in the session's actual login event. Passwordless passkey login remains
unsupported. Do not log tokens, credentials or private device material.

The owner approved this two-stage gate on 2026-10-04 because the pre-PR-B
Pawket runtime reads only legacy TOTP claims and refuses passkey-only owner
second-factor evidence.

Before PR B, use the updated OIDC probe from PR B's reviewed candidate
(`corepack pnpm exec tsx scripts/probe-authentik.mjs`) with the approved
provider/client contract. Complete password + passkey and password + TOTP
sign-in and step-up separately. Both must pass signature/protocol validation,
the MFA claim contract and owner freshness checks. Record only bounded verdicts
including enrolled status, MFA proof, provider revision, candidate revision,
time and callback outcomes; never token contents or credentials. Also verify
password + TOTP reaches `/settings/security` on the current deployed Pawket.
Never merge PR B before these pre-deployment checks pass. A provider-only
sign-in or green CI does not satisfy them.

After the controlled PR B deployment, both password + passkey and password +
TOTP must reach Pawket `/settings/security`, and an owner tip-policy step-up
with a passkey must succeed. Record the deployed revision and migration 0039
alongside callback and step-up outcomes. Do not mark live acceptance complete
or remove legacy claims before this post-deployment gate passes.

Migration 0039 renames columns used by the pre-PR-B binary. Before merging
PR B, set Coolify to manual deployments only and verify that it saved. After
the blueprint and owner-approved gate, drain authenticated writes and stop
the old web and worker before running the migration. Verify a consistent,
recoverable backup and record its evidence privately. If the backup restarts
containers, stop the old web and worker again. Keep them stopped until 0039
completes and start only PR B's candidate web and worker. Compose's migration
dependency orders new containers; it does not prove an already running old
binary has stopped. Verify the migration exit status and the deployed source
revision before owner acceptance.

After 0039, the pre-PR-B binary is incompatible with the renamed schema.
Use a compatible forward fix; do not redeploy the old binary, down-migrate
history, restore revoked sessions or restore the backup over live production.
A reverse-rename rollback or live backup restore needs a separately reviewed
procedure and explicit owner authorization. If migration or startup fails,
keep authenticated services stopped until a compatible release is verified.

After any authentik upgrade, re-check the login-event device serialization,
confirmed-device filtering, `auth_time` correspondence and `amr: mfa`, then
repeat password + passkey and password + TOTP acceptance. Unknown or missing
second-factor claims fail closed. After PR B deploys, read-only acceptance
also covers owner tip-policy step-up with a passkey, health/revision, logs
and migration 0039. Remove the legacy mapping claims in a separate cleanup
PR only after that acceptance passes.
