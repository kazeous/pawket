ALTER TABLE "commission_orders" DROP CONSTRAINT "commission_orders_completion_check";--> statement-breakpoint
ALTER TABLE "commission_orders" DROP CONSTRAINT "commission_orders_fulfillment_check";--> statement-breakpoint
ALTER TABLE "commission_orders" DROP CONSTRAINT "commission_orders_closed_check";--> statement-breakpoint
ALTER TABLE "commission_reservations" DROP CONSTRAINT "commission_reservations_state_check";--> statement-breakpoint
ALTER TABLE "commission_orders" ADD COLUMN "completion_floor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_floor_check" CHECK ("commission_orders"."completion_floor_at" is null or coalesce(
    "commission_orders"."delivered_at" is not null and "commission_orders"."state" in ('delivered','completed','closed') and "commission_orders"."completion_floor_at" > "commission_orders"."review_ends_at", false));--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_completion_check" CHECK (coalesce((("commission_orders"."state" in ('in_progress','delivered','completed')
      or ("commission_orders"."state" = 'closed' and "commission_orders"."close_reason" in ('cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen')))
      and "commission_orders"."confirmed_at" is not null and "commission_orders"."due_at" > "commission_orders"."confirmed_at")
    or (("commission_orders"."state" in ('requested','quoted','awaiting_payment')
      or ("commission_orders"."state" = 'closed' and "commission_orders"."close_reason" not in ('cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen')))
      and "commission_orders"."confirmed_at" is null and "commission_orders"."due_at" is null), false));--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_fulfillment_check" CHECK ("commission_orders"."revisions_used" between 0 and 10 and coalesce(
    (("commission_orders"."state" in ('requested','quoted','awaiting_payment') or ("commission_orders"."state" = 'closed' and "commission_orders"."close_reason" not in ('cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen')))
      and "commission_orders"."revisions_used" = 0 and "commission_orders"."delivered_at" is null and "commission_orders"."review_ends_at" is null and "commission_orders"."completed_at" is null and "commission_orders"."completion_kind" is null)
    or ("commission_orders"."state" = 'closed' and "commission_orders"."close_reason" in ('cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen')
      and "commission_orders"."completed_at" is null and "commission_orders"."completion_kind" is null
      and (("commission_orders"."delivered_at" is null and "commission_orders"."review_ends_at" is null) or ("commission_orders"."delivered_at" is not null and "commission_orders"."review_ends_at" > "commission_orders"."delivered_at")))
    or ("commission_orders"."state" = 'in_progress' and "commission_orders"."delivered_at" is null and "commission_orders"."review_ends_at" is null and "commission_orders"."completed_at" is null and "commission_orders"."completion_kind" is null)
    or ("commission_orders"."state" = 'delivered' and "commission_orders"."delivered_at" is not null and "commission_orders"."review_ends_at" > "commission_orders"."delivered_at" and "commission_orders"."completed_at" is null and "commission_orders"."completion_kind" is null)
    or ("commission_orders"."state" = 'completed' and "commission_orders"."delivered_at" is not null and "commission_orders"."review_ends_at" > "commission_orders"."delivered_at" and "commission_orders"."completed_at" >= "commission_orders"."delivered_at" and "commission_orders"."completed_at" = "commission_orders"."updated_at"
      and "commission_orders"."completion_kind" in ('buyer_accepted','review_window_elapsed','agreement','ruling') and ("commission_orders"."completion_kind" <> 'review_window_elapsed' or "commission_orders"."completed_at" >= coalesce("commission_orders"."completion_floor_at", "commission_orders"."review_ends_at"))), false));--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_closed_check" CHECK (("commission_orders"."state" = 'closed' and "commission_orders"."closed_at" is not null and "commission_orders"."close_reason" is not null
    and "commission_orders"."close_reason" in ('buyer_withdrawn','creator_declined','quote_withdrawn','quote_declined','request_expired','quote_expired','buyer_cancelled','creator_cancelled','payment_expired','security_invalidated','eligibility_invalidated','cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen'))
    or ("commission_orders"."state" <> 'closed' and "commission_orders"."closed_at" is null and "commission_orders"."close_reason" is null));--> statement-breakpoint
ALTER TABLE "commission_reservations" ADD CONSTRAINT "commission_reservations_state_check" CHECK (("commission_reservations"."state" = 'reserved' and "commission_reservations"."occupied_at" is null and "commission_reservations"."released_at" is null)
    or ("commission_reservations"."state" = 'occupied' and "commission_reservations"."occupied_at" is not null and "commission_reservations"."occupied_at" >= "commission_reservations"."reserved_at" and "commission_reservations"."released_at" is null)
    or ("commission_reservations"."state" = 'released' and "commission_reservations"."occupied_at" is null and "commission_reservations"."released_at" is not null and "commission_reservations"."released_at" >= "commission_reservations"."reserved_at")
    or ("commission_reservations"."state" = 'completed' and "commission_reservations"."occupied_at" is not null and "commission_reservations"."released_at" is not null and "commission_reservations"."released_at" >= "commission_reservations"."occupied_at")
    or ("commission_reservations"."state" = 'cancelled' and "commission_reservations"."occupied_at" is not null and "commission_reservations"."released_at" is not null and "commission_reservations"."released_at" >= "commission_reservations"."occupied_at"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_guard_order() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE revision commission_package_revisions%ROWTYPE; total integer; allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission orders cannot be deleted' USING ERRCODE = '23514'; END IF;
  PERFORM commission_try_creator_fence(NEW.creator_user_id);
  SELECT * INTO revision FROM commission_package_revisions WHERE id = NEW.package_revision_id;
  IF NOT FOUND OR revision.route <> NEW.route OR revision.creator_user_id <> NEW.creator_user_id THEN
    RAISE EXCEPTION 'Commission package contract mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.state NOT IN ('requested','awaiting_payment')
      OR (NEW.route = 'fixed_immediate' AND NEW.state <> 'awaiting_payment')
      OR (NEW.route <> 'fixed_immediate' AND NEW.state <> 'requested') THEN
      RAISE EXCEPTION 'Invalid initial commission state' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO total FROM commission_orders WHERE creator_user_id = NEW.creator_user_id AND buyer_user_id = NEW.buyer_user_id AND state NOT IN ('closed','completed');
    IF total >= 3 THEN RAISE EXCEPTION 'Commission request limit reached' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.creator_user_id <> OLD.creator_user_id OR NEW.buyer_user_id <> OLD.buyer_user_id
      OR NEW.package_id <> OLD.package_id OR NEW.package_revision_id <> OLD.package_revision_id OR NEW.route <> OLD.route
      OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'Commission identity/version is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'requested' THEN
      allowed := NEW.revisions_used = OLD.revisions_used AND (NEW.state IN ('quoted','awaiting_payment') OR (NEW.state = 'closed' AND NEW.close_reason IN ('buyer_withdrawn','creator_declined','request_expired','security_invalidated','eligibility_invalidated')));
    ELSIF OLD.state = 'quoted' THEN
      allowed := NEW.revisions_used = OLD.revisions_used AND (NEW.state IN ('quoted','awaiting_payment') OR (NEW.state = 'closed' AND NEW.close_reason IN ('buyer_withdrawn','quote_withdrawn','quote_declined','quote_expired','security_invalidated','eligibility_invalidated')));
    ELSIF OLD.state = 'awaiting_payment' THEN
      allowed := NEW.revisions_used = OLD.revisions_used AND (NEW.state = 'in_progress' OR (NEW.state = 'closed' AND NEW.close_reason IN ('buyer_cancelled','creator_cancelled','payment_expired','security_invalidated','eligibility_invalidated')));
    ELSIF OLD.state = 'in_progress' THEN
      allowed := (NEW.state = 'delivered' AND NEW.revisions_used = OLD.revisions_used)
        OR (NEW.state = 'in_progress' AND NEW.revisions_used = OLD.revisions_used + 1)
        OR (NEW.state = 'closed' AND NEW.close_reason IN ('cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen')
          AND NEW.revisions_used = OLD.revisions_used AND NEW.delivered_at IS NOT DISTINCT FROM OLD.delivered_at AND NEW.review_ends_at IS NOT DISTINCT FROM OLD.review_ends_at);
    ELSIF OLD.state = 'delivered' THEN
      allowed := (NEW.state = 'in_progress' AND NEW.revisions_used = OLD.revisions_used + 1 AND NEW.completion_floor_at IS NULL)
        OR (NEW.state = 'completed' AND NEW.revisions_used = OLD.revisions_used)
        OR (NEW.state = 'closed' AND NEW.close_reason IN ('cancelled_by_agreement','cancelled_by_ruling','buyer_cancelled_after_suspension','fulfillment_frozen')
          AND NEW.revisions_used = OLD.revisions_used AND NEW.delivered_at IS NOT DISTINCT FROM OLD.delivered_at AND NEW.review_ends_at IS NOT DISTINCT FROM OLD.review_ends_at)
        OR (NEW.state = 'delivered' AND to_jsonb(NEW) - ARRAY['completion_floor_at','version','updated_at'] IS NOT DISTINCT FROM to_jsonb(OLD) - ARRAY['completion_floor_at','version','updated_at']
          AND NEW.completion_floor_at > coalesce(OLD.completion_floor_at, OLD.review_ends_at));
    END IF;
    IF NOT coalesce(allowed, false) THEN RAISE EXCEPTION 'Forbidden commission transition' USING ERRCODE = '23514'; END IF;
    IF NEW.completion_floor_at IS DISTINCT FROM OLD.completion_floor_at AND NOT (OLD.state = 'delivered' AND NEW.state IN ('delivered','in_progress')) THEN
      RAISE EXCEPTION 'Commission completion floor is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.accepted_at IS NOT NULL AND (NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
      OR NEW.current_quote_id IS DISTINCT FROM OLD.current_quote_id OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
      RAISE EXCEPTION 'Accepted commission facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.due_at IS DISTINCT FROM OLD.due_at) THEN
      RAISE EXCEPTION 'Confirmed commission facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('requested','quoted','awaiting_payment') AND OLD.expires_at <= NEW.updated_at AND NEW.state <> 'closed' THEN
      RAISE EXCEPTION 'Expired commission cannot advance' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'quoted' AND NEW.current_quote_id IS NOT DISTINCT FROM OLD.current_quote_id THEN
      RAISE EXCEPTION 'Quote replacement requires a new revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_guard_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE; capacity integer; used integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission reservation history is required' USING ERRCODE = '23514'; END IF;
  PERFORM commission_try_creator_fence(NEW.creator_user_id);
  SELECT * INTO subject FROM commission_orders WHERE id = NEW.order_id;
  IF NOT FOUND OR subject.creator_user_id <> NEW.creator_user_id THEN RAISE EXCEPTION 'Reservation owner mismatch' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT capacity_limit INTO capacity FROM creator_commission_settings WHERE creator_user_id = NEW.creator_user_id;
    SELECT count(*) INTO used FROM commission_reservations WHERE creator_user_id = NEW.creator_user_id AND state IN ('reserved','occupied');
    IF capacity IS NULL OR used >= capacity OR NEW.state <> 'reserved' THEN RAISE EXCEPTION 'Commission capacity unavailable' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.order_id <> OLD.order_id OR NEW.creator_user_id <> OLD.creator_user_id OR NEW.reserved_at <> OLD.reserved_at
      OR NOT ((OLD.state = 'reserved' AND NEW.state IN ('occupied','released'))
        OR (OLD.state = 'occupied' AND NEW.state IN ('completed','cancelled') AND NEW.occupied_at = OLD.occupied_at)) THEN
      RAISE EXCEPTION 'Forbidden reservation transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_check_order_graph() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE target_id uuid; subject commission_orders%ROWTYPE; brief commission_briefs%ROWTYPE;
  snapshot commission_terms_snapshots%ROWTYPE; quote commission_quote_revisions%ROWTYPE;
  reservation commission_reservations%ROWTYPE; package commission_package_revisions%ROWTYPE;
  buyer commission_acceptances%ROWTYPE; creator commission_acceptances%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'commission_orders' THEN target_id := NEW.id; ELSE target_id := NEW.order_id; END IF;
  SELECT * INTO subject FROM commission_orders WHERE id = target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission aggregate is missing' USING ERRCODE = '23514'; END IF;
  SELECT * INTO brief FROM commission_briefs WHERE order_id = target_id;
  IF NOT FOUND OR brief.created_at <> subject.created_at THEN RAISE EXCEPTION 'Commission brief must commit with order' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commission_events WHERE order_id = target_id AND order_version = subject.version AND type = subject.state AND occurred_at = subject.updated_at) THEN
    RAISE EXCEPTION 'Commission transition evidence must commit together' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO package FROM commission_package_revisions WHERE id = subject.package_revision_id;
  SELECT * INTO buyer FROM commission_acceptances WHERE order_id = target_id AND role = 'buyer';
  SELECT * INTO creator FROM commission_acceptances WHERE order_id = target_id AND role = 'creator';
  IF buyer.id IS NOT NULL AND (buyer.actor_user_id <> subject.buyer_user_id OR buyer.package_revision_id <> subject.package_revision_id OR buyer.accepted_at < subject.created_at) THEN
    RAISE EXCEPTION 'Commission buyer acceptance mismatch' USING ERRCODE = '23514';
  END IF;
  IF creator.id IS NOT NULL AND (creator.actor_user_id <> subject.creator_user_id OR creator.package_revision_id <> subject.package_revision_id) THEN
    RAISE EXCEPTION 'Commission creator acceptance mismatch' USING ERRCODE = '23514';
  END IF;
  IF subject.route <> 'custom_quote' AND (buyer.id IS NULL OR buyer.policy_revision_id <> package.policy_revision_id OR buyer.quote_revision_id IS NOT NULL OR buyer.accepted_at <> subject.created_at) THEN
    RAISE EXCEPTION 'Fixed commission requires original buyer acceptance' USING ERRCODE = '23514';
  END IF;
  IF subject.current_quote_id IS NOT NULL THEN
    SELECT * INTO quote FROM commission_quote_revisions WHERE id = subject.current_quote_id;
    IF NOT FOUND OR subject.route <> 'custom_quote' OR quote.order_id <> target_id
      OR quote.issued_at < subject.created_at OR quote.expires_at > subject.created_at + interval '30 days'
      OR (subject.state = 'quoted' AND subject.expires_at <> quote.expires_at) THEN
      RAISE EXCEPTION 'Commission quote binding/deadline mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO snapshot FROM commission_terms_snapshots WHERE order_id = target_id;
  SELECT * INTO reservation FROM commission_reservations WHERE order_id = target_id;
  IF subject.accepted_at IS NULL THEN
    IF snapshot.order_id IS NOT NULL OR reservation.order_id IS NOT NULL OR creator.id IS NOT NULL
      OR (subject.route = 'custom_quote' AND buyer.id IS NOT NULL) THEN
      RAISE EXCEPTION 'Unaccepted commission cannot reserve or lock terms' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF snapshot.order_id IS NULL OR reservation.order_id IS NULL OR buyer.id IS NULL OR creator.id IS NULL
      OR snapshot.package_revision_id <> subject.package_revision_id OR snapshot.amount_vnd <> subject.amount_vnd
      OR snapshot.created_at <> subject.accepted_at OR snapshot.buyer_accepted_at <> buyer.accepted_at
      OR snapshot.creator_accepted_at <> creator.accepted_at OR buyer.policy_revision_id <> snapshot.policy_revision_id
      OR creator.policy_revision_id <> snapshot.policy_revision_id OR reservation.creator_user_id <> subject.creator_user_id
      OR reservation.reserved_at <> subject.accepted_at OR subject.expires_at <> subject.accepted_at + interval '24 hours' THEN
      RAISE EXCEPTION 'Commission commitment must be atomic and exact' USING ERRCODE = '23514';
    END IF;
    IF subject.route = 'custom_quote' THEN
      IF quote.id IS NULL OR snapshot.quote_revision_id IS DISTINCT FROM quote.id
        OR buyer.quote_revision_id IS DISTINCT FROM quote.id OR creator.quote_revision_id IS DISTINCT FROM quote.id
        OR snapshot.policy_revision_id <> quote.policy_revision_id OR snapshot.amount_vnd <> quote.amount_vnd
        OR snapshot.turnaround_days <> quote.turnaround_days OR snapshot.revision_allowance <> quote.revision_allowance
        OR snapshot.review_window_days <> quote.review_window_days OR subject.accepted_at >= quote.expires_at THEN
        RAISE EXCEPTION 'Accepted quote must match the locked terms' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF snapshot.quote_revision_id IS NOT NULL OR creator.quote_revision_id IS NOT NULL OR snapshot.policy_revision_id <> package.policy_revision_id
        OR snapshot.amount_vnd <> (package.terms->>'amountVnd')::bigint
        OR snapshot.turnaround_days <> (package.terms->>'turnaroundDays')::integer
        OR snapshot.revision_allowance <> (package.terms->>'revisionAllowance')::integer
        OR snapshot.review_window_days <> (package.terms->>'reviewWindowDays')::integer THEN
        RAISE EXCEPTION 'Fixed commitment must retain original package terms' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF (subject.state = 'awaiting_payment' AND reservation.state <> 'reserved')
      OR (subject.state IN ('in_progress','delivered') AND (reservation.state <> 'occupied' OR reservation.occupied_at IS DISTINCT FROM subject.confirmed_at
        OR subject.due_at IS DISTINCT FROM subject.confirmed_at + snapshot.turnaround_days * interval '24 hours'))
      OR (subject.state = 'completed' AND (reservation.state <> 'completed' OR reservation.occupied_at IS DISTINCT FROM subject.confirmed_at
        OR reservation.released_at IS DISTINCT FROM subject.completed_at
        OR subject.due_at IS DISTINCT FROM subject.confirmed_at + snapshot.turnaround_days * interval '24 hours'))
      OR (subject.state = 'closed' AND subject.confirmed_at IS NOT NULL AND (reservation.state <> 'cancelled' OR reservation.occupied_at IS DISTINCT FROM subject.confirmed_at
        OR reservation.released_at IS DISTINCT FROM subject.closed_at
        OR subject.due_at IS DISTINCT FROM subject.confirmed_at + snapshot.turnaround_days * interval '24 hours'))
      OR (subject.state = 'closed' AND subject.confirmed_at IS NULL AND (reservation.state <> 'released' OR reservation.released_at IS DISTINCT FROM subject.closed_at)) THEN
      RAISE EXCEPTION 'Commission reservation/fulfillment mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF ((subject.state IN ('delivered','completed') OR (subject.state = 'closed' AND subject.delivered_at IS NOT NULL))
      AND subject.review_ends_at IS DISTINCT FROM subject.delivered_at + snapshot.review_window_days * interval '24 hours')
    OR subject.revisions_used > snapshot.revision_allowance THEN
    RAISE EXCEPTION 'Commission reservation/fulfillment mismatch' USING ERRCODE = '23514';
  END IF;
  PERFORM commission_check_fulfillment(target_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_check_fulfillment(target_order_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE; changes bigint; open_finals bigint;
BEGIN
  SELECT * INTO subject FROM commission_orders WHERE id = target_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission aggregate is missing' USING ERRCODE = '23514'; END IF;
  SELECT count(*) FILTER (WHERE response = 'changes_requested'), count(*) FILTER (WHERE kind = 'final' AND response IS NULL)
    INTO changes, open_finals FROM commission_submissions WHERE order_id = target_order_id;
  IF subject.revisions_used <> changes
    OR (subject.confirmed_at IS NULL AND EXISTS (SELECT 1 FROM commission_submissions WHERE order_id = target_order_id))
    OR EXISTS (SELECT 1 FROM commission_submissions WHERE order_id = target_order_id AND submitted_at < subject.confirmed_at)
    OR ((subject.state IN ('delivered','completed') OR (subject.state = 'closed' AND subject.confirmed_at IS NOT NULL AND subject.delivered_at IS NOT NULL)) AND (open_finals <> 1
      OR NOT EXISTS (SELECT 1 FROM commission_submissions WHERE order_id = target_order_id AND kind = 'final' AND response IS NULL AND submitted_at = subject.delivered_at)
      OR EXISTS (SELECT 1 FROM commission_submissions WHERE order_id = target_order_id AND submitted_at > subject.delivered_at)))
    OR ((subject.state = 'in_progress' OR (subject.state = 'closed' AND subject.confirmed_at IS NOT NULL AND subject.delivered_at IS NULL)) AND open_finals <> 0) THEN
    RAISE EXCEPTION 'Commission reservation/fulfillment mismatch' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_check_payment(target_order_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE order_row commission_orders%ROWTYPE; intent payment_intents%ROWTYPE;
  confirmation payment_confirmations%ROWTYPE;
BEGIN
  SELECT * INTO order_row FROM commission_orders WHERE id = target_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'commission payment requires an order' USING ERRCODE = '23514'; END IF;
  SELECT * INTO intent FROM payment_intents WHERE commission_order_id = target_order_id;
  IF order_row.accepted_at IS NULL THEN
    IF intent.id IS NOT NULL THEN RAISE EXCEPTION 'unaccepted order cannot have a payment' USING ERRCODE = '23514'; END IF;
    RETURN;
  END IF;
  IF intent.id IS NULL OR intent.purpose <> 'commission' OR intent.tip_id IS NOT NULL
    OR intent.creator_user_id <> order_row.creator_user_id OR intent.amount_vnd <> order_row.amount_vnd
    OR intent.created_at <> order_row.accepted_at OR intent.expires_at <> order_row.expires_at
    OR (order_row.state = 'awaiting_payment' AND intent.state <> 'awaiting_transfer')
    OR ((order_row.state IN ('in_progress','delivered','completed') OR (order_row.state = 'closed' AND order_row.confirmed_at IS NOT NULL))
      AND (intent.state <> 'confirmed' OR intent.closed_at IS DISTINCT FROM order_row.confirmed_at))
    OR (order_row.state = 'closed' AND order_row.confirmed_at IS NULL AND (intent.closed_at IS DISTINCT FROM order_row.closed_at
      OR (order_row.close_reason = 'payment_expired' AND intent.state <> 'expired')
      OR (order_row.close_reason <> 'payment_expired' AND (intent.state <> 'rejected' OR intent.rejection_reason IS DISTINCT FROM order_row.close_reason)))) THEN
    RAISE EXCEPTION 'commission and payment must commit atomically' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_guest_capabilities WHERE payment_intent_id = intent.id) THEN
    RAISE EXCEPTION 'commission cannot use a guest payment capability' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO confirmation FROM payment_confirmations WHERE payment_intent_id = intent.id;
  IF (intent.state = 'confirmed' AND (confirmation.id IS NULL OR confirmation.confirmed_at <> intent.closed_at))
    OR (intent.state <> 'confirmed' AND confirmation.id IS NOT NULL) THEN
    RAISE EXCEPTION 'payment confirmation evidence must commit atomically' USING ERRCODE = '23514';
  END IF;
END;
$$;
