CREATE TABLE "identity_external_link_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"return_path" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_external_link_transactions_provider_check" CHECK ("identity_external_link_transactions"."provider" in ('google', 'discord')),
	CONSTRAINT "identity_external_link_transactions_return_path_check" CHECK (char_length("identity_external_link_transactions"."return_path") between 1 and 512
		and "identity_external_link_transactions"."return_path" ~ '^/[A-Za-z0-9/_?=&.%~-]*$'
        and "identity_external_link_transactions"."return_path" !~ '^//'),
	CONSTRAINT "identity_external_link_transactions_status_check" CHECK ("identity_external_link_transactions"."status" in ('pending', 'processing', 'completed', 'conflict', 'expired')),
	CONSTRAINT "identity_external_link_transactions_completion_check" CHECK (("identity_external_link_transactions"."status" = 'pending' and "identity_external_link_transactions"."consumed_at" is null and "identity_external_link_transactions"."result_code" is null)
        or ("identity_external_link_transactions"."status" <> 'pending' and "identity_external_link_transactions"."consumed_at" is not null and "identity_external_link_transactions"."result_code" is not null)),
	CONSTRAINT "identity_external_link_transactions_expiry_check" CHECK ("identity_external_link_transactions"."expires_at" > "identity_external_link_transactions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authenticator_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_recovery_codes_consumed_check" CHECK ("identity_recovery_codes"."consumed_at" is null or "identity_recovery_codes"."consumed_at" >= "identity_recovery_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity_role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"grant_source" text NOT NULL,
	"granted_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_role_grants_role_check" CHECK ("identity_role_grants"."role" = 'owner'),
	CONSTRAINT "identity_role_grants_state_check" CHECK ("identity_role_grants"."state" in ('active', 'revoked')),
	CONSTRAINT "identity_role_grants_source_check" CHECK ("identity_role_grants"."grant_source" = 'bootstrap_cli'),
	CONSTRAINT "identity_role_grants_version_check" CHECK ("identity_role_grants"."version" > 0),
	CONSTRAINT "identity_role_grants_actor_check" CHECK ("identity_role_grants"."grant_source" <> 'bootstrap_cli' or "identity_role_grants"."granted_by_user_id" is null),
	CONSTRAINT "identity_role_grants_revocation_check" CHECK (("identity_role_grants"."state" = 'active' and "identity_role_grants"."revoked_at" is null)
        or ("identity_role_grants"."state" = 'revoked' and "identity_role_grants"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "identity_step_up_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action_class" text NOT NULL,
	"assurance_method" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_step_up_proofs_action_class_check" CHECK ("identity_step_up_proofs"."action_class" ~ '^[a-z][a-z0-9_.-]{2,63}$'),
	CONSTRAINT "identity_step_up_proofs_assurance_method_check" CHECK ("identity_step_up_proofs"."assurance_method" in ('primary', 'totp', 'recovery')),
	CONSTRAINT "identity_step_up_proofs_owner_totp_check" CHECK ("identity_step_up_proofs"."action_class" !~ '^owner[.]' or "identity_step_up_proofs"."assurance_method" = 'totp'),
	CONSTRAINT "identity_step_up_proofs_time_check" CHECK ("identity_step_up_proofs"."expires_at" > "identity_step_up_proofs"."issued_at"
        and ("identity_step_up_proofs"."consumed_at" is null or "identity_step_up_proofs"."consumed_at" >= "identity_step_up_proofs"."issued_at"))
);
--> statement-breakpoint
CREATE TABLE "identity_totp_authenticators" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret_envelope" jsonb NOT NULL,
	"library_backup_codes" text DEFAULT '[]' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_used_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_totp_authenticators_library_backup_codes_check" CHECK ("identity_totp_authenticators"."library_backup_codes" = '[]'),
	CONSTRAINT "identity_totp_authenticators_failure_count_check" CHECK ("identity_totp_authenticators"."failed_verification_count" >= 0),
	CONSTRAINT "identity_totp_authenticators_last_step_check" CHECK ("identity_totp_authenticators"."last_used_step" is null or "identity_totp_authenticators"."last_used_step" >= 0)
);
--> statement-breakpoint
ALTER TABLE "identity_accounts" DROP CONSTRAINT "identity_accounts_no_provider_tokens_check";--> statement-breakpoint
DROP INDEX "identity_verifications_identifier_idx";--> statement-breakpoint
DROP INDEX "identity_verifications_token_hash_uidx";--> statement-breakpoint
ALTER TABLE "identity_accounts" ALTER COLUMN "issuer" SET DEFAULT 'local:credential';--> statement-breakpoint
UPDATE "identity_accounts"
SET "issuer" = 'local:credential'
WHERE "provider_id" = 'credential' AND "issuer" = 'pawket';--> statement-breakpoint
ALTER TABLE "identity_users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_external_link_transactions" ADD CONSTRAINT "identity_external_link_transactions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_external_link_transactions" ADD CONSTRAINT "identity_external_link_transactions_session_id_identity_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity_sessions"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_recovery_codes" ADD CONSTRAINT "identity_recovery_codes_authenticator_id_identity_totp_authenticators_id_fk" FOREIGN KEY ("authenticator_id") REFERENCES "identity_totp_authenticators"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_role_grants" ADD CONSTRAINT "identity_role_grants_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_role_grants" ADD CONSTRAINT "identity_role_grants_granted_by_user_id_identity_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_step_up_proofs" ADD CONSTRAINT "identity_step_up_proofs_session_id_identity_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity_sessions"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_step_up_proofs" ADD CONSTRAINT "identity_step_up_proofs_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_totp_authenticators" ADD CONSTRAINT "identity_totp_authenticators_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_external_link_transactions_state_uidx" ON "identity_external_link_transactions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "identity_external_link_transactions_session_idx" ON "identity_external_link_transactions" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_recovery_codes_authenticator_hash_uidx" ON "identity_recovery_codes" USING btree ("authenticator_id","code_hash");--> statement-breakpoint
CREATE INDEX "identity_recovery_codes_batch_idx" ON "identity_recovery_codes" USING btree ("authenticator_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_role_grants_one_active_owner_uidx" ON "identity_role_grants" USING btree ("role") WHERE "identity_role_grants"."role" = 'owner' and "identity_role_grants"."state" = 'active';--> statement-breakpoint
CREATE INDEX "identity_role_grants_user_idx" ON "identity_role_grants" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "identity_step_up_proofs_session_action_idx" ON "identity_step_up_proofs" USING btree ("session_id","action_class","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_totp_authenticators_user_uidx" ON "identity_totp_authenticators" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_better_auth_identifier_uidx" ON "identity_verifications" USING btree ("identifier_hash") WHERE "identity_verifications"."purpose" = 'better_auth';--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_token_hash_uidx" ON "identity_verifications" USING btree ("token_hash") WHERE "identity_verifications"."purpose" <> 'better_auth';--> statement-breakpoint
ALTER TABLE "identity_accounts" ADD CONSTRAINT "identity_accounts_provider_issuer_check" CHECK (("identity_accounts"."provider_id" = 'credential' and "identity_accounts"."issuer" = 'local:credential')
        or ("identity_accounts"."provider_id" = 'google' and "identity_accounts"."issuer" = 'https://accounts.google.com')
        or ("identity_accounts"."provider_id" = 'discord' and "identity_accounts"."issuer" = 'https://discord.com'));--> statement-breakpoint
ALTER TABLE "identity_accounts" ADD CONSTRAINT "identity_accounts_no_provider_tokens_check" CHECK ("identity_accounts"."access_token" is null
        and "identity_accounts"."refresh_token" is null
        and "identity_accounts"."id_token" is null
        and "identity_accounts"."access_token_expires_at" is null
        and "identity_accounts"."refresh_token_expires_at" is null
        and "identity_accounts"."scope" is null);
