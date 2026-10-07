CREATE TABLE "commission_dispute_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"author_role" text NOT NULL,
	"kind" text NOT NULL,
	"text_envelope" jsonb NOT NULL,
	"requested_outcome" text,
	"requested_refund_vnd" bigint,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_dispute_statements_role_check" CHECK ("commission_dispute_statements"."author_role" in ('buyer','creator','owner')),
	CONSTRAINT "commission_dispute_statements_kind_check" CHECK ("commission_dispute_statements"."kind" in ('opening','response','statement','question')),
	CONSTRAINT "commission_dispute_statements_outcome_check" CHECK (("commission_dispute_statements"."requested_outcome" is null and "commission_dispute_statements"."requested_refund_vnd" is null)
    or ("commission_dispute_statements"."requested_outcome" is not null and "commission_dispute_statements"."requested_outcome" in ('complete','close') and "commission_dispute_statements"."requested_refund_vnd" is not null and "commission_dispute_statements"."requested_refund_vnd" between 0 and 50000000)),
	CONSTRAINT "commission_dispute_statements_text_check" CHECK (coalesce(
  jsonb_typeof("commission_dispute_statements"."text_envelope") = 'object' and octet_length("commission_dispute_statements"."text_envelope"::text) <= 24000
  and "commission_dispute_statements"."text_envelope"->'version' = '1'::jsonb and "commission_dispute_statements"."text_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_dispute_statements"."text_envelope"->'keyId') = 'string' and "commission_dispute_statements"."text_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_dispute_statements"."text_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_dispute_statements"."text_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_dispute_statements"."text_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_dispute_statements"."text_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_dispute_statements_actor_check" CHECK ("commission_dispute_statements"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_dispute_statements_request_check" CHECK ("commission_dispute_statements"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_dispute_statements_version_check" CHECK ("commission_dispute_statements"."version" = 1)
);
--> statement-breakpoint
CREATE TABLE "commission_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"opener_user_id" text NOT NULL,
	"opener_role" text NOT NULL,
	"trigger" text NOT NULL,
	"trigger_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"requested_outcome" text NOT NULL,
	"requested_refund_vnd" bigint NOT NULL,
	"order_state_at_open" text NOT NULL,
	"remaining_review_ms" bigint,
	"respond_by" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_disputes_role_check" CHECK ("commission_disputes"."opener_role" in ('buyer','creator')),
	CONSTRAINT "commission_disputes_trigger_check" CHECK ("commission_disputes"."trigger" in ('final_delivery','overdue','proposal_declined') and "commission_disputes"."trigger_at" <= "commission_disputes"."opened_at"),
	CONSTRAINT "commission_disputes_reason_check" CHECK ("commission_disputes"."reason" in ('not_delivered','not_as_agreed','incomplete_delivery','creator_cannot_complete','communication_breakdown','other')),
	CONSTRAINT "commission_disputes_outcome_check" CHECK ("commission_disputes"."requested_outcome" in ('complete','close') and "commission_disputes"."requested_refund_vnd" between 0 and 50000000),
	CONSTRAINT "commission_disputes_review_check" CHECK (("commission_disputes"."order_state_at_open" = 'in_progress' and "commission_disputes"."remaining_review_ms" is null)
    or ("commission_disputes"."order_state_at_open" = 'delivered' and "commission_disputes"."remaining_review_ms" is not null and "commission_disputes"."remaining_review_ms" >= 0)),
	CONSTRAINT "commission_disputes_state_check" CHECK (("commission_disputes"."state" = 'open' and "commission_disputes"."closed_at" is null)
    or ("commission_disputes"."state" in ('withdrawn','settled','ruled','superseded') and "commission_disputes"."closed_at" is not null and "commission_disputes"."closed_at" >= "commission_disputes"."opened_at")),
	CONSTRAINT "commission_disputes_deadline_check" CHECK ("commission_disputes"."respond_by" >= "commission_disputes"."opened_at" + interval '5 days' and "commission_disputes"."respond_by" <= "commission_disputes"."opened_at" + interval '14 days'),
	CONSTRAINT "commission_disputes_version_check" CHECK ("commission_disputes"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "commission_late_payment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"buyer_user_id" text NOT NULL,
	"transfer_at" timestamp with time zone NOT NULL,
	"claimed_amount_vnd" bigint NOT NULL,
	"reference_envelope" jsonb NOT NULL,
	"note_envelope" jsonb,
	"state" text DEFAULT 'awaiting_creator' NOT NULL,
	"creator_respond_by" timestamp with time zone NOT NULL,
	"received_amount_vnd" bigint,
	"filed_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_late_payment_claims_amount_check" CHECK ("commission_late_payment_claims"."claimed_amount_vnd" between 1 and 50000000
    and ("commission_late_payment_claims"."received_amount_vnd" is null or "commission_late_payment_claims"."received_amount_vnd" between 1 and 50000000)),
	CONSTRAINT "commission_late_payment_claims_state_check" CHECK (("commission_late_payment_claims"."state" = 'awaiting_creator' and "commission_late_payment_claims"."ended_at" is null and "commission_late_payment_claims"."received_amount_vnd" is null)
    or ("commission_late_payment_claims"."state" = 'escalated' and "commission_late_payment_claims"."ended_at" is null and "commission_late_payment_claims"."received_amount_vnd" is null)
    or ("commission_late_payment_claims"."state" = 'refund_owed' and "commission_late_payment_claims"."ended_at" is not null and "commission_late_payment_claims"."received_amount_vnd" is not null)
    or ("commission_late_payment_claims"."state" = 'rejected' and "commission_late_payment_claims"."ended_at" is not null and "commission_late_payment_claims"."received_amount_vnd" is null)),
	CONSTRAINT "commission_late_payment_claims_time_check" CHECK ("commission_late_payment_claims"."transfer_at" <= "commission_late_payment_claims"."filed_at" and "commission_late_payment_claims"."creator_respond_by" = "commission_late_payment_claims"."filed_at" + interval '5 days'
    and ("commission_late_payment_claims"."ended_at" is null or "commission_late_payment_claims"."ended_at" >= "commission_late_payment_claims"."filed_at")),
	CONSTRAINT "commission_late_payment_claims_text_check" CHECK (coalesce(
  jsonb_typeof("commission_late_payment_claims"."reference_envelope") = 'object' and octet_length("commission_late_payment_claims"."reference_envelope"::text) <= 24000
  and "commission_late_payment_claims"."reference_envelope"->'version' = '1'::jsonb and "commission_late_payment_claims"."reference_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_late_payment_claims"."reference_envelope"->'keyId') = 'string' and "commission_late_payment_claims"."reference_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_late_payment_claims"."reference_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_late_payment_claims"."reference_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_late_payment_claims"."reference_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_late_payment_claims"."reference_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false) and ("commission_late_payment_claims"."note_envelope" is null or coalesce(
  jsonb_typeof("commission_late_payment_claims"."note_envelope") = 'object' and octet_length("commission_late_payment_claims"."note_envelope"::text) <= 24000
  and "commission_late_payment_claims"."note_envelope"->'version' = '1'::jsonb and "commission_late_payment_claims"."note_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_late_payment_claims"."note_envelope"->'keyId') = 'string' and "commission_late_payment_claims"."note_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_late_payment_claims"."note_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_late_payment_claims"."note_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_late_payment_claims"."note_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_late_payment_claims"."note_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))),
	CONSTRAINT "commission_late_payment_claims_version_check" CHECK ("commission_late_payment_claims"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "commission_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"proposer_user_id" text NOT NULL,
	"proposer_role" text NOT NULL,
	"kind" text NOT NULL,
	"refund_amount_vnd" bigint NOT NULL,
	"note_envelope" jsonb NOT NULL,
	"order_state_at_creation" text NOT NULL,
	"remaining_review_ms" bigint,
	"state" text DEFAULT 'pending' NOT NULL,
	"respond_by" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" text,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_proposals_role_check" CHECK ("commission_proposals"."proposer_role" in ('buyer','creator')),
	CONSTRAINT "commission_proposals_kind_check" CHECK ("commission_proposals"."kind" in ('cancel_with_refund','complete_with_refund')
    and "commission_proposals"."refund_amount_vnd" between 0 and 50000000
    and ("commission_proposals"."kind" <> 'complete_with_refund' or ("commission_proposals"."order_state_at_creation" = 'delivered' and "commission_proposals"."refund_amount_vnd" >= 1))),
	CONSTRAINT "commission_proposals_review_check" CHECK (("commission_proposals"."order_state_at_creation" = 'in_progress' and "commission_proposals"."remaining_review_ms" is null)
    or ("commission_proposals"."order_state_at_creation" = 'delivered' and "commission_proposals"."remaining_review_ms" is not null and "commission_proposals"."remaining_review_ms" >= 0)),
	CONSTRAINT "commission_proposals_state_check" CHECK (("commission_proposals"."state" = 'pending' and "commission_proposals"."ended_at" is null and "commission_proposals"."ended_by_user_id" is null)
    or ("commission_proposals"."state" in ('accepted','declined','withdrawn','expired','lapsed','superseded') and "commission_proposals"."ended_at" is not null and "commission_proposals"."ended_at" >= "commission_proposals"."created_at")),
	CONSTRAINT "commission_proposals_deadline_check" CHECK ("commission_proposals"."respond_by" = "commission_proposals"."created_at" + interval '72 hours'),
	CONSTRAINT "commission_proposals_note_check" CHECK (coalesce(
  jsonb_typeof("commission_proposals"."note_envelope") = 'object' and octet_length("commission_proposals"."note_envelope"::text) <= 24000
  and "commission_proposals"."note_envelope"->'version' = '1'::jsonb and "commission_proposals"."note_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_proposals"."note_envelope"->'keyId') = 'string' and "commission_proposals"."note_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_proposals"."note_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_proposals"."note_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_proposals"."note_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_proposals"."note_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_proposals_actor_check" CHECK ("commission_proposals"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_proposals_request_check" CHECK ("commission_proposals"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_proposals_version_check" CHECK ("commission_proposals"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "commission_resolution_pauses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_resolution_pauses_time_check" CHECK ("commission_resolution_pauses"."ended_at" is null or "commission_resolution_pauses"."ended_at" >= "commission_resolution_pauses"."started_at"),
	CONSTRAINT "commission_resolution_pauses_version_check" CHECK ("commission_resolution_pauses"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "commission_ruling_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ruling_id" uuid NOT NULL,
	"refund_amount_vnd" bigint NOT NULL,
	"reason_envelope" jsonb NOT NULL,
	"effect" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"step_up_proof_id" text NOT NULL,
	"request_id" text NOT NULL,
	"corrected_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_ruling_corrections_amount_check" CHECK ("commission_ruling_corrections"."refund_amount_vnd" between 0 and 50000000),
	CONSTRAINT "commission_ruling_corrections_effect_check" CHECK ("commission_ruling_corrections"."effect" in ('increased','reduced','waived','recorded_only')),
	CONSTRAINT "commission_ruling_corrections_reason_check" CHECK (coalesce(
  jsonb_typeof("commission_ruling_corrections"."reason_envelope") = 'object' and octet_length("commission_ruling_corrections"."reason_envelope"::text) <= 24000
  and "commission_ruling_corrections"."reason_envelope"->'version' = '1'::jsonb and "commission_ruling_corrections"."reason_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_ruling_corrections"."reason_envelope"->'keyId') = 'string' and "commission_ruling_corrections"."reason_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_ruling_corrections"."reason_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_ruling_corrections"."reason_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_ruling_corrections"."reason_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_ruling_corrections"."reason_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_ruling_corrections_actor_check" CHECK ("commission_ruling_corrections"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_ruling_corrections_proof_check" CHECK ("commission_ruling_corrections"."step_up_proof_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_ruling_corrections_request_check" CHECK ("commission_ruling_corrections"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_ruling_corrections_version_check" CHECK ("commission_ruling_corrections"."version" = 1)
);
--> statement-breakpoint
CREATE TABLE "commission_rulings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"refund_amount_vnd" bigint NOT NULL,
	"reasoning_envelope" jsonb NOT NULL,
	"internal_note_envelope" jsonb,
	"policy_revision_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"step_up_proof_id" text NOT NULL,
	"request_id" text NOT NULL,
	"ruled_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commission_rulings_outcome_check" CHECK ("commission_rulings"."outcome" in ('complete','close') and "commission_rulings"."refund_amount_vnd" between 0 and 50000000),
	CONSTRAINT "commission_rulings_text_check" CHECK (coalesce(
  jsonb_typeof("commission_rulings"."reasoning_envelope") = 'object' and octet_length("commission_rulings"."reasoning_envelope"::text) <= 24000
  and "commission_rulings"."reasoning_envelope"->'version' = '1'::jsonb and "commission_rulings"."reasoning_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_rulings"."reasoning_envelope"->'keyId') = 'string' and "commission_rulings"."reasoning_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_rulings"."reasoning_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_rulings"."reasoning_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_rulings"."reasoning_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_rulings"."reasoning_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false) and ("commission_rulings"."internal_note_envelope" is null or coalesce(
  jsonb_typeof("commission_rulings"."internal_note_envelope") = 'object' and octet_length("commission_rulings"."internal_note_envelope"::text) <= 24000
  and "commission_rulings"."internal_note_envelope"->'version' = '1'::jsonb and "commission_rulings"."internal_note_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_rulings"."internal_note_envelope"->'keyId') = 'string' and "commission_rulings"."internal_note_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_rulings"."internal_note_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_rulings"."internal_note_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_rulings"."internal_note_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_rulings"."internal_note_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))),
	CONSTRAINT "commission_rulings_actor_check" CHECK ("commission_rulings"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_rulings_proof_check" CHECK ("commission_rulings"."step_up_proof_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_rulings_request_check" CHECK ("commission_rulings"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
	CONSTRAINT "commission_rulings_version_check" CHECK ("commission_rulings"."version" = 1)
);
--> statement-breakpoint
ALTER TABLE "commission_dispute_statements" ADD CONSTRAINT "commission_dispute_statements_dispute_id_commission_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "commission_disputes"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_dispute_statements" ADD CONSTRAINT "commission_dispute_statements_author_user_id_identity_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_disputes" ADD CONSTRAINT "commission_disputes_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_disputes" ADD CONSTRAINT "commission_disputes_opener_user_id_identity_users_id_fk" FOREIGN KEY ("opener_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_late_payment_claims" ADD CONSTRAINT "commission_late_payment_claims_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_late_payment_claims" ADD CONSTRAINT "commission_late_payment_claims_buyer_user_id_identity_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_proposals" ADD CONSTRAINT "commission_proposals_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_proposals" ADD CONSTRAINT "commission_proposals_proposer_user_id_identity_users_id_fk" FOREIGN KEY ("proposer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_proposals" ADD CONSTRAINT "commission_proposals_ended_by_user_id_identity_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_ruling_corrections" ADD CONSTRAINT "commission_ruling_corrections_ruling_id_commission_rulings_id_fk" FOREIGN KEY ("ruling_id") REFERENCES "commission_rulings"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_ruling_corrections" ADD CONSTRAINT "commission_ruling_corrections_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_rulings" ADD CONSTRAINT "commission_rulings_dispute_id_commission_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "commission_disputes"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_rulings" ADD CONSTRAINT "commission_rulings_policy_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "commission_rulings" ADD CONSTRAINT "commission_rulings_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "commission_dispute_statements_timeline_idx" ON "commission_dispute_statements" USING btree ("dispute_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_disputes_open_uidx" ON "commission_disputes" USING btree ("order_id") WHERE "commission_disputes"."state" = 'open';--> statement-breakpoint
CREATE INDEX "commission_disputes_order_idx" ON "commission_disputes" USING btree ("order_id","opened_at");--> statement-breakpoint
CREATE INDEX "commission_disputes_deadline_idx" ON "commission_disputes" USING btree ("state","respond_by");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_late_payment_claims_order_uidx" ON "commission_late_payment_claims" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "commission_late_payment_claims_deadline_idx" ON "commission_late_payment_claims" USING btree ("state","creator_respond_by");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_proposals_pending_uidx" ON "commission_proposals" USING btree ("order_id") WHERE "commission_proposals"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "commission_proposals_order_idx" ON "commission_proposals" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "commission_proposals_deadline_idx" ON "commission_proposals" USING btree ("state","respond_by");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_resolution_pauses_open_uidx" ON "commission_resolution_pauses" USING btree ((true)) WHERE "commission_resolution_pauses"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "commission_ruling_corrections_timeline_idx" ON "commission_ruling_corrections" USING btree ("ruling_id","corrected_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rulings_dispute_uidx" ON "commission_rulings" USING btree ("dispute_id");
--> statement-breakpoint
CREATE TRIGGER commission_dispute_statements_immutable BEFORE UPDATE OR DELETE ON commission_dispute_statements
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_rulings_immutable BEFORE UPDATE OR DELETE ON commission_rulings
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_ruling_corrections_immutable BEFORE UPDATE OR DELETE ON commission_ruling_corrections
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE FUNCTION commission_guard_proposal() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission proposals cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO subject FROM commission_orders WHERE id = NEW.order_id;
    IF NOT FOUND OR NEW.version <> 1 OR NEW.state <> 'pending' OR NEW.order_state_at_creation <> subject.state
      OR (NEW.proposer_role = 'buyer' AND NEW.proposer_user_id <> subject.buyer_user_id)
      OR (NEW.proposer_role = 'creator' AND NEW.proposer_user_id <> subject.creator_user_id)
      OR NEW.refund_amount_vnd > subject.amount_vnd
      OR (NEW.kind = 'complete_with_refund' AND NEW.refund_amount_vnd >= subject.amount_vnd) THEN
      RAISE EXCEPTION 'Invalid commission proposal binding' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.order_id, NEW.proposer_user_id, NEW.proposer_role, NEW.kind, NEW.refund_amount_vnd, NEW.note_envelope,
        NEW.order_state_at_creation, NEW.remaining_review_ms, NEW.respond_by, NEW.created_at, NEW.actor_session_id, NEW.request_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.proposer_user_id, OLD.proposer_role, OLD.kind, OLD.refund_amount_vnd, OLD.note_envelope,
        OLD.order_state_at_creation, OLD.remaining_review_ms, OLD.respond_by, OLD.created_at, OLD.actor_session_id, OLD.request_id)
      OR NEW.version <> OLD.version + 1 OR OLD.state <> 'pending' OR NEW.state = 'pending' THEN
      RAISE EXCEPTION 'Commission proposal identity or transition is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_proposals
FOR EACH ROW EXECUTE FUNCTION commission_guard_proposal();
--> statement-breakpoint
CREATE FUNCTION commission_guard_dispute() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission disputes cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO subject FROM commission_orders WHERE id = NEW.order_id;
    IF NOT FOUND OR NEW.version <> 1 OR NEW.state <> 'open' OR NEW.order_state_at_open <> subject.state
      OR NEW.respond_by <> NEW.opened_at + interval '5 days'
      OR (NEW.opener_role = 'buyer' AND NEW.opener_user_id <> subject.buyer_user_id)
      OR (NEW.opener_role = 'creator' AND NEW.opener_user_id <> subject.creator_user_id)
      OR NEW.requested_refund_vnd > subject.amount_vnd THEN
      RAISE EXCEPTION 'Invalid commission dispute binding' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.order_id, NEW.opener_user_id, NEW.opener_role, NEW.trigger, NEW.trigger_at, NEW.reason,
        NEW.requested_outcome, NEW.requested_refund_vnd, NEW.order_state_at_open, NEW.remaining_review_ms, NEW.opened_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.opener_user_id, OLD.opener_role, OLD.trigger, OLD.trigger_at, OLD.reason,
        OLD.requested_outcome, OLD.requested_refund_vnd, OLD.order_state_at_open, OLD.remaining_review_ms, OLD.opened_at)
      OR NEW.version <> OLD.version + 1 OR OLD.state <> 'open' OR NEW.respond_by < OLD.respond_by
      OR (NEW.state <> 'open' AND NEW.respond_by <> OLD.respond_by) THEN
      RAISE EXCEPTION 'Commission dispute identity or transition is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_disputes_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_disputes
FOR EACH ROW EXECUTE FUNCTION commission_guard_dispute();
--> statement-breakpoint
CREATE FUNCTION commission_guard_dispute_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_disputes%ROWTYPE; order_row commission_orders%ROWTYPE; total integer;
BEGIN
  -- Serialize party counts through the parent row, including concurrent inserts.
  SELECT * INTO subject FROM commission_disputes WHERE id = NEW.dispute_id FOR UPDATE;
  IF NOT FOUND OR subject.state <> 'open' OR NEW.created_at < subject.opened_at THEN
    RAISE EXCEPTION 'Invalid commission statement binding' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO order_row FROM commission_orders WHERE id = subject.order_id;
  IF (NEW.author_role = 'buyer' AND NEW.author_user_id <> order_row.buyer_user_id)
    OR (NEW.author_role = 'creator' AND NEW.author_user_id <> order_row.creator_user_id) THEN
    RAISE EXCEPTION 'Invalid commission statement author' USING ERRCODE = '23514';
  END IF;
  IF NEW.author_role IN ('buyer','creator') THEN
    SELECT count(*) INTO total FROM commission_dispute_statements WHERE dispute_id = NEW.dispute_id AND author_role = NEW.author_role;
    IF total >= 10 THEN RAISE EXCEPTION 'Commission statement limit reached' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_dispute_statements_guard BEFORE INSERT ON commission_dispute_statements
FOR EACH ROW EXECUTE FUNCTION commission_guard_dispute_statement();
--> statement-breakpoint
CREATE FUNCTION commission_guard_ruling() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_disputes%ROWTYPE; order_row commission_orders%ROWTYPE;
BEGIN
  SELECT * INTO subject FROM commission_disputes WHERE id = NEW.dispute_id;
  IF NOT FOUND OR NEW.ruled_at < subject.opened_at THEN
    RAISE EXCEPTION 'Invalid commission ruling binding' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO order_row FROM commission_orders WHERE id = subject.order_id;
  IF NEW.refund_amount_vnd > order_row.amount_vnd
    OR (NEW.outcome = 'complete' AND (subject.order_state_at_open <> 'delivered' OR NEW.refund_amount_vnd >= order_row.amount_vnd)) THEN
    RAISE EXCEPTION 'Invalid commission ruling outcome' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_rulings_guard BEFORE INSERT ON commission_rulings
FOR EACH ROW EXECUTE FUNCTION commission_guard_ruling();
--> statement-breakpoint
CREATE FUNCTION commission_guard_ruling_correction() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_rulings%ROWTYPE; paid_amount bigint;
BEGIN
  SELECT * INTO subject FROM commission_rulings WHERE id = NEW.ruling_id FOR UPDATE;
  IF NOT FOUND OR NEW.corrected_at < subject.ruled_at OR NEW.corrected_at > subject.ruled_at + interval '30 days' THEN
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
CREATE TRIGGER commission_ruling_corrections_guard BEFORE INSERT ON commission_ruling_corrections
FOR EACH ROW EXECUTE FUNCTION commission_guard_ruling_correction();
--> statement-breakpoint
CREATE FUNCTION commission_guard_late_payment_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission claims cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO subject FROM commission_orders WHERE id = NEW.order_id;
    IF NOT FOUND OR NEW.version <> 1 OR NEW.state <> 'awaiting_creator' OR subject.state <> 'closed' OR subject.confirmed_at IS NOT NULL
      OR subject.accepted_at IS NULL OR subject.close_reason NOT IN ('payment_expired','buyer_cancelled','creator_cancelled','security_invalidated','eligibility_invalidated')
      OR NEW.buyer_user_id <> subject.buyer_user_id OR NEW.filed_at < subject.closed_at OR NEW.filed_at > subject.closed_at + interval '30 days' THEN
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
--> statement-breakpoint
CREATE TRIGGER commission_late_payment_claims_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_late_payment_claims
FOR EACH ROW EXECUTE FUNCTION commission_guard_late_payment_claim();
--> statement-breakpoint
CREATE FUNCTION commission_guard_resolution_pause() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission resolution pauses cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.version <> 1 THEN RAISE EXCEPTION 'Commission resolution pause starts open' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.started_at <> OLD.started_at OR OLD.ended_at IS NOT NULL
      OR NEW.ended_at IS NULL OR NEW.ended_at < OLD.started_at OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Commission resolution pause may only end once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_resolution_pauses_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_resolution_pauses
FOR EACH ROW EXECUTE FUNCTION commission_guard_resolution_pause();
