ALTER TABLE "trust_case_access_log" DROP CONSTRAINT "trust_case_access_log_item_check";--> statement-breakpoint
ALTER TABLE "trust_case_events" DROP CONSTRAINT "trust_case_events_transition_check";--> statement-breakpoint
ALTER TABLE "trust_cases" DROP CONSTRAINT "trust_cases_source_check";--> statement-breakpoint
ALTER TABLE "trust_cases" DROP CONSTRAINT "trust_cases_resolution_check";--> statement-breakpoint
ALTER TABLE "trust_cases" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trust_cases" ADD COLUMN "community_policy_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "trust_cases" ADD COLUMN "enforcement_policy_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_community_policy_revision_id_trust_policy_revisions_id_fk" FOREIGN KEY ("community_policy_revision_id") REFERENCES "trust_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_enforcement_policy_revision_id_trust_policy_revisions_id_fk" FOREIGN KEY ("enforcement_policy_revision_id") REFERENCES "trust_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_case_access_log" ADD CONSTRAINT "trust_case_access_log_item_check" CHECK ("trust_case_access_log"."item_type" in ('order_summary','thread_page','file','resolution_records','refund_destination','report_context','package_revision','brief','appeal_source'));--> statement-breakpoint
ALTER TABLE "trust_case_events" ADD CONSTRAINT "trust_case_events_transition_check" CHECK (("trust_case_events"."action" = 'opened' and "trust_case_events"."expected_version" = 0 and "trust_case_events"."before_state" is null and "trust_case_events"."after_state" = 'open' and "trust_case_events"."resolution_kind" is null)
    or ("trust_case_events"."action" in ('question_posted','deadline_extended','report_added','content_hidden','content_restored','penalty_applied') and "trust_case_events"."expected_version" > 0 and "trust_case_events"."before_state" is not null and "trust_case_events"."before_state" = 'open' and "trust_case_events"."after_state" = 'open' and "trust_case_events"."resolution_kind" is null)
    or ("trust_case_events"."action" = 'resolved' and "trust_case_events"."expected_version" > 0 and "trust_case_events"."before_state" is not null and "trust_case_events"."before_state" = 'open' and "trust_case_events"."after_state" = 'resolved' and "trust_case_events"."resolution_kind" is not null));--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_order_check" CHECK (("trust_cases"."kind" not in ('dispute','refund_not_received','refund_overdue','late_payment') or "trust_cases"."order_id" is not null)
    and ("trust_cases"."source_type" not in ('commission_brief','commission_message','commission_file') or "trust_cases"."order_id" is not null)
    and ("trust_cases"."source_type" <> 'commission_package' or "trust_cases"."order_id" is null));--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_source_check" CHECK (("trust_cases"."kind" = 'dispute' and "trust_cases"."source_type" = 'commission_dispute')
    or ("trust_cases"."kind" in ('refund_not_received','refund_overdue') and "trust_cases"."source_type" = 'commission_refund_obligation')
    or ("trust_cases"."kind" = 'late_payment' and "trust_cases"."source_type" = 'commission_late_payment_claim')
    or ("trust_cases"."kind" = 'report' and "trust_cases"."source_type" in ('commission_package','commission_brief','commission_message','commission_file'))
    or ("trust_cases"."kind" = 'appeal' and "trust_cases"."source_type" = 'trust_appeal'));--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_resolution_check" CHECK (("trust_cases"."state" = 'open' and "trust_cases"."resolution_kind" is null and "trust_cases"."resolved_at" is null)
    or ("trust_cases"."state" = 'resolved' and "trust_cases"."resolved_at" is not null and "trust_cases"."resolved_at" >= "trust_cases"."opened_at"
      and "trust_cases"."resolution_kind" is not null and (
        ("trust_cases"."kind" = 'dispute' and "trust_cases"."resolution_kind" in ('ruled','settled','withdrawn','superseded'))
        or ("trust_cases"."kind" = 'refund_not_received' and "trust_cases"."resolution_kind" in ('receipt_accepted','resend_required','waived'))
        or ("trust_cases"."kind" = 'refund_overdue' and "trust_cases"."resolution_kind" in ('send_recorded','extended','waived'))
        or ("trust_cases"."kind" = 'late_payment' and "trust_cases"."resolution_kind" in ('refund_owed','rejected'))
        or ("trust_cases"."kind" = 'report' and "trust_cases"."resolution_kind" in ('dismissed','actioned'))
        or ("trust_cases"."kind" = 'appeal' and "trust_cases"."resolution_kind" in ('upheld','reduced','reversed')))));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_case() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Trust cases cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'Trust cases must start open' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.state <> 'open' OR NEW.state NOT IN ('open','resolved') OR NEW.version <> OLD.version + 1
      OR ROW(NEW.id, NEW.kind, NEW.order_id, NEW.source_type, NEW.source_id, NEW.policy_revision_id, NEW.community_policy_revision_id, NEW.enforcement_policy_revision_id, NEW.opened_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.kind, OLD.order_id, OLD.source_type, OLD.source_id, OLD.policy_revision_id, OLD.community_policy_revision_id, OLD.enforcement_policy_revision_id, OLD.opened_at) THEN
      RAISE EXCEPTION 'Invalid trust case transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_check_case_event() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE fact trust_case_events%ROWTYPE;
BEGIN
  SELECT * INTO fact FROM trust_case_events WHERE case_id = NEW.id AND resulting_version = NEW.version;
  IF NOT FOUND OR fact.expected_version <> NEW.version - 1 OR fact.after_state <> NEW.state
    OR fact.resolution_kind IS DISTINCT FROM NEW.resolution_kind OR fact.occurred_at < NEW.opened_at THEN
    RAISE EXCEPTION 'Trust case requires a matching event' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF fact.action <> 'opened' OR fact.before_state IS NOT NULL OR fact.occurred_at <> NEW.opened_at THEN
      RAISE EXCEPTION 'Trust case requires an opening event' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF fact.before_state IS DISTINCT FROM OLD.state
      OR (NEW.state = 'open' AND fact.action NOT IN ('question_posted','deadline_extended','report_added','content_hidden','content_restored','penalty_applied'))
      OR (NEW.state = 'resolved' AND (fact.action <> 'resolved' OR fact.occurred_at <> NEW.resolved_at)) THEN
      RAISE EXCEPTION 'Trust case event transition mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_case_event() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject trust_cases%ROWTYPE; prior trust_case_events%ROWTYPE;
BEGIN
  SELECT * INTO subject FROM trust_cases WHERE id = NEW.case_id;
  IF NOT FOUND OR subject.version < NEW.resulting_version OR NEW.occurred_at < subject.opened_at THEN
    RAISE EXCEPTION 'Trust event has no case version' USING ERRCODE = '23514';
  END IF;
  IF NEW.resulting_version = 1 THEN
    IF NEW.occurred_at <> subject.opened_at THEN
      RAISE EXCEPTION 'Trust opening event time mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO prior FROM trust_case_events WHERE case_id = NEW.case_id AND resulting_version = NEW.expected_version;
    IF NOT FOUND OR prior.after_state IS DISTINCT FROM NEW.before_state OR NEW.occurred_at < prior.occurred_at
      OR (NEW.after_state = 'open' AND NEW.action NOT IN ('question_posted','deadline_extended','report_added','content_hidden','content_restored','penalty_applied'))
      OR (NEW.after_state = 'resolved' AND NEW.action <> 'resolved') THEN
      RAISE EXCEPTION 'Trust case event history mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.resulting_version = subject.version AND (NEW.after_state <> subject.state
    OR NEW.resolution_kind IS DISTINCT FROM subject.resolution_kind) THEN
    RAISE EXCEPTION 'Trust case event state mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
