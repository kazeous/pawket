CREATE TABLE "trust_case_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"accessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_case_access_log_item_check" CHECK ("trust_case_access_log"."item_type" in ('order_summary','thread_page','file','resolution_records','refund_destination')),
	CONSTRAINT "trust_case_access_log_actor_check" CHECK ("trust_case_access_log"."owner_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and "trust_case_access_log"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')
);
--> statement-breakpoint
CREATE TABLE "trust_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"reason" text,
	"request_id" text NOT NULL,
	"expected_version" integer NOT NULL,
	"resulting_version" integer NOT NULL,
	"before_state" text,
	"after_state" text NOT NULL,
	"resolution_kind" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_case_events_version_check" CHECK ("trust_case_events"."expected_version" >= 0 and "trust_case_events"."resulting_version" = "trust_case_events"."expected_version" + 1),
	CONSTRAINT "trust_case_events_transition_check" CHECK (("trust_case_events"."action" = 'opened' and "trust_case_events"."expected_version" = 0 and "trust_case_events"."before_state" is null and "trust_case_events"."after_state" = 'open' and "trust_case_events"."resolution_kind" is null)
    or ("trust_case_events"."action" in ('question_posted','deadline_extended') and "trust_case_events"."expected_version" > 0 and "trust_case_events"."before_state" is not null and "trust_case_events"."before_state" = 'open' and "trust_case_events"."after_state" = 'open' and "trust_case_events"."resolution_kind" is null)
    or ("trust_case_events"."action" = 'resolved' and "trust_case_events"."expected_version" > 0 and "trust_case_events"."before_state" is not null and "trust_case_events"."before_state" = 'open' and "trust_case_events"."after_state" = 'resolved' and "trust_case_events"."resolution_kind" is not null)),
	CONSTRAINT "trust_case_events_actor_check" CHECK (("trust_case_events"."actor_user_id" is null and "trust_case_events"."actor_session_id" is null)
    or ("trust_case_events"."actor_user_id" is not null and "trust_case_events"."actor_session_id" is not null and "trust_case_events"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')),
	CONSTRAINT "trust_case_events_request_check" CHECK ("trust_case_events"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "trust_case_events_reason_check" CHECK ("trust_case_events"."reason" is null or (char_length("trust_case_events"."reason") between 1 and 2000 and normalize("trust_case_events"."reason") = "trust_case_events"."reason" and "trust_case_events"."reason" !~ '[[:cntrl:]]'))
);
--> statement-breakpoint
CREATE TABLE "trust_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"order_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution_kind" text,
	"policy_revision_id" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "trust_cases_source_check" CHECK (("trust_cases"."kind" = 'dispute' and "trust_cases"."source_type" = 'commission_dispute')
    or ("trust_cases"."kind" in ('refund_not_received','refund_overdue') and "trust_cases"."source_type" = 'commission_refund_obligation')
    or ("trust_cases"."kind" = 'late_payment' and "trust_cases"."source_type" = 'commission_late_payment_claim')),
	CONSTRAINT "trust_cases_resolution_check" CHECK (("trust_cases"."state" = 'open' and "trust_cases"."resolution_kind" is null and "trust_cases"."resolved_at" is null)
    or ("trust_cases"."state" = 'resolved' and "trust_cases"."resolved_at" is not null and "trust_cases"."resolved_at" >= "trust_cases"."opened_at"
      and "trust_cases"."resolution_kind" is not null and (
        ("trust_cases"."kind" = 'dispute' and "trust_cases"."resolution_kind" in ('ruled','settled','withdrawn','superseded'))
        or ("trust_cases"."kind" = 'refund_not_received' and "trust_cases"."resolution_kind" in ('receipt_accepted','resend_required','waived'))
        or ("trust_cases"."kind" = 'refund_overdue' and "trust_cases"."resolution_kind" in ('send_recorded','extended','waived'))
        or ("trust_cases"."kind" = 'late_payment' and "trust_cases"."resolution_kind" in ('refund_owed','rejected'))))),
	CONSTRAINT "trust_cases_version_check" CHECK ("trust_cases"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "trust_case_access_log" ADD CONSTRAINT "trust_case_access_log_case_id_trust_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "trust_cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_case_access_log" ADD CONSTRAINT "trust_case_access_log_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_case_events" ADD CONSTRAINT "trust_case_events_case_id_trust_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "trust_cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_case_events" ADD CONSTRAINT "trust_case_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_cases" ADD CONSTRAINT "trust_cases_policy_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "trust_case_access_log_case_idx" ON "trust_case_access_log" USING btree ("case_id","accessed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_case_events_version_uidx" ON "trust_case_events" USING btree ("case_id","resulting_version");--> statement-breakpoint
CREATE INDEX "trust_case_events_timeline_idx" ON "trust_case_events" USING btree ("case_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_cases_open_source_uidx" ON "trust_cases" USING btree ("kind","source_id") WHERE "trust_cases"."state" = 'open';--> statement-breakpoint
CREATE INDEX "trust_cases_queue_idx" ON "trust_cases" USING btree ("state","opened_at","id");--> statement-breakpoint
CREATE INDEX "trust_cases_order_hold_idx" ON "trust_cases" USING btree ("order_id","state","resolved_at");
--> statement-breakpoint
CREATE TRIGGER trust_case_events_immutable BEFORE UPDATE OR DELETE ON trust_case_events
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE TRIGGER trust_case_access_log_immutable BEFORE UPDATE OR DELETE ON trust_case_access_log
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE FUNCTION trust_guard_case() RETURNS trigger
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
      OR ROW(NEW.id, NEW.kind, NEW.order_id, NEW.source_type, NEW.source_id, NEW.policy_revision_id, NEW.opened_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.kind, OLD.order_id, OLD.source_type, OLD.source_id, OLD.policy_revision_id, OLD.opened_at) THEN
      RAISE EXCEPTION 'Invalid trust case transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_cases_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_cases
FOR EACH ROW EXECUTE FUNCTION trust_guard_case();
--> statement-breakpoint
CREATE FUNCTION trust_check_case_event() RETURNS trigger
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
      OR (NEW.state = 'open' AND fact.action NOT IN ('question_posted','deadline_extended'))
      OR (NEW.state = 'resolved' AND (fact.action <> 'resolved' OR fact.occurred_at <> NEW.resolved_at)) THEN
      RAISE EXCEPTION 'Trust case event transition mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trust_cases_event_graph AFTER INSERT OR UPDATE ON trust_cases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trust_check_case_event();
--> statement-breakpoint
CREATE FUNCTION trust_guard_case_event() RETURNS trigger
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
    IF NOT FOUND OR prior.after_state IS DISTINCT FROM NEW.before_state OR NEW.occurred_at < prior.occurred_at THEN
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
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trust_case_events_graph AFTER INSERT ON trust_case_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trust_guard_case_event();
