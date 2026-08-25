ALTER TABLE "creator_application_revisions" DROP CONSTRAINT "creator_application_revisions_minimized_check";--> statement-breakpoint
ALTER TABLE "creator_application_revisions" ADD CONSTRAINT "creator_application_revisions_minimized_check" CHECK ("creator_application_revisions"."minimized_at" is null or ("creator_application_revisions"."artist_display_name" is null and "creator_application_revisions"."applicant_email" is null and "creator_application_revisions"."dob_envelope" is null and "creator_application_revisions"."portfolio_urls" is null and "creator_application_revisions"."short_introduction" is null and "creator_application_revisions"."primary_art_discipline" is null and "creator_application_revisions"."practice_description" is null and "creator_application_revisions"."content_intent" is null and "creator_application_revisions"."proposed_receiving_account_id" is null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_reject_submitted_revision_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."submitted_at" IS NOT NULL
    AND OLD."minimized_at" IS NULL
    AND NEW."minimized_at" IS NOT NULL
    AND NEW."artist_display_name" IS NULL
    AND NEW."applicant_email" IS NULL
    AND NEW."dob_envelope" IS NULL
    AND NEW."portfolio_urls" IS NULL
    AND NEW."short_introduction" IS NULL
    AND NEW."primary_art_discipline" IS NULL
    AND NEW."practice_description" IS NULL
    AND NEW."content_intent" IS NULL
    AND NEW."proposed_receiving_account_id" IS NULL
    AND ROW(OLD."id", OLD."application_id", OLD."revision_number", OLD."age_at_submission", OLD."age_evaluated_on", OLD."submitted_at", OLD."created_at")
      IS NOT DISTINCT FROM
      ROW(NEW."id", NEW."application_id", NEW."revision_number", NEW."age_at_submission", NEW."age_evaluated_on", NEW."submitted_at", NEW."created_at")
    AND EXISTS (
      SELECT 1 FROM "creator_applications"
      WHERE "id" = OLD."application_id" AND "state" IN ('withdrawn', 'rejected')
    )
  THEN
    RETURN NEW;
  END IF;
  IF OLD."submitted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'submitted creator application revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payments_reject_receiving_account_binding_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND OLD.minimized_at IS NULL
		AND NEW.minimized_at IS NOT NULL
		AND OLD.retired_at IS NOT NULL
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
$$;--> statement-breakpoint
CREATE TRIGGER system_retention_runs_immutable
BEFORE UPDATE OR DELETE ON "system_retention_runs"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_control_change();
