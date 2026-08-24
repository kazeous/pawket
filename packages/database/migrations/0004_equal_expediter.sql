CREATE TABLE "identity_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text DEFAULT 'pawket' NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password_hash" text,
	"password_hash_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_accounts_no_provider_tokens_check" CHECK ("identity_accounts"."access_token" is null and "identity_accounts"."refresh_token" is null and "identity_accounts"."id_token" is null),
	CONSTRAINT "identity_accounts_password_version_check" CHECK (("identity_accounts"."password_hash" is null and "identity_accounts"."password_hash_version" is null)
        or ("identity_accounts"."password_hash" is not null and "identity_accounts"."password_hash_version" is not null and "identity_accounts"."password_hash_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "identity_email_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"destination_envelope" jsonb NOT NULL,
	"secret_envelope" jsonb,
	"template_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_email_handoffs_purpose_check" CHECK ("identity_email_handoffs"."purpose" in ('email_verification', 'password_reset', 'email_change', 'security_notice')),
	CONSTRAINT "identity_email_handoffs_status_check" CHECK ("identity_email_handoffs"."status" in ('pending', 'processing', 'sent', 'failed')),
	CONSTRAINT "identity_email_handoffs_attempts_check" CHECK ("identity_email_handoffs"."attempts" >= 0),
	CONSTRAINT "identity_email_handoffs_lease_check" CHECK (("identity_email_handoffs"."locked_at" is null and "identity_email_handoffs"."locked_by" is null and "identity_email_handoffs"."lease_expires_at" is null)
        or ("identity_email_handoffs"."locked_at" is not null and "identity_email_handoffs"."locked_by" is not null and "identity_email_handoffs"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "identity_security_throttles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"subject_hmac" text NOT NULL,
	"action" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	"risk_level" text DEFAULT 'normal' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_security_throttles_scope_check" CHECK ("identity_security_throttles"."scope" in ('account', 'network')),
	CONSTRAINT "identity_security_throttles_risk_check" CHECK ("identity_security_throttles"."risk_level" in ('normal', 'elevated', 'challenge_required')),
	CONSTRAINT "identity_security_throttles_attempt_count_check" CHECK ("identity_security_throttles"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"network_key" text,
	"user_agent_family" text,
	"user_id" text NOT NULL,
	"assurance_state" text DEFAULT 'provisional' NOT NULL,
	"primary_authenticated_at" timestamp with time zone,
	"mfa_verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"authorization_version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "identity_sessions_assurance_state_check" CHECK ("identity_sessions"."assurance_state" in ('provisional', 'mfa_pending', 'active')),
	CONSTRAINT "identity_sessions_expiry_check" CHECK ("identity_sessions"."expires_at" <= "identity_sessions"."absolute_expires_at"
        and "identity_sessions"."expires_at" <= "identity_sessions"."idle_expires_at"
        and "identity_sessions"."last_used_at" <= "identity_sessions"."idle_expires_at"
        and "identity_sessions"."created_at" < "identity_sessions"."absolute_expires_at"),
	CONSTRAINT "identity_sessions_revocation_check" CHECK (("identity_sessions"."revoked_at" is null and "identity_sessions"."revocation_reason" is null)
        or ("identity_sessions"."revoked_at" is not null and "identity_sessions"."revocation_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "identity_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"canonical_email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"email_verification_provenance" text,
	"image" text,
	"access_status" text DEFAULT 'active' NOT NULL,
	"authorization_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_users_access_status_check" CHECK ("identity_users"."access_status" in ('active', 'access_suspended', 'closed')),
	CONSTRAINT "identity_users_authorization_version_check" CHECK ("identity_users"."authorization_version" > 0),
	CONSTRAINT "identity_users_verification_evidence_check" CHECK (("identity_users"."email_verified" = false and "identity_users"."email_verified_at" is null and "identity_users"."email_verification_provenance" is null)
        or ("identity_users"."email_verified" = true and "identity_users"."email_verified_at" is not null and "identity_users"."email_verification_provenance" in ('password_email_challenge', 'provider_assertion')))
);
--> statement-breakpoint
CREATE TABLE "identity_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text DEFAULT 'better_auth' NOT NULL,
	"user_id" text,
	"target_email_canonical" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_verifications_purpose_check" CHECK ("identity_verifications"."purpose" in ('better_auth', 'email_verification', 'password_reset', 'email_change')),
	CONSTRAINT "identity_verifications_attempt_count_check" CHECK ("identity_verifications"."attempt_count" >= 0),
	CONSTRAINT "identity_verifications_expiry_check" CHECK ("identity_verifications"."expires_at" > "identity_verifications"."created_at")
);
--> statement-breakpoint
ALTER TABLE "identity_accounts" ADD CONSTRAINT "identity_accounts_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_accounts_issuer_account_uidx" ON "identity_accounts" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "identity_accounts_user_idx" ON "identity_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_email_handoffs_pending_idx" ON "identity_email_handoffs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_security_throttles_subject_uidx" ON "identity_security_throttles" USING btree ("scope","subject_hmac","action");--> statement-breakpoint
CREATE INDEX "identity_security_throttles_blocked_idx" ON "identity_security_throttles" USING btree ("blocked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_token_hash_uidx" ON "identity_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "identity_sessions_user_idx" ON "identity_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_sessions_expiry_idx" ON "identity_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_canonical_email_uidx" ON "identity_users" USING btree ("canonical_email");--> statement-breakpoint
CREATE INDEX "identity_verifications_identifier_idx" ON "identity_verifications" USING btree ("identifier_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_token_hash_uidx" ON "identity_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "identity_verifications_user_purpose_idx" ON "identity_verifications" USING btree ("user_id","purpose");
