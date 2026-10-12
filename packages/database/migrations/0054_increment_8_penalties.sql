CREATE TABLE "trust_penalties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"restriction" text,
	"target" text,
	"state" text DEFAULT 'active' NOT NULL,
	"reason_category" text NOT NULL,
	"explanation_envelope" jsonb NOT NULL,
	"internal_note_envelope" jsonb,
	"source_case_id" uuid,
	"source_public_report_id" uuid,
	"enforcement_policy_revision_id" uuid,
	"replaces_penalty_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"acknowledged_at" timestamp with time zone,
	"owner_user_id" text NOT NULL,
	"owner_session_id" text NOT NULL,
	"step_up_proof_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_penalties_kind_check" CHECK ("trust_penalties"."kind" in ('warning','restriction','suspension','removal')),
	CONSTRAINT "trust_penalties_restriction_check" CHECK ("trust_penalties"."restriction" is null or "trust_penalties"."restriction" in ('commission_intake','commission_buying','dispute_opening','reporting')),
	CONSTRAINT "trust_penalties_target_check" CHECK ("trust_penalties"."target" is null or "trust_penalties"."target" in ('creator_capability','account')),
	CONSTRAINT "trust_penalties_state_check" CHECK ("trust_penalties"."state" in ('active','expired','lifted','reversed','reduced')),
	CONSTRAINT "trust_penalties_reason_check" CHECK ("trust_penalties"."reason_category" in ('spam_or_scam','harassment_or_hate','prohibited_or_age_restricted_content',
    'intellectual_property','privacy','impersonation','refund_non_compliance','dispute_or_report_abuse','other')),
	CONSTRAINT "trust_penalties_shape_check" CHECK (("trust_penalties"."kind" = 'warning' and "trust_penalties"."restriction" is null and "trust_penalties"."target" is null and "trust_penalties"."ends_at" is null)
    or ("trust_penalties"."kind" = 'restriction' and "trust_penalties"."restriction" is not null and "trust_penalties"."target" is null)
    or ("trust_penalties"."kind" = 'suspension' and "trust_penalties"."target" is not null and "trust_penalties"."restriction" is null)
    or ("trust_penalties"."kind" = 'removal' and "trust_penalties"."target" is not null and "trust_penalties"."restriction" is null and "trust_penalties"."ends_at" is null)),
	CONSTRAINT "trust_penalties_source_check" CHECK (num_nonnulls("trust_penalties"."source_case_id", "trust_penalties"."source_public_report_id") = 1),
	CONSTRAINT "trust_penalties_end_time_check" CHECK ("trust_penalties"."ends_at" is null or "trust_penalties"."ends_at" > "trust_penalties"."starts_at"),
	CONSTRAINT "trust_penalties_ended_check" CHECK (("trust_penalties"."state" = 'active') = ("trust_penalties"."ended_at" is null)),
	CONSTRAINT "trust_penalties_acknowledged_check" CHECK ("trust_penalties"."acknowledged_at" is null or "trust_penalties"."kind" = 'warning'),
	CONSTRAINT "trust_penalties_version_check" CHECK ("trust_penalties"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "trust_penalty_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"penalty_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"reason_envelope" jsonb,
	"request_id" text NOT NULL,
	"expected_version" integer NOT NULL,
	"resulting_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_penalty_events_action_check" CHECK ("trust_penalty_events"."action" in ('applied','expired','lifted','reversed','reduced','acknowledged')),
	CONSTRAINT "trust_penalty_events_actor_check" CHECK (("trust_penalty_events"."actor_user_id" is null) = ("trust_penalty_events"."actor_session_id" is null)),
	CONSTRAINT "trust_penalty_events_version_check" CHECK ("trust_penalty_events"."expected_version" >= 0 and "trust_penalty_events"."resulting_version" = "trust_penalty_events"."expected_version" + 1)
);
--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" DROP CONSTRAINT "identity_email_handoffs_purpose_check";--> statement-breakpoint
ALTER TABLE "identity_creator_capabilities" DROP CONSTRAINT "identity_creator_capabilities_state_check";--> statement-breakpoint
ALTER TABLE "identity_creator_capabilities" DROP CONSTRAINT "identity_creator_capabilities_suspension_check";--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" DROP CONSTRAINT "identity_creator_capability_events_action_check";--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" DROP CONSTRAINT "identity_creator_capability_events_state_check";--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ALTER COLUMN "actor_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ALTER COLUMN "step_up_proof_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ADD COLUMN "penalty_id" uuid;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_subject_user_id_identity_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_source_case_id_trust_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "trust_cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_source_public_report_id_public_content_reports_id_fk" FOREIGN KEY ("source_public_report_id") REFERENCES "public_content_reports"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_enforcement_policy_revision_id_trust_policy_revisions_id_fk" FOREIGN KEY ("enforcement_policy_revision_id") REFERENCES "trust_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_replaces_penalty_id_trust_penalties_id_fk" FOREIGN KEY ("replaces_penalty_id") REFERENCES "trust_penalties"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalty_events" ADD CONSTRAINT "trust_penalty_events_penalty_id_trust_penalties_id_fk" FOREIGN KEY ("penalty_id") REFERENCES "trust_penalties"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_penalty_events" ADD CONSTRAINT "trust_penalty_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "trust_penalties_subject_idx" ON "trust_penalties" USING btree ("subject_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_penalties_active_restriction_uidx" ON "trust_penalties" USING btree ("subject_user_id","restriction") WHERE "trust_penalties"."state" = 'active' and "trust_penalties"."kind" = 'restriction';--> statement-breakpoint
CREATE UNIQUE INDEX "trust_penalties_active_suspension_uidx" ON "trust_penalties" USING btree ("subject_user_id","target") WHERE "trust_penalties"."state" = 'active' and "trust_penalties"."kind" = 'suspension';--> statement-breakpoint
CREATE UNIQUE INDEX "trust_penalties_active_removal_uidx" ON "trust_penalties" USING btree ("subject_user_id","target") WHERE "trust_penalties"."state" = 'active' and "trust_penalties"."kind" = 'removal';--> statement-breakpoint
CREATE INDEX "trust_penalty_events_penalty_idx" ON "trust_penalty_events" USING btree ("penalty_id","occurred_at");--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ADD CONSTRAINT "identity_creator_capability_events_penalty_id_trust_penalties_id_fk" FOREIGN KEY ("penalty_id") REFERENCES "trust_penalties"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_purpose_check" CHECK ("identity_email_handoffs"."purpose" in ('email_verification', 'password_reset', 'email_change', 'security_notice', 'application_outcome', 'creator_status', 'refund_status', 'tip_status', 'enforcement_notice'));--> statement-breakpoint
ALTER TABLE "identity_creator_capabilities" ADD CONSTRAINT "identity_creator_capabilities_state_check" CHECK ("identity_creator_capabilities"."state" in ('active','suspended','removed'));--> statement-breakpoint
ALTER TABLE "identity_creator_capabilities" ADD CONSTRAINT "identity_creator_capabilities_suspension_check" CHECK (("identity_creator_capabilities"."state" in ('suspended','removed') and "identity_creator_capabilities"."suspended_at" is not null) or ("identity_creator_capabilities"."state" = 'active' and "identity_creator_capabilities"."suspended_at" is null));--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ADD CONSTRAINT "identity_creator_capability_events_actor_check" CHECK (("identity_creator_capability_events"."actor_user_id" is not null and "identity_creator_capability_events"."actor_session_id" is not null and "identity_creator_capability_events"."step_up_proof_id" is not null)
    or ("identity_creator_capability_events"."actor_user_id" is null and "identity_creator_capability_events"."actor_session_id" is null and "identity_creator_capability_events"."step_up_proof_id" is null
      and "identity_creator_capability_events"."action" in ('reinstated','restored') and "identity_creator_capability_events"."reason_code" = 'penalty_expired'));--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ADD CONSTRAINT "identity_creator_capability_events_action_check" CHECK ("identity_creator_capability_events"."action" in ('granted','suspended','reinstated','removed','restored'));--> statement-breakpoint
ALTER TABLE "identity_creator_capability_events" ADD CONSTRAINT "identity_creator_capability_events_state_check" CHECK ("identity_creator_capability_events"."state" in ('active','suspended','removed'));
--> statement-breakpoint
CREATE FUNCTION trust_guard_penalty() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Trust penalties cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.version <> 1 OR NEW.ended_at IS NOT NULL
      OR NEW.end_reason IS NOT NULL OR NEW.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'Trust penalties must start active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 OR
    ROW(NEW.id, NEW.subject_user_id, NEW.kind, NEW.restriction, NEW.target, NEW.reason_category,
      NEW.explanation_envelope, NEW.internal_note_envelope, NEW.source_case_id, NEW.source_public_report_id,
      NEW.enforcement_policy_revision_id, NEW.replaces_penalty_id, NEW.starts_at, NEW.ends_at,
      NEW.owner_user_id, NEW.owner_session_id, NEW.step_up_proof_id, NEW.request_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.subject_user_id, OLD.kind, OLD.restriction, OLD.target, OLD.reason_category,
      OLD.explanation_envelope, OLD.internal_note_envelope, OLD.source_case_id, OLD.source_public_report_id,
      OLD.enforcement_policy_revision_id, OLD.replaces_penalty_id, OLD.starts_at, OLD.ends_at,
      OLD.owner_user_id, OLD.owner_session_id, OLD.step_up_proof_id, OLD.request_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Trust penalty identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'active' AND NEW.state IN ('expired','lifted','reversed','reduced')
    AND NEW.ended_at IS NOT NULL AND NEW.ended_at >= OLD.starts_at
    AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at THEN
    RETURN NEW;
  END IF;
  IF OLD.kind = 'warning' AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL
    AND NEW.acknowledged_at >= OLD.starts_at AND NEW.state = OLD.state
    AND ROW(NEW.ended_at, NEW.end_reason) IS NOT DISTINCT FROM ROW(OLD.ended_at, OLD.end_reason) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid trust penalty transition' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_penalties_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_penalties
FOR EACH ROW EXECUTE FUNCTION trust_guard_penalty();
--> statement-breakpoint
CREATE TRIGGER trust_penalty_events_immutable BEFORE UPDATE OR DELETE ON trust_penalty_events
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
