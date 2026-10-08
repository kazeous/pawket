-- Keep this algorithm aligned with commissionCompletionDueAt / effectiveResolutionDeadline.
-- Pause start is inclusive, pause end exclusive; resumed deadlines receive 48 hours.
CREATE FUNCTION commission_resolution_effective_deadline(deadline timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT SET search_path FROM CURRENT AS $$
DECLARE pause commission_resolution_pauses%ROWTYPE; due timestamptz := deadline;
BEGIN
  FOR pause IN SELECT * FROM commission_resolution_pauses ORDER BY started_at ASC LOOP
    IF pause.started_at > due THEN EXIT; END IF;
    IF pause.ended_at IS NOT NULL AND pause.ended_at <= due THEN CONTINUE; END IF;
    IF pause.ended_at IS NULL THEN RETURN NULL; END IF;
    due := pause.ended_at + interval '48 hours';
  END LOOP;
  RETURN due;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_guard_ruling_correction() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_rulings%ROWTYPE; paid_amount bigint; effective_deadline timestamptz;
BEGIN
  SELECT * INTO subject FROM commission_rulings WHERE id = NEW.ruling_id FOR UPDATE;
  effective_deadline := commission_resolution_effective_deadline(subject.ruled_at + interval '30 days');
  IF NOT FOUND OR NEW.corrected_at < subject.ruled_at OR effective_deadline IS NULL OR NEW.corrected_at > effective_deadline THEN
    RAISE EXCEPTION 'Commission correction window has ended' USING ERRCODE = '23514';
  END IF;
  SELECT o.amount_vnd INTO paid_amount FROM commission_orders o JOIN commission_disputes d ON d.order_id = o.id WHERE d.id = subject.dispute_id;
  IF NEW.refund_amount_vnd > paid_amount OR (subject.outcome = 'complete' AND NEW.refund_amount_vnd >= paid_amount) THEN
    RAISE EXCEPTION 'Invalid commission correction amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_guard_late_payment_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE; effective_deadline timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission claims cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO subject FROM commission_orders WHERE id = NEW.order_id;
    effective_deadline := commission_resolution_effective_deadline(subject.closed_at + interval '30 days');
    IF NOT FOUND OR NEW.version <> 1 OR NEW.state <> 'awaiting_creator' OR subject.state <> 'closed' OR subject.confirmed_at IS NOT NULL
      OR subject.accepted_at IS NULL OR subject.close_reason NOT IN ('payment_expired','buyer_cancelled','creator_cancelled','security_invalidated','eligibility_invalidated')
      OR NEW.buyer_user_id <> subject.buyer_user_id OR NEW.filed_at < subject.closed_at OR effective_deadline IS NULL OR NEW.filed_at > effective_deadline THEN
      RAISE EXCEPTION 'Invalid commission late payment claim' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.order_id, NEW.buyer_user_id, NEW.transfer_at, NEW.claimed_amount_vnd, NEW.reference_envelope, NEW.note_envelope, NEW.creator_respond_by, NEW.filed_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.buyer_user_id, OLD.transfer_at, OLD.claimed_amount_vnd, OLD.reference_envelope, OLD.note_envelope, OLD.creator_respond_by, OLD.filed_at)
      OR NEW.version <> OLD.version + 1 OR NOT (
        (OLD.state = 'awaiting_creator' AND NEW.state IN ('refund_owed','escalated'))
        OR (OLD.state = 'escalated' AND NEW.state IN ('refund_owed','rejected'))) THEN
      RAISE EXCEPTION 'Commission claim identity or transition is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
