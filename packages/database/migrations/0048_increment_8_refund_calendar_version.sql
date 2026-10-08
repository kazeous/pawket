CREATE OR REPLACE FUNCTION commission_guard_refund_obligation() RETURNS trigger
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
      NEW.reference, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.payment_intent_id, OLD.creator_user_id, OLD.buyer_user_id, OLD.source, OLD.source_id,
      OLD.reference, OLD.created_at)
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
  IF NEW.calendar_version IS DISTINCT FROM OLD.calendar_version AND NOT (
    (OLD.state = 'awaiting_destination' AND NEW.state = 'awaiting_send' AND NOT prior_send)
    OR (OLD.state = 'awaiting_send' AND NEW.state = 'awaiting_send' AND NOT prior_send
      AND ROW(NEW.destination_bank_bin, NEW.destination_bank_name, NEW.destination_suffix, NEW.destination_entered_at,
          NEW.destination_account_envelope, NEW.destination_holder_envelope)
        IS DISTINCT FROM ROW(OLD.destination_bank_bin, OLD.destination_bank_name, OLD.destination_suffix, OLD.destination_entered_at,
          OLD.destination_account_envelope, OLD.destination_holder_envelope))
    OR (OLD.state = 'not_received' AND NEW.state = 'awaiting_send')) THEN
    RAISE EXCEPTION 'Invalid refund calendar version change' USING ERRCODE = '23514';
  END IF;
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
ALTER TABLE "commission_refund_events" DROP CONSTRAINT "commission_refund_events_action_check";
--> statement-breakpoint
ALTER TABLE "commission_refund_events" ADD CONSTRAINT "commission_refund_events_action_check" CHECK ("commission_refund_events"."action" in ('created','destination_entered','destination_revealed','sent_recorded','receipt_confirmed','receipt_denied','presumed_received','resend_required','deadline_extended','amount_adjusted','amount_recorded','waived','destination_purged'));
