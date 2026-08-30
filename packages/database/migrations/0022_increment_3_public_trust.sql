CREATE TABLE "public_content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_reference" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"publication_revision_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"reporter_user_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_content_reports_reference_check" CHECK (char_length("public_content_reports"."report_reference") between 24 and 128 and "public_content_reports"."report_reference" ~ '^report:v1:[A-Za-z0-9_-]+$'),
	CONSTRAINT "public_content_reports_target_type_check" CHECK ("public_content_reports"."target_type" in ('page','showcase')),
	CONSTRAINT "public_content_reports_reason_check" CHECK ("public_content_reports"."reason" in ('impersonation','prohibited_or_age_restricted_content','harassment_or_hate','violence_or_self_harm','privacy','intellectual_property','spam_or_scam','other')),
	CONSTRAINT "public_content_reports_detail_check" CHECK ("public_content_reports"."detail" is null or (char_length("public_content_reports"."detail") between 0 and 1000 and "public_content_reports"."detail" !~ '[[:cntrl:]]' and normalize("public_content_reports"."detail") = "public_content_reports"."detail")),
	CONSTRAINT "public_content_reports_state_check" CHECK ("public_content_reports"."state" in ('open','dismissed','held','closed')),
	CONSTRAINT "public_content_reports_version_check" CHECK ("public_content_reports"."version" > 0),
	CONSTRAINT "public_content_reports_time_check" CHECK ("public_content_reports"."updated_at" >= "public_content_reports"."created_at")
);
--> statement-breakpoint
CREATE TABLE "public_content_triage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"hold_id" uuid,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"expected_report_version" integer NOT NULL,
	"resulting_report_version" integer NOT NULL,
	"before_state" text NOT NULL,
	"after_state" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_content_triage_events_action_check" CHECK ("public_content_triage_events"."action" in ('dismiss','hide','restore')),
	CONSTRAINT "public_content_triage_events_state_check" CHECK ("public_content_triage_events"."before_state" in ('open','dismissed','held','closed') and "public_content_triage_events"."after_state" in ('open','dismissed','held','closed')),
	CONSTRAINT "public_content_triage_events_version_check" CHECK ("public_content_triage_events"."expected_report_version" > 0 and "public_content_triage_events"."resulting_report_version" = "public_content_triage_events"."expected_report_version" + 1),
	CONSTRAINT "public_content_triage_events_text_check" CHECK (char_length("public_content_triage_events"."actor_session_id") between 1 and 256 and char_length("public_content_triage_events"."reason") between 1 and 200 and char_length("public_content_triage_events"."request_id") between 1 and 256 and "public_content_triage_events"."reason" !~ '[[:cntrl:]]' and normalize("public_content_triage_events"."reason") = "public_content_triage_events"."reason"),
	CONSTRAINT "public_content_triage_events_transition_check" CHECK (("public_content_triage_events"."action" = 'dismiss' and "public_content_triage_events"."hold_id" is null and "public_content_triage_events"."before_state" = 'open' and "public_content_triage_events"."after_state" = 'dismissed') or ("public_content_triage_events"."action" = 'hide' and "public_content_triage_events"."hold_id" is not null and "public_content_triage_events"."before_state" = 'open' and "public_content_triage_events"."after_state" = 'held') or ("public_content_triage_events"."action" = 'restore' and "public_content_triage_events"."hold_id" is not null and "public_content_triage_events"."before_state" = 'held' and "public_content_triage_events"."after_state" = 'closed'))
);
--> statement-breakpoint
CREATE TABLE "public_report_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"network_key_hmac" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "public_report_challenges_token_hash_check" CHECK ("public_report_challenges"."token_hash" ~ '^sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "public_report_challenges_network_hmac_check" CHECK ("public_report_challenges"."network_key_hmac" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "public_report_challenges_lifetime_check" CHECK ("public_report_challenges"."expires_at" = "public_report_challenges"."issued_at" + interval '10 minutes'),
	CONSTRAINT "public_report_challenges_consumption_check" CHECK ("public_report_challenges"."consumed_at" is null or ("public_report_challenges"."consumed_at" >= "public_report_challenges"."issued_at" and "public_report_challenges"."consumed_at" <= "public_report_challenges"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "public_report_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_kind" text NOT NULL,
	"network_key_hmac" text,
	"actor_user_id" text,
	"target_hash" text NOT NULL,
	"revision_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"outcome_category" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_report_security_events_requester_check" CHECK (("public_report_security_events"."requester_kind" = 'guest' and "public_report_security_events"."network_key_hmac" is not null and "public_report_security_events"."actor_user_id" is null) or ("public_report_security_events"."requester_kind" = 'authenticated' and "public_report_security_events"."network_key_hmac" is null and "public_report_security_events"."actor_user_id" is not null)),
	CONSTRAINT "public_report_security_events_network_hmac_check" CHECK ("public_report_security_events"."network_key_hmac" is null or "public_report_security_events"."network_key_hmac" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "public_report_security_events_target_hash_check" CHECK ("public_report_security_events"."target_hash" ~ '^sha256:v1:[A-Za-z0-9_-]{43}$' and "public_report_security_events"."revision_hash" ~ '^sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "public_report_security_events_outcome_check" CHECK ("public_report_security_events"."outcome" in ('accepted','rejected')),
	CONSTRAINT "public_report_security_events_category_check" CHECK (("public_report_security_events"."outcome" = 'accepted' and "public_report_security_events"."outcome_category" = 'accepted') or ("public_report_security_events"."outcome" = 'rejected' and "public_report_security_events"."outcome_category" in ('invalid_target','invalid_challenge','rate_limited','duplicate'))),
	CONSTRAINT "public_report_security_events_expiry_check" CHECK ("public_report_security_events"."expires_at" > "public_report_security_events"."created_at" and "public_report_security_events"."expires_at" <= "public_report_security_events"."created_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE "public_visibility_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"publication_revision_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" text,
	"released_by_session_id" text,
	"release_reason" text,
	"release_request_id" text,
	CONSTRAINT "public_visibility_holds_target_type_check" CHECK ("public_visibility_holds"."target_type" in ('page','showcase')),
	CONSTRAINT "public_visibility_holds_reason_check" CHECK (char_length("public_visibility_holds"."reason") between 1 and 200 and "public_visibility_holds"."reason" !~ '[[:cntrl:]]' and normalize("public_visibility_holds"."reason") = "public_visibility_holds"."reason"),
	CONSTRAINT "public_visibility_holds_actor_check" CHECK (char_length("public_visibility_holds"."actor_session_id") between 1 and 256 and char_length("public_visibility_holds"."request_id") between 1 and 256),
	CONSTRAINT "public_visibility_holds_version_check" CHECK ("public_visibility_holds"."version" > 0),
	CONSTRAINT "public_visibility_holds_release_check" CHECK (("public_visibility_holds"."released_at" is null and "public_visibility_holds"."released_by_user_id" is null and "public_visibility_holds"."released_by_session_id" is null and "public_visibility_holds"."release_reason" is null and "public_visibility_holds"."release_request_id" is null) or ("public_visibility_holds"."released_at" is not null and "public_visibility_holds"."released_at" > "public_visibility_holds"."created_at" and "public_visibility_holds"."released_by_user_id" is not null and char_length("public_visibility_holds"."released_by_session_id") between 1 and 256 and char_length("public_visibility_holds"."release_reason") between 1 and 200 and char_length("public_visibility_holds"."release_request_id") between 1 and 256))
);
--> statement-breakpoint
ALTER TABLE "public_content_reports" ADD CONSTRAINT "public_content_reports_publication_revision_id_creator_publication_revisions_id_fk" FOREIGN KEY ("publication_revision_id") REFERENCES "creator_publication_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_content_reports" ADD CONSTRAINT "public_content_reports_reporter_user_id_identity_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_content_triage_events" ADD CONSTRAINT "public_content_triage_events_report_id_public_content_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public_content_reports"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_content_triage_events" ADD CONSTRAINT "public_content_triage_events_hold_id_public_visibility_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public_visibility_holds"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_content_triage_events" ADD CONSTRAINT "public_content_triage_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_report_security_events" ADD CONSTRAINT "public_report_security_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_visibility_holds" ADD CONSTRAINT "public_visibility_holds_report_id_public_content_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public_content_reports"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_visibility_holds" ADD CONSTRAINT "public_visibility_holds_publication_revision_id_creator_publication_revisions_id_fk" FOREIGN KEY ("publication_revision_id") REFERENCES "creator_publication_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_visibility_holds" ADD CONSTRAINT "public_visibility_holds_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "public_visibility_holds" ADD CONSTRAINT "public_visibility_holds_released_by_user_id_identity_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "public_content_reports_reference_uidx" ON "public_content_reports" USING btree ("report_reference");--> statement-breakpoint
CREATE INDEX "public_content_reports_queue_idx" ON "public_content_reports" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE INDEX "public_content_reports_duplicate_idx" ON "public_content_reports" USING btree ("target_type","target_id","publication_revision_id","reporter_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "public_content_reports_authenticated_target_uidx" ON "public_content_reports" USING btree ("target_type","target_id","publication_revision_id","reporter_user_id") WHERE "public_content_reports"."reporter_user_id" is not null;--> statement-breakpoint
CREATE INDEX "public_content_triage_events_report_idx" ON "public_content_triage_events" USING btree ("report_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "public_report_challenges_token_hash_uidx" ON "public_report_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "public_report_challenges_expiry_idx" ON "public_report_challenges" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "public_report_security_events_expiry_idx" ON "public_report_security_events" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "public_report_security_events_network_idx" ON "public_report_security_events" USING btree ("network_key_hmac","created_at") WHERE "public_report_security_events"."network_key_hmac" is not null;--> statement-breakpoint
CREATE INDEX "public_report_security_events_actor_idx" ON "public_report_security_events" USING btree ("actor_user_id","created_at") WHERE "public_report_security_events"."actor_user_id" is not null;--> statement-breakpoint
CREATE INDEX "public_report_security_events_target_idx" ON "public_report_security_events" USING btree ("target_hash","revision_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "public_visibility_holds_active_target_uidx" ON "public_visibility_holds" USING btree ("target_type","target_id") WHERE "public_visibility_holds"."released_at" is null;--> statement-breakpoint
CREATE INDEX "public_visibility_holds_report_idx" ON "public_visibility_holds" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_report_target() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state <> 'open' OR NEW.version <> 1 OR NEW.updated_at <> NEW.created_at THEN
    RAISE EXCEPTION 'new public content reports must begin open at version one' USING ERRCODE = '23514';
  END IF;
  IF NEW.target_type = 'page' THEN
    IF NOT EXISTS (
      SELECT 1 FROM creator_publication_revisions revision
      WHERE revision.id = NEW.publication_revision_id AND revision.page_id = NEW.target_id
    ) THEN
      RAISE EXCEPTION 'public report page target must bind its exact revision' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.target_type = 'showcase' THEN
    IF NOT EXISTS (
      SELECT 1 FROM creator_publication_showcases showcase
      WHERE showcase.revision_id = NEW.publication_revision_id AND showcase.source_showcase_id = NEW.target_id
    ) THEN
      RAISE EXCEPTION 'public report showcase target must bind its exact revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_content_reports_target_guard
BEFORE INSERT ON public_content_reports
FOR EACH ROW EXECUTE FUNCTION trust_guard_report_target();--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_report_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  call_stack text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'public content reports are append-only' USING ERRCODE = '55000';
  END IF;

  GET DIAGNOSTICS call_stack = PG_CONTEXT;
  IF current_setting('pawket.trust_report_transition', true) IS DISTINCT FROM OLD.id::text
     OR position('PL/pgSQL function trust_transition_public_content_report(uuid,integer,text,timestamp with time zone)' in call_stack) = 0
  THEN
    RAISE EXCEPTION 'public content report state changes require the approved triage function' USING ERRCODE = '55000';
  END IF;

  IF ROW(NEW.id, NEW.report_reference, NEW.target_type, NEW.target_id,
         NEW.publication_revision_id, NEW.reason, NEW.detail, NEW.reporter_user_id,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.report_reference, OLD.target_type, OLD.target_id,
         OLD.publication_revision_id, OLD.reason, OLD.detail, OLD.reporter_user_id,
         OLD.created_at)
  THEN
    RAISE EXCEPTION 'public content reports are append-only' USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at OR NOT (
    (OLD.state = 'open' AND NEW.state IN ('dismissed', 'held')) OR
    (OLD.state = 'held' AND NEW.state = 'closed')
  ) THEN
    RAISE EXCEPTION 'invalid public content report triage transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_content_reports_append_only
BEFORE UPDATE OR DELETE ON public_content_reports
FOR EACH ROW EXECUTE FUNCTION trust_guard_report_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_transition_public_content_report(
  p_report_id uuid,
  p_expected_version integer,
  p_next_state text,
  p_updated_at timestamptz
) RETURNS TABLE (report_id uuid, report_state text, report_version integer)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_next_state NOT IN ('dismissed', 'held', 'closed') THEN
    RAISE EXCEPTION 'invalid public content report triage transition' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('pawket.trust_report_transition', p_report_id::text, true);
  RETURN QUERY
    UPDATE public_content_reports report
    SET state = p_next_state, version = report.version + 1, updated_at = p_updated_at
    WHERE report.id = p_report_id AND report.version = p_expected_version
    RETURNING report.id, report.state, report.version;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_challenge_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > statement_timestamp() THEN
      RAISE EXCEPTION 'active public report challenges cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.token_hash, NEW.network_key_hmac, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.token_hash, OLD.network_key_hmac, OLD.issued_at, OLD.expires_at)
     OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'public report challenge consumption is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_report_challenges_one_way_consume
BEFORE UPDATE OR DELETE ON public_report_challenges
FOR EACH ROW EXECUTE FUNCTION trust_guard_challenge_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_security_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at <= statement_timestamp() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'public report security events are immutable until expiry' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_report_security_events_retention_guard
BEFORE UPDATE OR DELETE ON public_report_security_events
FOR EACH ROW EXECUTE FUNCTION trust_guard_security_event_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_visibility_hold() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public_content_reports report
      WHERE report.id = NEW.report_id
        AND report.target_type = NEW.target_type
        AND report.target_id = NEW.target_id
        AND report.publication_revision_id = NEW.publication_revision_id
        AND report.state = 'held'
    ) THEN
      RAISE EXCEPTION 'visibility hold must bind its source report and exact target' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'public visibility holds are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'public visibility hold release is final and occurs once' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW.report_id, NEW.target_type, NEW.target_id,
         NEW.publication_revision_id, NEW.reason, NEW.actor_user_id,
         NEW.actor_session_id, NEW.request_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.report_id, OLD.target_type, OLD.target_id,
         OLD.publication_revision_id, OLD.reason, OLD.actor_user_id,
         OLD.actor_session_id, OLD.request_id, OLD.created_at)
     OR NEW.released_at IS NULL OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION 'public visibility holds are append-only and cannot be retargeted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_visibility_holds_guard
BEFORE INSERT OR UPDATE OR DELETE ON public_visibility_holds
FOR EACH ROW EXECUTE FUNCTION trust_guard_visibility_hold();--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_guard_triage_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'public content triage events are append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_content_triage_events_append_only
BEFORE UPDATE OR DELETE ON public_content_triage_events
FOR EACH ROW EXECUTE FUNCTION trust_guard_triage_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_validate_triage_event_binding() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public_content_reports report
    WHERE report.id = NEW.report_id
      AND report.state = NEW.after_state
      AND report.version = NEW.resulting_report_version
  ) THEN
    RAISE EXCEPTION 'triage event must bind the resulting report state and version' USING ERRCODE = '23514';
  END IF;
  IF NEW.hold_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public_visibility_holds hold
    WHERE hold.id = NEW.hold_id AND hold.report_id = NEW.report_id
  ) THEN
    RAISE EXCEPTION 'triage event hold must belong to its report' USING ERRCODE = '23514';
  END IF;
  IF NEW.action = 'hide' AND NOT EXISTS (
    SELECT 1 FROM public_visibility_holds hold
    WHERE hold.id = NEW.hold_id AND hold.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'hide event must bind an active visibility hold' USING ERRCODE = '23514';
  END IF;
  IF NEW.action = 'restore' AND NOT EXISTS (
    SELECT 1 FROM public_visibility_holds hold
    WHERE hold.id = NEW.hold_id AND hold.released_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'restore event must bind a released visibility hold' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER public_content_triage_events_binding_guard
BEFORE INSERT ON public_content_triage_events
FOR EACH ROW EXECUTE FUNCTION trust_validate_triage_event_binding();
