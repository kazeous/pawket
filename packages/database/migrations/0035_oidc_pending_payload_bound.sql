ALTER TABLE "identity_oidc_pending_commands" DROP CONSTRAINT "identity_oidc_pending_commands_envelope_check";--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD CONSTRAINT "identity_oidc_pending_commands_envelope_check" CHECK ("identity_oidc_pending_commands"."payload_envelope" is null or coalesce(
  jsonb_typeof("identity_oidc_pending_commands"."payload_envelope") = 'object' and octet_length("identity_oidc_pending_commands"."payload_envelope"::text) <= 200000
  and "identity_oidc_pending_commands"."payload_envelope"->'version' = '1'::jsonb and "identity_oidc_pending_commands"."payload_envelope"->>'algorithm' = 'A256GCM'
  and "identity_oidc_pending_commands"."payload_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "identity_oidc_pending_commands"."payload_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "identity_oidc_pending_commands"."payload_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "identity_oidc_pending_commands"."payload_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "identity_oidc_pending_commands"."payload_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false));