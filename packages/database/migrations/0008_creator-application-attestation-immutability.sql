CREATE OR REPLACE FUNCTION creator_reject_submitted_attestation_mutation() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "creator_application_revisions"
    WHERE "id" = OLD."revision_id" AND "submitted_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'submitted creator application attestations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER creator_application_attestations_immutable
BEFORE UPDATE OR DELETE ON "creator_application_attestations"
FOR EACH ROW EXECUTE FUNCTION creator_reject_submitted_attestation_mutation();
