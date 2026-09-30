CREATE TABLE "identity_oidc_logout_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"jti_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_oidc_logout_events_expiry_check" CHECK ("identity_oidc_logout_events"."expires_at" > "identity_oidc_logout_events"."received_at")
);
--> statement-breakpoint
CREATE TABLE "identity_oidc_owner_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"subject" text NOT NULL,
	"provider_revision" text NOT NULL,
	"invitation_hash" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_oidc_owner_links_expiry_check" CHECK ("identity_oidc_owner_links"."expires_at" > "identity_oidc_owner_links"."approved_at" and "identity_oidc_owner_links"."expires_at" <= "identity_oidc_owner_links"."approved_at" + interval '1 hour')
);
--> statement-breakpoint
CREATE TABLE "identity_oidc_pending_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"authorization_version" integer NOT NULL,
	"action_class" text NOT NULL,
	"command_digest" text NOT NULL,
	"payload_envelope" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_oidc_pending_commands_version_check" CHECK ("identity_oidc_pending_commands"."authorization_version" > 0),
	CONSTRAINT "identity_oidc_pending_commands_expiry_check" CHECK ("identity_oidc_pending_commands"."expires_at" > "identity_oidc_pending_commands"."created_at" and "identity_oidc_pending_commands"."expires_at" <= "identity_oidc_pending_commands"."created_at" + interval '10 minutes'),
	CONSTRAINT "identity_oidc_pending_commands_payload_check" CHECK (("identity_oidc_pending_commands"."consumed_at" is null and "identity_oidc_pending_commands"."payload_envelope" is not null) or ("identity_oidc_pending_commands"."consumed_at" is not null and "identity_oidc_pending_commands"."payload_envelope" is null))
);
--> statement-breakpoint
CREATE TABLE "identity_oidc_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"revoked_through" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_oidc_revocations_kind_check" CHECK ("identity_oidc_revocations"."kind" in ('sid', 'sub'))
);
--> statement-breakpoint
CREATE TABLE "identity_oidc_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"client_id" text NOT NULL,
	"provider_revision" text NOT NULL,
	"sid" text NOT NULL,
	"primary_method" text NOT NULL,
	"totp_status" text NOT NULL,
	"evidence_verified_at" timestamp with time zone NOT NULL,
	"lease_started_at" timestamp with time zone NOT NULL,
	"idp_valid_until" timestamp with time zone NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "identity_oidc_sessions_primary_method_check" CHECK ("identity_oidc_sessions"."primary_method" in ('password', 'source')),
	CONSTRAINT "identity_oidc_sessions_totp_status_check" CHECK ("identity_oidc_sessions"."totp_status" in ('enrolled', 'not_enrolled', 'unknown')),
	CONSTRAINT "identity_oidc_sessions_lease_check" CHECK ("identity_oidc_sessions"."idp_valid_until" > "identity_oidc_sessions"."lease_started_at" and "identity_oidc_sessions"."idp_valid_until" <= "identity_oidc_sessions"."lease_started_at" + interval '5 minutes' and "identity_oidc_sessions"."evidence_verified_at" >= "identity_oidc_sessions"."lease_started_at")
);
--> statement-breakpoint
CREATE TABLE "identity_oidc_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"verifier_envelope" jsonb,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"provider_revision" text NOT NULL,
	"expected_user_id" text,
	"expected_session_id" text,
	"expected_authorization_version" integer,
	"expected_subject" text,
	"action_class" text,
	"command_digest" text,
	"return_path" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "identity_oidc_transactions_purpose_check" CHECK ("identity_oidc_transactions"."purpose" in ('login', 'lease_check', 'step_up', 'owner_link')),
	CONSTRAINT "identity_oidc_transactions_status_check" CHECK ("identity_oidc_transactions"."status" in ('pending', 'exchanging', 'consumed', 'failed')),
	CONSTRAINT "identity_oidc_transactions_deadline_check" CHECK ("identity_oidc_transactions"."expires_at" > "identity_oidc_transactions"."created_at" and "identity_oidc_transactions"."expires_at" <= "identity_oidc_transactions"."created_at" + interval '10 minutes'),
	CONSTRAINT "identity_oidc_transactions_actor_check" CHECK (("identity_oidc_transactions"."purpose" = 'login' and "identity_oidc_transactions"."expected_user_id" is null and "identity_oidc_transactions"."expected_session_id" is null and "identity_oidc_transactions"."expected_subject" is null and "identity_oidc_transactions"."expected_authorization_version" is null)
    or ("identity_oidc_transactions"."purpose" = 'owner_link' and "identity_oidc_transactions"."expected_user_id" is not null and "identity_oidc_transactions"."expected_subject" is not null and "identity_oidc_transactions"."expected_authorization_version" is not null and "identity_oidc_transactions"."expected_authorization_version" > 0)
    or ("identity_oidc_transactions"."purpose" in ('lease_check', 'step_up') and "identity_oidc_transactions"."expected_user_id" is not null and "identity_oidc_transactions"."expected_session_id" is not null and "identity_oidc_transactions"."expected_subject" is not null and "identity_oidc_transactions"."expected_authorization_version" is not null and "identity_oidc_transactions"."expected_authorization_version" > 0)),
	CONSTRAINT "identity_oidc_transactions_action_check" CHECK ("identity_oidc_transactions"."purpose" <> 'step_up' or ("identity_oidc_transactions"."action_class" is not null and "identity_oidc_transactions"."command_digest" is not null)),
	CONSTRAINT "identity_oidc_transactions_processing_check" CHECK (("identity_oidc_transactions"."status" = 'pending' and "identity_oidc_transactions"."claimed_at" is null and "identity_oidc_transactions"."completed_at" is null and "identity_oidc_transactions"."verifier_envelope" is not null)
    or ("identity_oidc_transactions"."status" = 'exchanging' and "identity_oidc_transactions"."claimed_at" is not null and "identity_oidc_transactions"."completed_at" is null and "identity_oidc_transactions"."verifier_envelope" is not null)
    or ("identity_oidc_transactions"."status" in ('consumed', 'failed') and "identity_oidc_transactions"."completed_at" is not null and "identity_oidc_transactions"."verifier_envelope" is null))
);
--> statement-breakpoint
ALTER TABLE "identity_accounts" DROP CONSTRAINT "identity_accounts_provider_issuer_check";--> statement-breakpoint
ALTER TABLE "identity_oidc_owner_links" ADD CONSTRAINT "identity_oidc_owner_links_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD CONSTRAINT "identity_oidc_pending_commands_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD CONSTRAINT "identity_oidc_pending_commands_session_id_identity_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" ADD CONSTRAINT "identity_oidc_sessions_session_id_identity_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" ADD CONSTRAINT "identity_oidc_sessions_account_id_identity_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" ADD CONSTRAINT "identity_oidc_sessions_transaction_id_identity_oidc_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "identity_oidc_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_transactions" ADD CONSTRAINT "identity_oidc_transactions_expected_user_id_identity_users_id_fk" FOREIGN KEY ("expected_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_transactions" ADD CONSTRAINT "identity_oidc_transactions_expected_session_id_identity_sessions_id_fk" FOREIGN KEY ("expected_session_id") REFERENCES "identity_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_oidc_logout_events_jti_uidx" ON "identity_oidc_logout_events" USING btree ("issuer","client_id","jti_hash");--> statement-breakpoint
CREATE INDEX "identity_oidc_logout_events_expiry_idx" ON "identity_oidc_logout_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_oidc_owner_links_invitation_uidx" ON "identity_oidc_owner_links" USING btree ("invitation_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_oidc_owner_links_pending_user_uidx" ON "identity_oidc_owner_links" USING btree ("user_id") WHERE "identity_oidc_owner_links"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "identity_oidc_pending_commands_expiry_idx" ON "identity_oidc_pending_commands" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_oidc_revocations_subject_uidx" ON "identity_oidc_revocations" USING btree ("issuer","client_id","kind","subject_key");--> statement-breakpoint
CREATE INDEX "identity_oidc_sessions_account_sid_idx" ON "identity_oidc_sessions" USING btree ("account_id","client_id","sid");--> statement-breakpoint
CREATE INDEX "identity_oidc_sessions_lease_idx" ON "identity_oidc_sessions" USING btree ("idp_valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_oidc_transactions_state_uidx" ON "identity_oidc_transactions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "identity_oidc_transactions_expiry_idx" ON "identity_oidc_transactions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "identity_accounts" ADD CONSTRAINT "identity_accounts_provider_issuer_check" CHECK (("identity_accounts"."provider_id" = 'credential' and "identity_accounts"."issuer" = 'local:credential')
        or ("identity_accounts"."provider_id" = 'google' and "identity_accounts"."issuer" = 'https://accounts.google.com')
        or ("identity_accounts"."provider_id" = 'discord' and "identity_accounts"."issuer" = 'https://discord.com')
        or ("identity_accounts"."provider_id" = 'authentik' and "identity_accounts"."issuer" like 'https://%' and "identity_accounts"."password_hash" is null and "identity_accounts"."password_hash_version" is null));