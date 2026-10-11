CREATE TABLE "trust_appeals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appellant_user_id" text NOT NULL,
	"penalty_id" uuid,
	"hide_id" uuid,
	"statement_envelope" jsonb NOT NULL,
	"submitted_via" text NOT NULL,
	"case_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reasoning_envelope" jsonb,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_appeals_target_check" CHECK (num_nonnulls("trust_appeals"."penalty_id", "trust_appeals"."hide_id") = 1),
	CONSTRAINT "trust_appeals_via_check" CHECK ("trust_appeals"."submitted_via" in ('session','help_link') and ("trust_appeals"."submitted_via" <> 'help_link' or "trust_appeals"."penalty_id" is not null)),
	CONSTRAINT "trust_appeals_statement_check" CHECK (coalesce(
  jsonb_typeof("trust_appeals"."statement_envelope") = 'object' and octet_length("trust_appeals"."statement_envelope"::text) <= 24000
  and "trust_appeals"."statement_envelope"->'version' = '1'::jsonb and "trust_appeals"."statement_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_appeals"."statement_envelope"->'keyId') = 'string' and "trust_appeals"."statement_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_appeals"."statement_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_appeals"."statement_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_appeals"."statement_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_appeals"."statement_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "trust_appeals_reasoning_check" CHECK ("trust_appeals"."reasoning_envelope" is null or coalesce(
  jsonb_typeof("trust_appeals"."reasoning_envelope") = 'object' and octet_length("trust_appeals"."reasoning_envelope"::text) <= 24000
  and "trust_appeals"."reasoning_envelope"->'version' = '1'::jsonb and "trust_appeals"."reasoning_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_appeals"."reasoning_envelope"->'keyId') = 'string' and "trust_appeals"."reasoning_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_appeals"."reasoning_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_appeals"."reasoning_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_appeals"."reasoning_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_appeals"."reasoning_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "trust_appeals_decision_check" CHECK (("trust_appeals"."state" = 'open' and "trust_appeals"."reasoning_envelope" is null and "trust_appeals"."decided_at" is null and "trust_appeals"."decided_by_user_id" is null)
    or ("trust_appeals"."state" in ('upheld','reduced','reversed') and "trust_appeals"."reasoning_envelope" is not null and "trust_appeals"."decided_at" is not null and "trust_appeals"."decided_by_user_id" is not null
      and "trust_appeals"."decided_at" >= "trust_appeals"."created_at" and ("trust_appeals"."state" <> 'reduced' or "trust_appeals"."penalty_id" is not null))),
	CONSTRAINT "trust_appeals_version_check" CHECK ("trust_appeals"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "trust_appeals" ADD CONSTRAINT "trust_appeals_appellant_user_id_identity_users_id_fk" FOREIGN KEY ("appellant_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_appeals" ADD CONSTRAINT "trust_appeals_penalty_id_trust_penalties_id_fk" FOREIGN KEY ("penalty_id") REFERENCES "trust_penalties"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_appeals" ADD CONSTRAINT "trust_appeals_hide_id_trust_content_hides_id_fk" FOREIGN KEY ("hide_id") REFERENCES "trust_content_hides"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_appeals" ADD CONSTRAINT "trust_appeals_case_id_trust_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "trust_cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_appeals" ADD CONSTRAINT "trust_appeals_decided_by_user_id_identity_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_appeals_penalty_uidx" ON "trust_appeals" USING btree ("penalty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_appeals_hide_uidx" ON "trust_appeals" USING btree ("hide_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_appeals_case_uidx" ON "trust_appeals" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "trust_appeals_appellant_idx" ON "trust_appeals" USING btree ("appellant_user_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION trust_guard_appeal() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Trust appeals cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NEW.version <> 1 OR NEW.reasoning_envelope IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decided_by_user_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM trust_cases c WHERE c.id = NEW.case_id AND c.kind = 'appeal' AND c.source_type = 'trust_appeal'
        AND c.source_id = NEW.id AND c.state = 'open' AND c.opened_at = NEW.created_at)
      OR (NEW.penalty_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trust_penalties p WHERE p.id = NEW.penalty_id
        AND p.subject_user_id = NEW.appellant_user_id AND p.kind IN ('restriction','suspension','removal')))
      OR (NEW.hide_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trust_content_hides h WHERE h.id = NEW.hide_id AND h.content_owner_user_id = NEW.appellant_user_id)) THEN
      RAISE EXCEPTION 'Invalid trust appeal source' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state','reasoning_envelope','decided_at','decided_by_user_id','version'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','reasoning_envelope','decided_at','decided_by_user_id','version'])
    OR OLD.state <> 'open' OR NEW.state NOT IN ('upheld','reduced','reversed') OR NEW.version <> OLD.version + 1
    OR NEW.reasoning_envelope IS NULL OR NEW.decided_at IS NULL OR NEW.decided_by_user_id IS NULL OR NEW.decided_at < OLD.created_at THEN
    RAISE EXCEPTION 'Invalid trust appeal transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_appeals_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_appeals FOR EACH ROW EXECUTE FUNCTION trust_guard_appeal();
