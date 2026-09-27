ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_rejection_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "tip_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "commission_order_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_commission_binding_fk" FOREIGN KEY ("commission_order_id","creator_user_id","amount_vnd") REFERENCES "commission_orders"("id","creator_user_id","amount_vnd") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_commission_uidx" ON "payment_intents" USING btree ("commission_order_id");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."currency" = 'VND' and (
    ("payment_intents"."purpose" = 'tip' and "payment_intents"."tip_id" is not null and "payment_intents"."commission_order_id" is null)
    or ("payment_intents"."purpose" = 'commission' and "payment_intents"."commission_order_id" is not null and "payment_intents"."tip_id" is null)));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_rejection_check" CHECK (("payment_intents"."state" = 'rejected' and "payment_intents"."rejection_reason" is not null and (
    "payment_intents"."rejection_reason" in ('policy_invalidated','security_invalidated')
    or ("payment_intents"."purpose" = 'commission' and "payment_intents"."rejection_reason" in ('buyer_cancelled','creator_cancelled','eligibility_invalidated'))))
    or ("payment_intents"."state" <> 'rejected' and "payment_intents"."rejection_reason" is null));
--> statement-breakpoint
-- This check is deferred because Orders and Payments commit in one transaction.
-- Requests that have not been accepted must never acquire a payable intent.
CREATE FUNCTION commission_check_payment(target_order_id uuid) RETURNS void
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
    OR (order_row.state = 'in_progress' AND (intent.state <> 'confirmed' OR intent.closed_at IS DISTINCT FROM order_row.confirmed_at))
    OR (order_row.state = 'closed' AND (intent.closed_at IS DISTINCT FROM order_row.closed_at
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION increment_four_check_payment_consistency() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE tip_row tips%ROWTYPE; intent payment_intents%ROWTYPE; confirmation payment_confirmations%ROWTYPE;
  capability payment_guest_capabilities%ROWTYPE; target_tip_id uuid; expected_tip_state text;
BEGIN
  IF TG_TABLE_NAME = 'commission_orders' THEN
    PERFORM commission_check_payment(NEW.id); RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'tips' THEN target_tip_id := NEW.id;
  ELSE
    IF TG_TABLE_NAME = 'payment_intents' THEN SELECT * INTO intent FROM payment_intents WHERE id = NEW.id;
    ELSE SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id;
    END IF;
    IF intent.purpose = 'commission' THEN
      PERFORM commission_check_payment(intent.commission_order_id); RETURN NULL;
    END IF;
    target_tip_id := intent.tip_id;
  END IF;
  -- Preserve the released tip lifecycle and guest-receipt rules unchanged.
  SELECT * INTO tip_row FROM tips WHERE id = target_tip_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment must belong to a tip' USING ERRCODE = '23514'; END IF;
  SELECT * INTO intent FROM payment_intents WHERE tip_id = target_tip_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tip requires exactly one payment intent' USING ERRCODE = '23514'; END IF;
  expected_tip_state := CASE intent.state WHEN 'awaiting_transfer' THEN 'awaiting_payment'
    WHEN 'confirmed' THEN 'completed' ELSE intent.state END;
  IF tip_row.state <> expected_tip_state OR tip_row.closed_at IS DISTINCT FROM intent.closed_at
    OR tip_row.created_at <> intent.created_at THEN
    RAISE EXCEPTION 'tip and payment lifecycle must commit atomically' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO capability FROM payment_guest_capabilities WHERE payment_intent_id = intent.id;
  IF (tip_row.buyer_user_id IS NULL AND (capability.id IS NULL OR capability.created_at <> intent.created_at OR capability.expires_at < intent.expires_at))
    OR (tip_row.buyer_user_id IS NOT NULL AND capability.id IS NOT NULL) THEN
    RAISE EXCEPTION 'tip capability ownership or lifetime is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO confirmation FROM payment_confirmations WHERE payment_intent_id = intent.id;
  IF (intent.state = 'confirmed' AND (confirmation.id IS NULL OR confirmation.confirmed_at <> intent.closed_at))
    OR (intent.state <> 'confirmed' AND confirmation.id IS NOT NULL) THEN
    RAISE EXCEPTION 'payment confirmation evidence must commit atomically' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_orders_payment_consistency AFTER INSERT OR UPDATE ON commission_orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION increment_four_check_payment_consistency();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_guard_claim_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE intent payment_intents%ROWTYPE; buyer_id text;
BEGIN
  SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id FOR UPDATE;
  IF NOT FOUND OR intent.state <> 'awaiting_transfer' OR NEW.claimed_at < intent.created_at OR NEW.claimed_at >= intent.expires_at THEN
    RAISE EXCEPTION 'transfer claims require a pending unexpired intent' USING ERRCODE = '23514';
  END IF;
  IF intent.purpose = 'commission' THEN
    SELECT buyer_user_id INTO buyer_id FROM commission_orders WHERE id = intent.commission_order_id;
    IF buyer_id IS NULL OR NEW.access_kind <> 'buyer' OR NEW.buyer_user_id IS DISTINCT FROM buyer_id THEN
      RAISE EXCEPTION 'commission transfer claim requires its buyer' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT buyer_user_id INTO buyer_id FROM tips WHERE id = intent.tip_id;
    IF (NEW.access_kind = 'buyer' AND NEW.buyer_user_id IS DISTINCT FROM buyer_id)
      OR (NEW.access_kind = 'guest' AND (buyer_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM payment_guest_capabilities capability
        WHERE capability.id = NEW.guest_capability_id AND capability.payment_intent_id = intent.id
          AND capability.created_at <= NEW.claimed_at AND capability.expires_at > NEW.claimed_at
      ))) THEN
      RAISE EXCEPTION 'transfer claim access binding is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sepay_check_transaction_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_confirmations confirmation
    JOIN payment_intents intent ON intent.id = confirmation.payment_intent_id
    WHERE confirmation.provider_transaction_id = NEW.id AND confirmation.payment_intent_id = NEW.payment_intent_id
      AND confirmation.source IN ('sepay_automatic','creator_reviewed_sepay') AND intent.state = 'confirmed'
      AND ((intent.purpose = 'tip' AND EXISTS (SELECT 1 FROM tips tip WHERE tip.id = intent.tip_id AND tip.state = 'completed'))
        OR (intent.purpose = 'commission' AND EXISTS (SELECT 1 FROM commission_orders orders
          WHERE orders.id = intent.commission_order_id AND orders.state = 'in_progress')))) THEN
    RAISE EXCEPTION 'SePay transaction reservation and confirmation must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
