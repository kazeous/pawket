CREATE TABLE "system_retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_version" text NOT NULL,
	"mode" text NOT NULL,
	"dataset" text NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	"candidate_count" integer NOT NULL,
	"protected_count" integer NOT NULL,
	"processed_count" integer NOT NULL,
	"outcome" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "system_retention_runs_mode_check" CHECK ("system_retention_runs"."mode" in ('report_only', 'enforce')),
	CONSTRAINT "system_retention_runs_dataset_check" CHECK ("system_retention_runs"."dataset" in ('provisional_accounts', 'verifications', 'sessions', 'receiving_accounts', 'application_content', 'security_throttles')),
	CONSTRAINT "system_retention_runs_outcome_check" CHECK ("system_retention_runs"."outcome" in ('completed', 'paused', 'failed')),
	CONSTRAINT "system_retention_runs_counts_check" CHECK ("system_retention_runs"."candidate_count" >= 0 and "system_retention_runs"."protected_count" >= 0 and "system_retention_runs"."processed_count" >= 0 and "system_retention_runs"."processed_count" <= "system_retention_runs"."candidate_count"),
	CONSTRAINT "system_retention_runs_time_check" CHECK ("system_retention_runs"."completed_at" >= "system_retention_runs"."started_at")
);
--> statement-breakpoint
ALTER TABLE "payments_receiving_account_onboarding" ALTER COLUMN "account_number_envelope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments_receiving_account_onboarding" ALTER COLUMN "account_holder_label_envelope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_application_revisions" ADD COLUMN "minimized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments_receiving_account_onboarding" ADD COLUMN "minimized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "system_retention_runs_started_idx" ON "system_retention_runs" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "creator_application_revisions" ADD CONSTRAINT "creator_application_revisions_minimized_check" CHECK ("creator_application_revisions"."minimized_at" is null or ("creator_application_revisions"."applicant_email" is null and "creator_application_revisions"."dob_envelope" is null and "creator_application_revisions"."portfolio_urls" is null and "creator_application_revisions"."short_introduction" is null and "creator_application_revisions"."primary_art_discipline" is null and "creator_application_revisions"."practice_description" is null and "creator_application_revisions"."content_intent" is null and "creator_application_revisions"."proposed_receiving_account_id" is null));--> statement-breakpoint
ALTER TABLE "payments_receiving_account_onboarding" ADD CONSTRAINT "payments_receiving_account_minimized_check" CHECK (("payments_receiving_account_onboarding"."minimized_at" is null and "payments_receiving_account_onboarding"."account_number_envelope" is not null and "payments_receiving_account_onboarding"."account_holder_label_envelope" is not null)
        or ("payments_receiving_account_onboarding"."minimized_at" is not null and "payments_receiving_account_onboarding"."account_number_envelope" is null and "payments_receiving_account_onboarding"."account_holder_label_envelope" is null));