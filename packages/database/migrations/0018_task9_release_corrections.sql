CREATE TABLE "system_retention_holds" (
	"dataset" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason_category" text NOT NULL,
	"reference_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "system_retention_holds_dataset_check" CHECK ("system_retention_holds"."dataset" in ('provisional_accounts', 'verifications', 'sessions', 'security_throttles', 'receiving_accounts', 'application_content')),
	CONSTRAINT "system_retention_holds_subject_type_check" CHECK ("system_retention_holds"."subject_type" in ('user', 'verification', 'session', 'security_throttle', 'receiving_account', 'creator_application')),
	CONSTRAINT "system_retention_holds_reason_category_check" CHECK ("system_retention_holds"."reason_category" in ('incident', 'legal')),
	CONSTRAINT "system_retention_holds_release_check" CHECK ("system_retention_holds"."released_at" is null or "system_retention_holds"."released_at" > "system_retention_holds"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "creator_application_revisions" DROP CONSTRAINT "creator_application_revisions_minimized_check";--> statement-breakpoint
CREATE UNIQUE INDEX "system_retention_holds_active_subject_uidx" ON "system_retention_holds" USING btree ("dataset","subject_type","subject_id") WHERE "system_retention_holds"."released_at" is null;--> statement-breakpoint
ALTER TABLE "creator_application_revisions" ADD CONSTRAINT "creator_application_revisions_minimized_check" CHECK (
    ("creator_application_revisions"."minimized_at" is not null
      and "creator_application_revisions"."artist_display_name" is null
      and "creator_application_revisions"."short_introduction" is null
      and "creator_application_revisions"."applicant_email" is null
      and "creator_application_revisions"."dob_envelope" is null
      and "creator_application_revisions"."portfolio_urls" is null
      and "creator_application_revisions"."primary_art_discipline" is null
      and "creator_application_revisions"."practice_description" is null
      and "creator_application_revisions"."content_intent" is null
      and "creator_application_revisions"."proposed_receiving_account_id" is null)
    or ("creator_application_revisions"."minimized_at" is null and "creator_application_revisions"."submitted_at" is null)
    or ("creator_application_revisions"."minimized_at" is null
      and "creator_application_revisions"."submitted_at" is not null
      and "creator_application_revisions"."artist_display_name" is not null
      and "creator_application_revisions"."short_introduction" is not null
      and "creator_application_revisions"."applicant_email" is not null
      and "creator_application_revisions"."dob_envelope" is not null
      and "creator_application_revisions"."portfolio_urls" is not null
      and "creator_application_revisions"."primary_art_discipline" is not null
      and "creator_application_revisions"."practice_description" is not null
      and "creator_application_revisions"."content_intent" is not null
      and "creator_application_revisions"."proposed_receiving_account_id" is not null
      and "creator_application_revisions"."age_at_submission" is not null
      and "creator_application_revisions"."age_evaluated_on" is not null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payments_reject_receiving_account_binding_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND OLD.minimized_at IS NULL
		AND NEW.minimized_at IS NOT NULL
		AND NEW.account_number_envelope IS NULL
		AND NEW.account_holder_label_envelope IS NULL
		AND ROW(OLD.id, OLD.onboarding_id, OLD.applicant_user_id, OLD.version,
			OLD.bank_bin, OLD.bank_name, OLD.masked_suffix, OLD.account_fingerprint,
			OLD.proof_state, OLD.proof_verified_at, OLD.retired_at, OLD.created_at)
			IS NOT DISTINCT FROM ROW(NEW.id, NEW.onboarding_id, NEW.applicant_user_id, NEW.version,
			NEW.bank_bin, NEW.bank_name, NEW.masked_suffix, NEW.account_fingerprint,
			NEW.proof_state, NEW.proof_verified_at, NEW.retired_at, NEW.created_at)
	THEN
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' OR ROW(
		OLD.id, OLD.onboarding_id, OLD.applicant_user_id, OLD.version,
		OLD.bank_bin, OLD.bank_name, OLD.account_number_envelope,
		OLD.account_holder_label_envelope, OLD.masked_suffix,
		OLD.account_fingerprint, OLD.created_at
	) IS DISTINCT FROM ROW(
		NEW.id, NEW.onboarding_id, NEW.applicant_user_id, NEW.version,
		NEW.bank_bin, NEW.bank_name, NEW.account_number_envelope,
		NEW.account_holder_label_envelope, NEW.masked_suffix,
		NEW.account_fingerprint, NEW.created_at
	) THEN
		RAISE EXCEPTION 'payments receiving account versions are immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
