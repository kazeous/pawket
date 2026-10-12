CREATE INDEX "trust_penalties_expiry_idx" ON "trust_penalties" USING btree ("ends_at","id") WHERE "trust_penalties"."state" = 'active' and "trust_penalties"."ends_at" is not null;--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_explanation_envelope_check" CHECK (coalesce(
  jsonb_typeof("trust_penalties"."explanation_envelope") = 'object' and octet_length("trust_penalties"."explanation_envelope"::text) <= 24000
  and "trust_penalties"."explanation_envelope"->'version' = '1'::jsonb and "trust_penalties"."explanation_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_penalties"."explanation_envelope"->'keyId') = 'string' and "trust_penalties"."explanation_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_penalties"."explanation_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_penalties"."explanation_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_penalties"."explanation_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_penalties"."explanation_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false));--> statement-breakpoint
ALTER TABLE "trust_penalties" ADD CONSTRAINT "trust_penalties_internal_note_envelope_check" CHECK ("trust_penalties"."internal_note_envelope" is null or coalesce(
  jsonb_typeof("trust_penalties"."internal_note_envelope") = 'object' and octet_length("trust_penalties"."internal_note_envelope"::text) <= 24000
  and "trust_penalties"."internal_note_envelope"->'version' = '1'::jsonb and "trust_penalties"."internal_note_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_penalties"."internal_note_envelope"->'keyId') = 'string' and "trust_penalties"."internal_note_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_penalties"."internal_note_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_penalties"."internal_note_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_penalties"."internal_note_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_penalties"."internal_note_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false));--> statement-breakpoint
ALTER TABLE "trust_penalty_events" ADD CONSTRAINT "trust_penalty_events_reason_envelope_check" CHECK ("trust_penalty_events"."reason_envelope" is null or coalesce(
  jsonb_typeof("trust_penalty_events"."reason_envelope") = 'object' and octet_length("trust_penalty_events"."reason_envelope"::text) <= 24000
  and "trust_penalty_events"."reason_envelope"->'version' = '1'::jsonb and "trust_penalty_events"."reason_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_penalty_events"."reason_envelope"->'keyId') = 'string' and "trust_penalty_events"."reason_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_penalty_events"."reason_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_penalty_events"."reason_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_penalty_events"."reason_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_penalty_events"."reason_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_help_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE p trust_penalties%ROWTYPE;
BEGIN
  SELECT * INTO p FROM trust_penalties WHERE id = NEW.penalty_id;
  IF NOT FOUND OR NEW.user_id <> p.subject_user_id OR p.target <> 'account'
    OR p.kind NOT IN ('suspension', 'removal') OR NEW.issued_at < p.created_at
    OR NEW.appeal_until <> p.created_at + interval '336 hours'
    OR NEW.read_until <> p.created_at + interval '2160 hours' THEN
    RAISE EXCEPTION 'Invalid help link binding' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'Invalid help link transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust_help_session_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE l trust_help_links%ROWTYPE;
BEGIN
  SELECT * INTO l FROM trust_help_links WHERE id = NEW.link_id;
  IF NOT FOUND OR NEW.user_id <> l.user_id OR NEW.penalty_id <> l.penalty_id OR NEW.created_at < l.issued_at
    OR NEW.created_at >= l.read_until OR (TG_OP = 'INSERT' AND l.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid help session binding' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'Invalid help session transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
