CREATE TABLE "payments_receiving_account_onboarding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"onboarding_id" uuid NOT NULL,
	"applicant_user_id" text NOT NULL,
	"version" integer NOT NULL,
	"bank_bin" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number_envelope" jsonb NOT NULL,
	"account_holder_label_envelope" jsonb NOT NULL,
	"masked_suffix" text NOT NULL,
	"account_fingerprint" text NOT NULL,
	"proof_state" text DEFAULT 'unverified' NOT NULL,
	"proof_verified_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_receiving_account_version_check" CHECK ("payments_receiving_account_onboarding"."version" > 0),
	CONSTRAINT "payments_receiving_account_bank_bin_check" CHECK ("payments_receiving_account_onboarding"."bank_bin" ~ '^\d{6}$'),
	CONSTRAINT "payments_receiving_account_mask_check" CHECK ("payments_receiving_account_onboarding"."masked_suffix" ~ '^•••• [0-9]{4}$'),
	CONSTRAINT "payments_receiving_account_fingerprint_check" CHECK ("payments_receiving_account_onboarding"."account_fingerprint" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payments_receiving_account_proof_state_check" CHECK ("payments_receiving_account_onboarding"."proof_state" in ('unverified', 'challenge_issued', 'sent_reported', 'verified')),
	CONSTRAINT "payments_receiving_account_proof_time_check" CHECK (("payments_receiving_account_onboarding"."proof_state" = 'verified' and "payments_receiving_account_onboarding"."proof_verified_at" is not null)
        or ("payments_receiving_account_onboarding"."proof_state" <> 'verified' and "payments_receiving_account_onboarding"."proof_verified_at" is null)),
	CONSTRAINT "payments_receiving_account_retired_check" CHECK ("payments_receiving_account_onboarding"."retired_at" is null or "payments_receiving_account_onboarding"."retired_at" >= "payments_receiving_account_onboarding"."created_at")
);
--> statement-breakpoint
ALTER TABLE "payments_receiving_account_onboarding" ADD CONSTRAINT "payments_receiving_account_onboarding_applicant_user_id_identity_users_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receiving_account_lineage_version_uidx" ON "payments_receiving_account_onboarding" USING btree ("onboarding_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receiving_account_current_applicant_uidx" ON "payments_receiving_account_onboarding" USING btree ("applicant_user_id") WHERE "payments_receiving_account_onboarding"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "payments_receiving_account_applicant_idx" ON "payments_receiving_account_onboarding" USING btree ("applicant_user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_receiving_account_fingerprint_idx" ON "payments_receiving_account_onboarding" USING btree ("account_fingerprint");
