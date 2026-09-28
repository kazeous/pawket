ALTER TABLE "identity_oidc_sessions" ADD COLUMN "user_id" text;--> statement-breakpoint
UPDATE "identity_oidc_sessions" AS oidc SET "user_id" = parent."user_id" FROM "identity_sessions" AS parent WHERE oidc."session_id" = parent."id";--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_accounts_user_id_uidx" ON "identity_accounts" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_user_id_uidx" ON "identity_sessions" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD CONSTRAINT "identity_oidc_pending_commands_actor_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "identity_sessions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" ADD CONSTRAINT "identity_oidc_sessions_actor_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "identity_sessions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" ADD CONSTRAINT "identity_oidc_sessions_account_actor_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "identity_accounts"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_transactions" ADD CONSTRAINT "identity_oidc_transactions_actor_fk" FOREIGN KEY ("expected_user_id","expected_session_id") REFERENCES "identity_sessions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD CONSTRAINT "identity_oidc_pending_commands_envelope_check" CHECK ("identity_oidc_pending_commands"."payload_envelope" is null or coalesce(
  jsonb_typeof("identity_oidc_pending_commands"."payload_envelope") = 'object' and octet_length("identity_oidc_pending_commands"."payload_envelope"::text) <= 24000
  and "identity_oidc_pending_commands"."payload_envelope"->'version' = '1'::jsonb and "identity_oidc_pending_commands"."payload_envelope"->>'algorithm' = 'A256GCM'
  and "identity_oidc_pending_commands"."payload_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "identity_oidc_pending_commands"."payload_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "identity_oidc_pending_commands"."payload_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "identity_oidc_pending_commands"."payload_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "identity_oidc_pending_commands"."payload_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false));--> statement-breakpoint
ALTER TABLE "identity_oidc_transactions" ADD CONSTRAINT "identity_oidc_transactions_verifier_check" CHECK ("identity_oidc_transactions"."verifier_envelope" is null or coalesce(
  jsonb_typeof("identity_oidc_transactions"."verifier_envelope") = 'object' and octet_length("identity_oidc_transactions"."verifier_envelope"::text) <= 24000
  and "identity_oidc_transactions"."verifier_envelope"->'version' = '1'::jsonb and "identity_oidc_transactions"."verifier_envelope"->>'algorithm' = 'A256GCM'
  and "identity_oidc_transactions"."verifier_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "identity_oidc_transactions"."verifier_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "identity_oidc_transactions"."verifier_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "identity_oidc_transactions"."verifier_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "identity_oidc_transactions"."verifier_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false));
