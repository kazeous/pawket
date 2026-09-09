# Creator publication operations

## Detection

Investigate a web or worker readiness failure, `PawketIncrementThreeWorkerScanUnhealthy`, source/build revision mismatch, unexpected creator-route visibility, or a failed synthetic creator journey. Confirm both services report the exact intended revision and that deployment configuration still says `CREATOR_PUBLISHING_MODE=disabled`.

## Safe evidence to collect

Record deployment ID, source/build revision, publishing and retention modes, web and worker readiness, neutral public-route result, bounded Catalog/media/report metrics, latest successful cleanup scan time, and the activation-packet references. Use synthetic creator/content identifiers for rehearsal. Do not record profile copy, report detail, payment/bank data, signed URLs, object keys, raw network data, session secrets, or private application facts.

## Disabled-mode behavior

Disabled is the release default and safe rollback state. Creator drafts and existing private remediation remain private; public directory, canonical/alias creator routes, sitemap entries, and public media delivery stay closed. Deployment success is not activation approval.

## Retry and recovery

Correct the failing dependency while keeping publishing disabled, rerun `increment-three:validate`, verify web and worker readiness, then run the synthetic nonfinancial journey against the exact revision. Activation requires a complete external acceptance packet, owner authorization, storage/readiness evidence, report-operator rehearsal, policy acceptance, and a separate explicit instruction to use `general_audience`.

## Rollback

Set or retain the reviewed disabled configuration and redeploy the last known-good exact revision. Require source/build equality on web, worker, and migration images. Preserve drafts, immutable publication revisions, aliases, reports, holds, and audit history; rollback must not manufacture, rewrite, or delete domain state.

## Escalation

Stop the release and escalate to the owner for any missing acceptance row, revision mismatch, direct-port exposure, untrusted ingress, storage/privacy/versioning failure, stale worker scan, unresolved Critical/Important finding, or observed financial mutation. Policy, retention enforcement, creator onboarding, and production activation each require their own recorded authorization.

## Forbidden actions

- Do not change `CREATOR_PUBLISHING_MODE` to diagnose a release.
- Do not bypass `increment-three:validate` or fabricate acceptance references.
- Do not make buckets public, add a CDN, or weaken exact-origin CORS.
- Do not publish, unpublish, suspend, reinstate, or edit publication rows manually.
- Do not introduce payments, commissions, tips, escrow, or platform-held value.
- Do not enable public-media retention enforcement without its separate accepted rows and an unpaused global retention gate.
