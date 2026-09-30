# reyuuGAMES Account branding

Users see "reyuuGAMES Account", never authentik. Target authentik 2025.10.3 at
`https://account.reyuugames.com`. Nothing here touches Pawket data or the OIDC
provider contract.

## Preconditions

- The authentik server and worker both mount persistent `/media` and
  `/templates` volumes. The server serves `/media/`. Templates must exist
  wherever a blueprint is validated or an email is rendered, so both containers
  need them.
- Record the current brands before changing anything:
  `ak shell -c "from authentik.brands.models import Brand; [print(b.domain, b.default, repr(b.branding_title), b.branding_logo, b.branding_favicon, repr(b.branding_custom_css)) for b in Brand.objects.all()]"`
  Continue only if there is exactly one default brand and no other brand
  whose domain matches `account.reyuugames.com`, because a matching brand would
  take precedence. The blueprint replaces `branding_custom_css`: merge any
  existing rules into `reyuugames-brand-v1.yaml` first. Keep this output for
  rollback.

## Apply

1. Copy `deploy/authentik/media/public/reyuugames/` to
   `/media/public/reyuugames/` and `deploy/authentik/templates/reyuugames/` to
   `/templates/reyuugames/`. They must be readable by the authentik user.
   `https://account.reyuugames.com/media/public/reyuugames/reyuu-account-logo.png`
   and `.../favicon-64.png` must return 200 `image/png`. In the server and the
   worker,
   `ak shell -c "from authentik.stages.email.models import get_template_choices as g; print(sorted(c for c, _ in g() if c.startswith('reyuugames/')))"`
   must list `reyuugames/account_confirmation.html` and
   `reyuugames/password_reset.html`. If they are missing, the Pawket blueprints
   are rejected.
2. Set the sender display name on the server and worker, keeping the existing
   address: `AUTHENTIK_EMAIL__FROM=reyuuGAMES Account <existing-address>`.
   Redeploy authentik. Never put SMTP credentials in Git.
3. Re-apply `pawket-flows-v1.yaml`, then `pawket-enrollment-v1.yaml`, in the
   same way as at cutover. Then apply `reyuugames-brand-v1.yaml`.
   Re-applying keeps the Turnstile secret (`state: created`) and the SMTP
   selection.

## Verify

Use a private window and a synthetic account, never a real user's.

- Sign-in, sign-up and reset pages, plus `/if/user/`: tab title, heading, logo
  and favicon show reyuuGAMES. No "authentik" is visible, including the flow
  footer.
- Sign-up and reset emails arrive from "reyuuGAMES Account" with the
  reyuuGAMES subject, logo and link. Nothing mentions authentik, and each link
  completes its flow.
- A new TOTP enrollment appears as "reyuuGAMES Account" in the authenticator
  app.
- Pawket `/sign-in` and `/settings/security` name the reyuuGAMES account.

## Rollback

Restore the recorded brand fields, set the previous `AUTHENTIK_EMAIL__FROM`
and re-apply the previous revisions of the two Pawket blueprints. Those use
authentik's built-in templates, so they validate even without `/templates`.

## After every authentik upgrade

authentik's own default blueprints reset the default flows' titles to
"Welcome to authentik!" whenever an upgrade changes them, so re-apply
`reyuugames-brand-v1.yaml` and open `https://account.reyuugames.com/` in a
private window. The footer rule `:host(ak-brand-links) li:last-child` depends
on authentik's internal markup, and custom templates depend on the
`/templates` lookup. Recheck the footer, the template listing and one test
email. Known residue
that cannot be changed without replacing authentik internals: cookie and
storage names, the logo's alt text ("authentik Logo"), the static error page
footer (`if/error.html`), startup/outage pages, the admin interface, and
authenticator entries enrolled before the rename.
