CREATE TABLE "trust_enforcement_pauses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "trust_enforcement_pauses_time_check" CHECK ("trust_enforcement_pauses"."ended_at" is null or "trust_enforcement_pauses"."ended_at" >= "trust_enforcement_pauses"."started_at"),
	CONSTRAINT "trust_enforcement_pauses_version_check" CHECK ("trust_enforcement_pauses"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "trust_policy_current" (
	"kind" text PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_policy_current_kind_check" CHECK ("trust_policy_current"."kind" in ('community_rules', 'enforcement_appeals'))
);
--> statement-breakpoint
CREATE TABLE "trust_policy_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"revision_number" integer NOT NULL,
	"document" text NOT NULL,
	"approval_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"checksum" text NOT NULL,
	"source" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_policy_revisions_kind_check" CHECK ("trust_policy_revisions"."kind" in ('community_rules', 'enforcement_appeals')),
	CONSTRAINT "trust_policy_revisions_number_check" CHECK ("trust_policy_revisions"."revision_number" > 0),
	CONSTRAINT "trust_policy_revisions_document_check" CHECK (char_length("trust_policy_revisions"."document") between 1 and 16000
    and "trust_policy_revisions"."document" = normalize("trust_policy_revisions"."document", NFC) and replace("trust_policy_revisions"."document", chr(10), '') !~ '[[:cntrl:]]'),
	CONSTRAINT "trust_policy_revisions_approval_check" CHECK (("trust_policy_revisions"."approval_kind" = 'synthetic' and "trust_policy_revisions"."actor_user_id" is null and "trust_policy_revisions"."actor_session_id" is null)
    or ("trust_policy_revisions"."approval_kind" = 'owner_reviewed' and "trust_policy_revisions"."actor_user_id" is not null and "trust_policy_revisions"."actor_session_id" is not null)),
	CONSTRAINT "trust_policy_revisions_checksum_check" CHECK ("trust_policy_revisions"."checksum" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "trust_policy_revisions_source_check" CHECK (char_length("trust_policy_revisions"."source") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "trust_policy_current" ADD CONSTRAINT "trust_policy_current_revision_id_trust_policy_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "trust_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_policy_revisions" ADD CONSTRAINT "trust_policy_revisions_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_enforcement_pauses_open_uidx" ON "trust_enforcement_pauses" USING btree ((true)) WHERE "trust_enforcement_pauses"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_policy_revisions_kind_number_uidx" ON "trust_policy_revisions" USING btree ("kind","revision_number");
--> statement-breakpoint
-- Appeal fairness mirrors commission_resolution_effective_deadline exactly:
-- inclusive pause start, exclusive pause end and 48 hours after resumption.
CREATE FUNCTION trust_enforcement_effective_deadline(deadline timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT SET search_path FROM CURRENT AS $$
DECLARE pause trust_enforcement_pauses%ROWTYPE; due timestamptz := deadline;
BEGIN
  FOR pause IN SELECT * FROM trust_enforcement_pauses ORDER BY started_at ASC LOOP
    IF pause.started_at > due THEN EXIT; END IF;
    IF pause.ended_at IS NOT NULL AND pause.ended_at <= due THEN CONTINUE; END IF;
    IF pause.ended_at IS NULL THEN RETURN NULL; END IF;
    due := pause.ended_at + interval '48 hours';
  END LOOP;
  RETURN due;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION trust_guard_enforcement_pause() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Trust enforcement pauses cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.version <> 1 THEN RAISE EXCEPTION 'Trust enforcement pause starts open' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.started_at <> OLD.started_at OR OLD.ended_at IS NOT NULL
      OR NEW.ended_at IS NULL OR NEW.ended_at < OLD.started_at OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Trust enforcement pause may only end once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_enforcement_pauses_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_enforcement_pauses
FOR EACH ROW EXECUTE FUNCTION trust_guard_enforcement_pause();
--> statement-breakpoint
CREATE TRIGGER trust_policy_revisions_immutable BEFORE UPDATE OR DELETE ON trust_policy_revisions
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE FUNCTION trust_guard_policy_current() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE revision trust_policy_revisions%ROWTYPE; previous_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Trust policy current pointer cannot be deleted' USING ERRCODE = '23514'; END IF;
  SELECT * INTO revision FROM trust_policy_revisions WHERE id = NEW.revision_id;
  IF NOT FOUND OR revision.kind <> NEW.kind THEN
    RAISE EXCEPTION 'Trust policy current kind must match its revision' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT revision_number INTO previous_number FROM trust_policy_revisions WHERE id = OLD.revision_id;
    IF NEW.kind <> OLD.kind OR revision.revision_number <= previous_number THEN
      RAISE EXCEPTION 'Trust policy current pointer must advance' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_policy_current_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_policy_current
FOR EACH ROW EXECUTE FUNCTION trust_guard_policy_current();
