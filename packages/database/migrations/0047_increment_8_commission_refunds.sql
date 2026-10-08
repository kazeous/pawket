CREATE TABLE "commission_refund_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"from_state" text,
	"to_state" text NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_refund_events_action_check" CHECK ("commission_refund_events"."action" in ('created','destination_entered','destination_revealed','sent_recorded','receipt_confirmed','receipt_denied','presumed_received','resend_required','deadline_extended','amount_adjusted','waived','destination_purged')),
	CONSTRAINT "commission_refund_events_state_check" CHECK (("commission_refund_events"."from_state" is null or "commission_refund_events"."from_state" in ('awaiting_destination','awaiting_send','sent','received','presumed_received','not_received','waived'))
    and "commission_refund_events"."to_state" in ('awaiting_destination','awaiting_send','sent','received','presumed_received','not_received','waived')),
	CONSTRAINT "commission_refund_events_actor_check" CHECK (("commission_refund_events"."actor_user_id" is null and "commission_refund_events"."actor_session_id" is null)
    or ("commission_refund_events"."actor_user_id" is not null and "commission_refund_events"."actor_session_id" is not null and "commission_refund_events"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')),
	CONSTRAINT "commission_refund_events_request_check" CHECK ("commission_refund_events"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')
);
--> statement-breakpoint
CREATE TABLE "commission_refund_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"buyer_user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"reference" text NOT NULL,
	"state" text DEFAULT 'awaiting_destination' NOT NULL,
	"destination_bank_bin" text,
	"destination_bank_name" text,
	"destination_account_envelope" jsonb,
	"destination_holder_envelope" jsonb,
	"destination_suffix" text,
	"destination_entered_at" timestamp with time zone,
	"destination_purged_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"calendar_version" text NOT NULL,
	"current_send_id" uuid,
	"confirm_by" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_refund_obligations_source_check" CHECK ("commission_refund_obligations"."source" in ('agreement','ruling','correction','late_payment','late_payment_provider','suspension_cancel','fulfillment_freeze')),
	CONSTRAINT "commission_refund_obligations_amount_check" CHECK ("commission_refund_obligations"."amount_vnd" between 1 and 50000000),
	CONSTRAINT "commission_refund_obligations_reference_check" CHECK ("commission_refund_obligations"."reference" ~ '^PKR[0-9A-HJKMNP-TV-Z]{12}$'),
	CONSTRAINT "commission_refund_obligations_version_check" CHECK ("commission_refund_obligations"."version" > 0),
	CONSTRAINT "commission_refund_obligations_time_check" CHECK ("commission_refund_obligations"."updated_at" >= "commission_refund_obligations"."created_at"
    and ("commission_refund_obligations"."destination_entered_at" is null or "commission_refund_obligations"."destination_entered_at" >= "commission_refund_obligations"."created_at")
    and ("commission_refund_obligations"."due_at" is null or ("commission_refund_obligations"."destination_entered_at" is not null and "commission_refund_obligations"."due_at" > "commission_refund_obligations"."destination_entered_at"))
    and ("commission_refund_obligations"."ended_at" is null or "commission_refund_obligations"."ended_at" >= "commission_refund_obligations"."created_at")),
	CONSTRAINT "commission_refund_obligations_destination_check" CHECK (coalesce(
    ("commission_refund_obligations"."destination_entered_at" is null and "commission_refund_obligations"."destination_bank_bin" is null and "commission_refund_obligations"."destination_bank_name" is null
      and "commission_refund_obligations"."destination_account_envelope" is null and "commission_refund_obligations"."destination_holder_envelope" is null and "commission_refund_obligations"."destination_suffix" is null and "commission_refund_obligations"."destination_purged_at" is null)
    or ("commission_refund_obligations"."destination_entered_at" is not null and "commission_refund_obligations"."destination_bank_bin" is not null and "commission_refund_obligations"."destination_bank_bin" ~ '^[0-9]{6}$'
      and "commission_refund_obligations"."destination_bank_name" is not null and char_length(btrim("commission_refund_obligations"."destination_bank_name")) between 1 and 100
      and "commission_refund_obligations"."destination_suffix" is not null and "commission_refund_obligations"."destination_suffix" ~ '^[0-9]{4}$'
      and (("commission_refund_obligations"."destination_purged_at" is null and coalesce(
  jsonb_typeof("commission_refund_obligations"."destination_account_envelope") = 'object' and octet_length("commission_refund_obligations"."destination_account_envelope"::text) <= 24000
  and "commission_refund_obligations"."destination_account_envelope"->'version' = '1'::jsonb and "commission_refund_obligations"."destination_account_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_refund_obligations"."destination_account_envelope"->'keyId') = 'string' and "commission_refund_obligations"."destination_account_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("commission_refund_obligations"."destination_account_envelope"->'nonce') = 'string' and "commission_refund_obligations"."destination_account_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("commission_refund_obligations"."destination_account_envelope"->'ciphertext') = 'string' and "commission_refund_obligations"."destination_account_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("commission_refund_obligations"."destination_account_envelope"->'authenticationTag') = 'string' and "commission_refund_obligations"."destination_account_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_refund_obligations"."destination_account_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false) and coalesce(
  jsonb_typeof("commission_refund_obligations"."destination_holder_envelope") = 'object' and octet_length("commission_refund_obligations"."destination_holder_envelope"::text) <= 24000
  and "commission_refund_obligations"."destination_holder_envelope"->'version' = '1'::jsonb and "commission_refund_obligations"."destination_holder_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_refund_obligations"."destination_holder_envelope"->'keyId') = 'string' and "commission_refund_obligations"."destination_holder_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("commission_refund_obligations"."destination_holder_envelope"->'nonce') = 'string' and "commission_refund_obligations"."destination_holder_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("commission_refund_obligations"."destination_holder_envelope"->'ciphertext') = 'string' and "commission_refund_obligations"."destination_holder_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("commission_refund_obligations"."destination_holder_envelope"->'authenticationTag') = 'string' and "commission_refund_obligations"."destination_holder_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_refund_obligations"."destination_holder_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))
        or ("commission_refund_obligations"."destination_purged_at" is not null and "commission_refund_obligations"."state" in ('received','presumed_received','waived') and "commission_refund_obligations"."ended_at" is not null
          and "commission_refund_obligations"."destination_purged_at" >= "commission_refund_obligations"."ended_at" + interval '30 days'
          and "commission_refund_obligations"."destination_account_envelope" is null and "commission_refund_obligations"."destination_holder_envelope" is null))), false)),
	CONSTRAINT "commission_refund_obligations_state_check" CHECK (("commission_refund_obligations"."state" = 'awaiting_destination' and "commission_refund_obligations"."destination_entered_at" is null
      and "commission_refund_obligations"."due_at" is null and "commission_refund_obligations"."current_send_id" is null and "commission_refund_obligations"."confirm_by" is null and "commission_refund_obligations"."ended_at" is null)
    or ("commission_refund_obligations"."state" = 'awaiting_send' and "commission_refund_obligations"."destination_entered_at" is not null and "commission_refund_obligations"."due_at" is not null
      and "commission_refund_obligations"."current_send_id" is null and "commission_refund_obligations"."confirm_by" is null and "commission_refund_obligations"."ended_at" is null)
    or ("commission_refund_obligations"."state" in ('sent','not_received') and "commission_refund_obligations"."destination_entered_at" is not null and "commission_refund_obligations"."due_at" is not null
      and "commission_refund_obligations"."current_send_id" is not null and "commission_refund_obligations"."confirm_by" is not null and "commission_refund_obligations"."ended_at" is null)
    or ("commission_refund_obligations"."state" in ('received','presumed_received') and "commission_refund_obligations"."destination_entered_at" is not null and "commission_refund_obligations"."due_at" is not null
      and "commission_refund_obligations"."current_send_id" is not null and "commission_refund_obligations"."confirm_by" is not null and "commission_refund_obligations"."ended_at" is not null)
    or ("commission_refund_obligations"."state" = 'waived' and "commission_refund_obligations"."ended_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "commission_refund_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid NOT NULL,
	"transfer_date" date NOT NULL,
	"reference_envelope" jsonb NOT NULL,
	"note_envelope" jsonb,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_refund_sends_envelopes_check" CHECK (coalesce(
  jsonb_typeof("commission_refund_sends"."reference_envelope") = 'object' and octet_length("commission_refund_sends"."reference_envelope"::text) <= 24000
  and "commission_refund_sends"."reference_envelope"->'version' = '1'::jsonb and "commission_refund_sends"."reference_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_refund_sends"."reference_envelope"->'keyId') = 'string' and "commission_refund_sends"."reference_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("commission_refund_sends"."reference_envelope"->'nonce') = 'string' and "commission_refund_sends"."reference_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("commission_refund_sends"."reference_envelope"->'ciphertext') = 'string' and "commission_refund_sends"."reference_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("commission_refund_sends"."reference_envelope"->'authenticationTag') = 'string' and "commission_refund_sends"."reference_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_refund_sends"."reference_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false) and ("commission_refund_sends"."note_envelope" is null or coalesce(
  jsonb_typeof("commission_refund_sends"."note_envelope") = 'object' and octet_length("commission_refund_sends"."note_envelope"::text) <= 24000
  and "commission_refund_sends"."note_envelope"->'version' = '1'::jsonb and "commission_refund_sends"."note_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_refund_sends"."note_envelope"->'keyId') = 'string' and "commission_refund_sends"."note_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("commission_refund_sends"."note_envelope"->'nonce') = 'string' and "commission_refund_sends"."note_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("commission_refund_sends"."note_envelope"->'ciphertext') = 'string' and "commission_refund_sends"."note_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("commission_refund_sends"."note_envelope"->'authenticationTag') = 'string' and "commission_refund_sends"."note_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_refund_sends"."note_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))),
	CONSTRAINT "commission_refund_sends_actor_check" CHECK ("commission_refund_sends"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_refund_sends_request_check" CHECK ("commission_refund_sends"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')
);
--> statement-breakpoint
ALTER TABLE "commission_refund_events" ADD CONSTRAINT "commission_refund_events_obligation_id_commission_refund_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "commission_refund_obligations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_events" ADD CONSTRAINT "commission_refund_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_obligations" ADD CONSTRAINT "commission_refund_obligations_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_obligations" ADD CONSTRAINT "commission_refund_obligations_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_obligations" ADD CONSTRAINT "commission_refund_obligations_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_obligations" ADD CONSTRAINT "commission_refund_obligations_buyer_user_id_identity_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_obligations" ADD CONSTRAINT "commission_refund_obligations_calendar_version_system_business_calendar_versions_version_fk" FOREIGN KEY ("calendar_version") REFERENCES "system_business_calendar_versions"("version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_refund_sends_binding_uidx" ON "commission_refund_sends" USING btree ("id","obligation_id");--> statement-breakpoint
ALTER TABLE "commission_refund_obligations" ADD CONSTRAINT "commission_refund_obligations_current_send_fk" FOREIGN KEY ("current_send_id","id") REFERENCES "commission_refund_sends"("id","obligation_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_sends" ADD CONSTRAINT "commission_refund_sends_obligation_id_commission_refund_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "commission_refund_obligations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_refund_sends" ADD CONSTRAINT "commission_refund_sends_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "commission_refund_events_timeline_idx" ON "commission_refund_events" USING btree ("obligation_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_refund_events_request_action_uidx" ON "commission_refund_events" USING btree ("obligation_id","request_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_refund_obligations_source_uidx" ON "commission_refund_obligations" USING btree ("source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_refund_obligations_reference_uidx" ON "commission_refund_obligations" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "commission_refund_obligations_creator_deadline_idx" ON "commission_refund_obligations" USING btree ("creator_user_id","state","due_at");--> statement-breakpoint
CREATE INDEX "commission_refund_obligations_confirmation_idx" ON "commission_refund_obligations" USING btree ("state","confirm_by");--> statement-breakpoint
CREATE INDEX "commission_refund_obligations_order_idx" ON "commission_refund_obligations" USING btree ("order_id","created_at");--> statement-breakpoint

CREATE UNIQUE INDEX "commission_refund_sends_request_uidx" ON "commission_refund_sends" USING btree ("obligation_id","request_id");--> statement-breakpoint
CREATE INDEX "commission_refund_sends_timeline_idx" ON "commission_refund_sends" USING btree ("obligation_id","recorded_at");
--> statement-breakpoint
CREATE TRIGGER commission_refund_events_immutable BEFORE UPDATE OR DELETE ON commission_refund_events
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_refund_sends_immutable BEFORE UPDATE OR DELETE ON commission_refund_sends
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE FUNCTION commission_guard_refund_obligation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE prior_send boolean; send_fact commission_refund_sends%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund obligations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_destination' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'Refund obligations must start awaiting destination' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payment_intents p JOIN commission_orders o ON o.id = p.commission_order_id
      WHERE p.id = NEW.payment_intent_id AND p.purpose = 'commission' AND p.commission_order_id = NEW.order_id
        AND p.creator_user_id = NEW.creator_user_id AND o.creator_user_id = NEW.creator_user_id AND o.buyer_user_id = NEW.buyer_user_id
        AND p.state IN ('confirmed','expired','rejected')) THEN
      RAISE EXCEPTION 'Refund payment binding mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.order_id, NEW.payment_intent_id, NEW.creator_user_id, NEW.buyer_user_id, NEW.source, NEW.source_id,
      NEW.reference, NEW.calendar_version, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.payment_intent_id, OLD.creator_user_id, OLD.buyer_user_id, OLD.source, OLD.source_id,
      OLD.reference, OLD.calendar_version, OLD.created_at)
    OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Refund identity or version is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'awaiting_destination' AND NEW.state IN ('awaiting_send','waived'))
    OR (OLD.state = 'awaiting_send' AND NEW.state IN ('sent','waived'))
    OR (OLD.state = 'sent' AND NEW.state IN ('received','presumed_received','not_received'))
    OR (OLD.state = 'not_received' AND NEW.state IN ('received','awaiting_send','waived'))) THEN
    RAISE EXCEPTION 'Invalid refund state transition' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (SELECT 1 FROM commission_refund_sends WHERE obligation_id = OLD.id) INTO prior_send;
  IF NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd AND
    (OLD.state NOT IN ('awaiting_destination','awaiting_send') OR prior_send OR NEW.amount_vnd > OLD.amount_vnd) THEN
    RAISE EXCEPTION 'A sent refund amount is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.destination_bank_bin, NEW.destination_bank_name, NEW.destination_suffix, NEW.destination_entered_at,
      NEW.destination_account_envelope, NEW.destination_holder_envelope)
    IS DISTINCT FROM ROW(OLD.destination_bank_bin, OLD.destination_bank_name, OLD.destination_suffix, OLD.destination_entered_at,
      OLD.destination_account_envelope, OLD.destination_holder_envelope) AND NOT (
    (OLD.state IN ('awaiting_destination','awaiting_send') AND NEW.state = 'awaiting_send' AND NOT prior_send)
    OR (NEW.state = OLD.state AND NEW.state IN ('received','presumed_received','waived')
      AND OLD.destination_purged_at IS NULL AND NEW.destination_purged_at IS NOT NULL
      AND NEW.destination_account_envelope IS NULL AND NEW.destination_holder_envelope IS NULL
      AND ROW(NEW.destination_bank_bin, NEW.destination_bank_name, NEW.destination_suffix, NEW.destination_entered_at)
        IS NOT DISTINCT FROM ROW(OLD.destination_bank_bin, OLD.destination_bank_name, OLD.destination_suffix, OLD.destination_entered_at))) THEN
    RAISE EXCEPTION 'Refund destination cannot change after a send' USING ERRCODE = '23514';
  END IF;
  IF NEW.destination_purged_at IS DISTINCT FROM OLD.destination_purged_at AND
    (OLD.destination_purged_at IS NOT NULL OR OLD.state NOT IN ('received','presumed_received','waived') OR NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'Invalid refund destination purge' USING ERRCODE = '23514';
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at AND NOT (
    (OLD.state IN ('awaiting_destination','awaiting_send') AND NEW.state = 'awaiting_send')
    OR (OLD.state = 'not_received' AND NEW.state = 'awaiting_send')) THEN
    RAISE EXCEPTION 'Invalid refund deadline change' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.current_send_id, NEW.confirm_by) IS DISTINCT FROM ROW(OLD.current_send_id, OLD.confirm_by) AND NOT (
    (OLD.state = 'awaiting_send' AND NEW.state = 'sent') OR (OLD.state = 'not_received' AND NEW.state = 'awaiting_send')) THEN
    RAISE EXCEPTION 'Invalid refund send change' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'Refund end time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'awaiting_send' AND NEW.state = 'sent' THEN
    SELECT * INTO send_fact FROM commission_refund_sends WHERE id = NEW.current_send_id AND obligation_id = NEW.id;
    IF NOT FOUND OR NEW.confirm_by IS DISTINCT FROM send_fact.recorded_at + interval '7 days' OR NEW.updated_at <> send_fact.recorded_at THEN
      RAISE EXCEPTION 'Refund send confirmation window mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.state = 'sent' AND NEW.state = 'presumed_received' AND NEW.ended_at < OLD.confirm_by THEN
    RAISE EXCEPTION 'Refund confirmation window has not ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_refund_obligations_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_refund_obligations
FOR EACH ROW EXECUTE FUNCTION commission_guard_refund_obligation();
--> statement-breakpoint
CREATE FUNCTION commission_guard_refund_send() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_refund_obligations%ROWTYPE;
BEGIN
  SELECT * INTO subject FROM commission_refund_obligations WHERE id = NEW.obligation_id FOR UPDATE;
  IF NOT FOUND OR subject.state <> 'awaiting_send' OR NEW.actor_user_id <> subject.creator_user_id
    OR NEW.recorded_at < subject.updated_at
    OR NEW.transfer_date < (subject.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    OR NEW.transfer_date > (NEW.recorded_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'Invalid refund send binding or date' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_refund_sends_guard BEFORE INSERT ON commission_refund_sends
FOR EACH ROW EXECUTE FUNCTION commission_guard_refund_send();
