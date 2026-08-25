ALTER TABLE "creator_applications" DROP CONSTRAINT "creator_applications_state_check";--> statement-breakpoint
ALTER TABLE "creator_applications" ADD CONSTRAINT "creator_applications_state_check" CHECK ("creator_applications"."state" in ('draft','submitted','under_review','changes_requested','approved','rejected','withdrawn'));--> statement-breakpoint
ALTER TABLE "creator_applications" ADD COLUMN "reviewer_user_id" text;--> statement-breakpoint
ALTER TABLE "creator_applications" ADD COLUMN "review_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_applications" ADD COLUMN "review_claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_applications" ADD CONSTRAINT "creator_applications_reviewer_user_id_identity_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_applications" ADD CONSTRAINT "creator_applications_review_claim_check" CHECK (("state" = 'under_review' and "reviewer_user_id" is not null and "review_claimed_at" is not null and "review_claim_expires_at" > "review_claimed_at") or ("state" <> 'under_review' and "reviewer_user_id" is null and "review_claimed_at" is null and "review_claim_expires_at" is null));--> statement-breakpoint

CREATE TABLE "creator_application_decisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "application_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "action" text NOT NULL,
  "reason_code" text NOT NULL,
  "applicant_explanation" text NOT NULL,
  "private_note" text,
  "actor_user_id" text NOT NULL,
  "actor_session_id" text NOT NULL,
  "step_up_proof_id" uuid NOT NULL,
  "expected_version" integer NOT NULL,
  "request_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "creator_application_decisions_application_id_creator_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "creator_applications"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "creator_application_decisions_revision_id_creator_application_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "creator_application_revisions"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "creator_application_decisions_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "creator_application_decisions_action_check" CHECK ("action" in ('changes_requested','approved','rejected','reopened')),
  CONSTRAINT "creator_application_decisions_reason_check" CHECK ("reason_code" in ('portfolio_insufficient','portfolio_control_unclear','contact_unverified','receiving_account_unverified','content_policy_risk','information_inconsistent','eligibility_not_met','other')),
  CONSTRAINT "creator_application_decisions_text_check" CHECK (length("applicant_explanation") between 1 and 2000 and ("private_note" is null or length("private_note") between 1 and 1000) and "expected_version" > 0)
);--> statement-breakpoint
CREATE INDEX "creator_application_decisions_application_idx" ON "creator_application_decisions" USING btree ("application_id", "created_at");--> statement-breakpoint

CREATE TABLE "identity_creator_capabilities" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "state" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "approved_application_id" uuid NOT NULL,
  "approved_revision_id" uuid NOT NULL,
  "suspended_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "identity_creator_capabilities_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "identity_creator_capabilities_approved_application_id_creator_applications_id_fk" FOREIGN KEY ("approved_application_id") REFERENCES "creator_applications"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "identity_creator_capabilities_approved_revision_id_creator_application_revisions_id_fk" FOREIGN KEY ("approved_revision_id") REFERENCES "creator_application_revisions"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "identity_creator_capabilities_state_check" CHECK ("state" in ('active','suspended')),
  CONSTRAINT "identity_creator_capabilities_version_check" CHECK ("version" > 0),
  CONSTRAINT "identity_creator_capabilities_suspension_check" CHECK (("state" = 'suspended' and "suspended_at" is not null) or ("state" = 'active' and "suspended_at" is null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "identity_creator_capabilities_user_uidx" ON "identity_creator_capabilities" USING btree ("user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION creator_reject_decision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'creator application decisions are append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER creator_application_decisions_append_only
BEFORE UPDATE OR DELETE ON "creator_application_decisions"
FOR EACH ROW EXECUTE FUNCTION creator_reject_decision_mutation();
