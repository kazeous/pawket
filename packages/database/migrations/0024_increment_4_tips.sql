CREATE TABLE "creator_tip_setting_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"minimum_vnd" bigint NOT NULL,
	"maximum_vnd" bigint NOT NULL,
	"presets_vnd" integer[] NOT NULL,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_tip_revisions_number_check" CHECK ("creator_tip_setting_revisions"."revision_number" > 0),
	CONSTRAINT "creator_tip_revisions_bounds_check" CHECK ("creator_tip_setting_revisions"."minimum_vnd" >= 10000 and "creator_tip_setting_revisions"."maximum_vnd" <= 5000000 and "creator_tip_setting_revisions"."maximum_vnd" >= "creator_tip_setting_revisions"."minimum_vnd"),
	CONSTRAINT "creator_tip_revisions_presets_check" CHECK (coalesce(array_ndims("creator_tip_setting_revisions"."presets_vnd") = 1 and array_lower("creator_tip_setting_revisions"."presets_vnd", 1) = 1 and cardinality("creator_tip_setting_revisions"."presets_vnd") = 3
    and array_position("creator_tip_setting_revisions"."presets_vnd", null) is null
    and "creator_tip_setting_revisions"."presets_vnd"[1] between "creator_tip_setting_revisions"."minimum_vnd" and "creator_tip_setting_revisions"."maximum_vnd"
    and "creator_tip_setting_revisions"."presets_vnd"[2] between "creator_tip_setting_revisions"."minimum_vnd" and "creator_tip_setting_revisions"."maximum_vnd"
    and "creator_tip_setting_revisions"."presets_vnd"[3] between "creator_tip_setting_revisions"."minimum_vnd" and "creator_tip_setting_revisions"."maximum_vnd"
    and "creator_tip_setting_revisions"."presets_vnd"[1] <> "creator_tip_setting_revisions"."presets_vnd"[2] and "creator_tip_setting_revisions"."presets_vnd"[1] <> "creator_tip_setting_revisions"."presets_vnd"[3] and "creator_tip_setting_revisions"."presets_vnd"[2] <> "creator_tip_setting_revisions"."presets_vnd"[3], false))
);
--> statement-breakpoint
CREATE TABLE "creator_tip_settings" (
	"creator_user_id" text PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_tip_settings_time_check" CHECK ("creator_tip_settings"."updated_at" >= "creator_tip_settings"."created_at")
);
--> statement-breakpoint
CREATE TABLE "payment_confirmations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"account_version_id" uuid NOT NULL,
	"observed_amount_vnd" bigint NOT NULL,
	"reference_hash" text NOT NULL,
	"bank_transaction_fingerprint" text NOT NULL,
	"source" text DEFAULT 'creator_manual' NOT NULL,
	"attested_received" boolean NOT NULL,
	"actor_session_id" text NOT NULL,
	"primary_authenticated_at" timestamp with time zone NOT NULL,
	"totp_verified_at" timestamp with time zone,
	"idempotency_key_hash" text NOT NULL,
	"request_id" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_confirmations_source_check" CHECK ("payment_confirmations"."source" = 'creator_manual' and "payment_confirmations"."attested_received" = true),
	CONSTRAINT "payment_confirmations_bank_txn_check" CHECK ("payment_confirmations"."bank_transaction_fingerprint" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_confirmations_idempotency_check" CHECK ("payment_confirmations"."idempotency_key_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_confirmations_assurance_time_check" CHECK ("payment_confirmations"."primary_authenticated_at" <= "payment_confirmations"."confirmed_at"
    and "payment_confirmations"."primary_authenticated_at" >= "payment_confirmations"."confirmed_at" - interval '15 minutes'
    and ("payment_confirmations"."totp_verified_at" is null or ("payment_confirmations"."totp_verified_at" <= "payment_confirmations"."confirmed_at" and "payment_confirmations"."totp_verified_at" >= "payment_confirmations"."confirmed_at" - interval '5 minutes')))
);
--> statement-breakpoint
CREATE TABLE "payment_guest_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"capability_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_guest_capabilities_hash_check" CHECK ("payment_guest_capabilities"."capability_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_guest_capabilities_time_check" CHECK ("payment_guest_capabilities"."expires_at" > "payment_guest_capabilities"."created_at")
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text DEFAULT 'tip' NOT NULL,
	"tip_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"currency" text DEFAULT 'VND' NOT NULL,
	"reference_hash" text NOT NULL,
	"reference_envelope" jsonb NOT NULL,
	"destination_envelope" jsonb NOT NULL,
	"account_version_id" uuid NOT NULL,
	"abuse_key_hash" text NOT NULL,
	"state" text DEFAULT 'awaiting_transfer' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"rejection_reason" text,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" = 'tip' and "payment_intents"."currency" = 'VND'),
	CONSTRAINT "payment_intents_amount_check" CHECK ("payment_intents"."amount_vnd" between 1 and 9999999999999),
	CONSTRAINT "payment_intents_reference_hash_check" CHECK ("payment_intents"."reference_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_intents_abuse_hash_check" CHECK ("payment_intents"."abuse_key_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_intents_reference_envelope_check" CHECK (coalesce(
  jsonb_typeof("payment_intents"."reference_envelope") = 'object' and octet_length("payment_intents"."reference_envelope"::text) <= 24000
  and "payment_intents"."reference_envelope"->'version' = '1'::jsonb and "payment_intents"."reference_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("payment_intents"."reference_envelope"->'keyId') = 'string' and "payment_intents"."reference_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("payment_intents"."reference_envelope"->'nonce') = 'string' and "payment_intents"."reference_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("payment_intents"."reference_envelope"->'ciphertext') = 'string' and "payment_intents"."reference_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("payment_intents"."reference_envelope"->'authenticationTag') = 'string' and "payment_intents"."reference_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payment_intents"."reference_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb,
  false)),
	CONSTRAINT "payment_intents_destination_envelope_check" CHECK (coalesce(
  jsonb_typeof("payment_intents"."destination_envelope") = 'object' and octet_length("payment_intents"."destination_envelope"::text) <= 24000
  and "payment_intents"."destination_envelope"->'version' = '1'::jsonb and "payment_intents"."destination_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("payment_intents"."destination_envelope"->'keyId') = 'string' and "payment_intents"."destination_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("payment_intents"."destination_envelope"->'nonce') = 'string' and "payment_intents"."destination_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("payment_intents"."destination_envelope"->'ciphertext') = 'string' and "payment_intents"."destination_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("payment_intents"."destination_envelope"->'authenticationTag') = 'string' and "payment_intents"."destination_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payment_intents"."destination_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb,
  false)),
	CONSTRAINT "payment_intents_state_check" CHECK ("payment_intents"."state" in ('awaiting_transfer','confirmed','expired','rejected')),
	CONSTRAINT "payment_intents_time_check" CHECK ("payment_intents"."expires_at" > "payment_intents"."created_at" and "payment_intents"."updated_at" >= "payment_intents"."created_at" and (
    ("payment_intents"."state" = 'awaiting_transfer' and "payment_intents"."closed_at" is null) or
    ("payment_intents"."state" <> 'awaiting_transfer' and "payment_intents"."closed_at" is not null and "payment_intents"."closed_at" >= "payment_intents"."created_at" and "payment_intents"."updated_at" = "payment_intents"."closed_at"))
    and ("payment_intents"."state" <> 'confirmed' or "payment_intents"."closed_at" < "payment_intents"."expires_at")
    and ("payment_intents"."state" <> 'expired' or "payment_intents"."closed_at" >= "payment_intents"."expires_at")),
	CONSTRAINT "payment_intents_rejection_check" CHECK (("payment_intents"."state" = 'rejected' and "payment_intents"."rejection_reason" is not null and "payment_intents"."rejection_reason" in ('policy_invalidated','security_invalidated'))
    or ("payment_intents"."state" <> 'rejected' and "payment_intents"."rejection_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "payment_transfer_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"access_kind" text NOT NULL,
	"buyer_user_id" text,
	"guest_capability_id" uuid,
	"authoritative" boolean DEFAULT false NOT NULL,
	"request_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_transfer_claims_untrusted_check" CHECK ("payment_transfer_claims"."authoritative" = false),
	CONSTRAINT "payment_transfer_claims_access_check" CHECK (("payment_transfer_claims"."access_kind" = 'guest' and "payment_transfer_claims"."guest_capability_id" is not null and "payment_transfer_claims"."buyer_user_id" is null)
    or ("payment_transfer_claims"."access_kind" = 'buyer' and "payment_transfer_claims"."guest_capability_id" is null and "payment_transfer_claims"."buyer_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "tips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"buyer_user_id" text,
	"setting_revision_id" uuid NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"guest_content_envelope" jsonb NOT NULL,
	"state" text DEFAULT 'awaiting_payment' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tips_amount_check" CHECK ("tips"."amount_vnd" between 1 and 9007199254740991),
	CONSTRAINT "tips_content_envelope_check" CHECK (coalesce(
  jsonb_typeof("tips"."guest_content_envelope") = 'object' and octet_length("tips"."guest_content_envelope"::text) <= 24000
  and "tips"."guest_content_envelope"->'version' = '1'::jsonb and "tips"."guest_content_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("tips"."guest_content_envelope"->'keyId') = 'string' and "tips"."guest_content_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof("tips"."guest_content_envelope"->'nonce') = 'string' and "tips"."guest_content_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof("tips"."guest_content_envelope"->'ciphertext') = 'string' and "tips"."guest_content_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof("tips"."guest_content_envelope"->'authenticationTag') = 'string' and "tips"."guest_content_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "tips"."guest_content_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb,
  false)),
	CONSTRAINT "tips_state_check" CHECK ("tips"."state" in ('awaiting_payment','completed','expired','rejected')),
	CONSTRAINT "tips_time_check" CHECK ("tips"."updated_at" >= "tips"."created_at" and (
    ("tips"."state" = 'awaiting_payment' and "tips"."closed_at" is null) or
    ("tips"."state" <> 'awaiting_payment' and "tips"."closed_at" is not null and "tips"."closed_at" >= "tips"."created_at" and "tips"."updated_at" = "tips"."closed_at")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "creator_tip_revisions_number_uidx" ON "creator_tip_setting_revisions" USING btree ("creator_user_id","revision_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "creator_tip_revisions_binding_uidx" ON "creator_tip_setting_revisions" USING btree ("id","creator_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_confirmations_intent_uidx" ON "payment_confirmations" USING btree ("payment_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_confirmations_bank_txn_uidx" ON "payment_confirmations" USING btree ("bank_transaction_fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_guest_capabilities_intent_uidx" ON "payment_guest_capabilities" USING btree ("payment_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_guest_capabilities_hash_uidx" ON "payment_guest_capabilities" USING btree ("capability_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_guest_capabilities_binding_uidx" ON "payment_guest_capabilities" USING btree ("id","payment_intent_id");
--> statement-breakpoint
CREATE INDEX "payment_guest_capabilities_expiry_idx" ON "payment_guest_capabilities" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_tip_uidx" ON "payment_intents" USING btree ("tip_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_reference_uidx" ON "payment_intents" USING btree ("reference_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_confirmation_binding_uidx" ON "payment_intents" USING btree ("id","creator_user_id","amount_vnd","reference_hash","account_version_id");
--> statement-breakpoint
CREATE INDEX "payment_intents_creator_queue_idx" ON "payment_intents" USING btree ("creator_user_id","state","created_at","id");
--> statement-breakpoint
CREATE INDEX "payment_intents_expiry_idx" ON "payment_intents" USING btree ("expires_at","id") WHERE "payment_intents"."state" = 'awaiting_transfer';
--> statement-breakpoint
CREATE INDEX "payment_intents_open_abuse_idx" ON "payment_intents" USING btree ("abuse_key_hash","created_at") WHERE "payment_intents"."state" = 'awaiting_transfer';
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transfer_claims_intent_uidx" ON "payment_transfer_claims" USING btree ("payment_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tips_payment_binding_uidx" ON "tips" USING btree ("id","creator_user_id","amount_vnd");
--> statement-breakpoint
CREATE INDEX "tips_buyer_created_idx" ON "tips" USING btree ("buyer_user_id","created_at") WHERE "tips"."buyer_user_id" is not null;
--> statement-breakpoint
ALTER TABLE "creator_tip_setting_revisions" ADD CONSTRAINT "creator_tip_setting_revisions_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "creator_tip_settings" ADD CONSTRAINT "creator_tip_settings_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "creator_tip_settings" ADD CONSTRAINT "creator_tip_settings_revision_owner_fk" FOREIGN KEY ("revision_id","creator_user_id") REFERENCES "creator_tip_setting_revisions"("id","creator_user_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_intent_binding_fk" FOREIGN KEY ("payment_intent_id","creator_user_id","observed_amount_vnd","reference_hash","account_version_id") REFERENCES "payment_intents"("id","creator_user_id","amount_vnd","reference_hash","account_version_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_guest_capabilities" ADD CONSTRAINT "payment_guest_capabilities_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_account_version_id_payments_receiving_account_onboarding_id_fk" FOREIGN KEY ("account_version_id") REFERENCES "payments_receiving_account_onboarding"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tip_binding_fk" FOREIGN KEY ("tip_id","creator_user_id","amount_vnd") REFERENCES "tips"("id","creator_user_id","amount_vnd") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_transfer_claims" ADD CONSTRAINT "payment_transfer_claims_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_transfer_claims" ADD CONSTRAINT "payment_transfer_claims_buyer_user_id_identity_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_transfer_claims" ADD CONSTRAINT "payment_transfer_claims_guest_intent_fk" FOREIGN KEY ("guest_capability_id","payment_intent_id") REFERENCES "payment_guest_capabilities"("id","payment_intent_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_buyer_user_id_identity_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_setting_owner_fk" FOREIGN KEY ("setting_revision_id","creator_user_id") REFERENCES "creator_tip_setting_revisions"("id","creator_user_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
-- Custom guards accompany the generated additive schema. Keep search paths
-- bound to the schema selected by the migrator, including isolated upgrades.
CREATE FUNCTION increment_four_reject_fact_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'tip payment evidence is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_tip_revisions_append_only BEFORE UPDATE OR DELETE ON creator_tip_setting_revisions
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_capabilities_append_only BEFORE UPDATE OR DELETE ON payment_guest_capabilities
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_claims_append_only BEFORE UPDATE OR DELETE ON payment_transfer_claims
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_confirmations_append_only BEFORE UPDATE OR DELETE ON payment_confirmations
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE FUNCTION creator_tip_guard_settings_pointer() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE old_revision integer; new_revision integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tip settings cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'tip settings identity is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT revision_number INTO old_revision FROM creator_tip_setting_revisions WHERE id = OLD.revision_id;
  SELECT revision_number INTO new_revision FROM creator_tip_setting_revisions WHERE id = NEW.revision_id;
  IF new_revision IS NULL OR new_revision <= old_revision THEN
    RAISE EXCEPTION 'tip settings revision must advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_tip_settings_pointer_guard BEFORE UPDATE OR DELETE ON creator_tip_settings
FOR EACH ROW EXECUTE FUNCTION creator_tip_guard_settings_pointer();
--> statement-breakpoint
CREATE FUNCTION increment_four_guard_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE initial_state text; mutable_fields text[];
BEGIN
  initial_state := CASE WHEN TG_TABLE_NAME = 'tips' THEN 'awaiting_payment' ELSE 'awaiting_transfer' END;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tip payment lifecycle records cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> initial_state OR NEW.closed_at IS NOT NULL OR NEW.updated_at <> NEW.created_at THEN
      RAISE EXCEPTION 'tip payment lifecycle must start pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  mutable_fields := CASE WHEN TG_TABLE_NAME = 'tips' THEN ARRAY['state','closed_at','updated_at']
    ELSE ARRAY['state','closed_at','updated_at','rejection_reason'] END;
  IF to_jsonb(NEW) - mutable_fields IS DISTINCT FROM to_jsonb(OLD) - mutable_fields THEN
    RAISE EXCEPTION 'tip payment bindings are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> initial_state OR NEW.state = initial_state THEN
    RAISE EXCEPTION 'tip payment lifecycle permits one terminal transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tips_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tips
FOR EACH ROW EXECUTE FUNCTION increment_four_guard_lifecycle();
--> statement-breakpoint
CREATE TRIGGER payment_intents_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_intents
FOR EACH ROW EXECUTE FUNCTION increment_four_guard_lifecycle();
--> statement-breakpoint
CREATE FUNCTION payment_guard_initial_destination() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payments_receiving_account_onboarding account
    WHERE account.id = NEW.account_version_id AND account.applicant_user_id = NEW.creator_user_id
      AND account.proof_state = 'verified' AND account.proof_verified_at <= NEW.created_at
      AND account.retired_at IS NULL AND account.minimized_at IS NULL
  ) THEN
    RAISE EXCEPTION 'payment destination must be the verified current creator account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_intents_initial_destination_guard BEFORE INSERT ON payment_intents
FOR EACH ROW EXECUTE FUNCTION payment_guard_initial_destination();
--> statement-breakpoint
CREATE FUNCTION payment_guard_claim_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE intent payment_intents%ROWTYPE; buyer_id text;
BEGIN
  SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id FOR UPDATE;
  IF NOT FOUND OR intent.state <> 'awaiting_transfer' OR NEW.claimed_at < intent.created_at OR NEW.claimed_at >= intent.expires_at THEN
    RAISE EXCEPTION 'transfer claims require a pending unexpired intent' USING ERRCODE = '23514';
  END IF;
  SELECT buyer_user_id INTO buyer_id FROM tips WHERE id = intent.tip_id;
  IF (NEW.access_kind = 'buyer' AND NEW.buyer_user_id IS DISTINCT FROM buyer_id)
    OR (NEW.access_kind = 'guest' AND (buyer_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM payment_guest_capabilities capability
      WHERE capability.id = NEW.guest_capability_id AND capability.payment_intent_id = intent.id
        AND capability.created_at <= NEW.claimed_at AND capability.expires_at > NEW.claimed_at
    ))) THEN
    RAISE EXCEPTION 'transfer claim access binding is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_claims_insert_guard BEFORE INSERT ON payment_transfer_claims
FOR EACH ROW EXECUTE FUNCTION payment_guard_claim_insert();
--> statement-breakpoint
CREATE FUNCTION payment_guard_confirmation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE intent payment_intents%ROWTYPE;
BEGIN
  SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id FOR UPDATE;
  -- Allow either application update order in one transaction. Final consistency
  -- is checked at commit; expired/rejected or previously confirmed rows fail.
  IF NOT FOUND OR intent.state NOT IN ('awaiting_transfer','confirmed')
    OR NEW.confirmed_at < intent.created_at OR NEW.confirmed_at >= intent.expires_at THEN
    RAISE EXCEPTION 'confirmation requires an unexpired intent' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payments_receiving_account_onboarding account
    WHERE account.id = intent.account_version_id AND account.applicant_user_id = NEW.creator_user_id
      AND account.retired_at IS NULL AND account.minimized_at IS NULL AND account.proof_state = 'verified'
      AND account.proof_verified_at <= NEW.confirmed_at
  ) THEN
    RAISE EXCEPTION 'confirmation account lineage is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_confirmations_insert_guard BEFORE INSERT ON payment_confirmations
FOR EACH ROW EXECUTE FUNCTION payment_guard_confirmation_insert();
--> statement-breakpoint
CREATE FUNCTION increment_four_check_payment_consistency() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE tip_row tips%ROWTYPE; intent payment_intents%ROWTYPE; confirmation payment_confirmations%ROWTYPE;
  capability payment_guest_capabilities%ROWTYPE; target_tip_id uuid; expected_tip_state text;
BEGIN
  IF TG_TABLE_NAME = 'tips' THEN target_tip_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'payment_intents' THEN target_tip_id := NEW.tip_id;
  ELSE SELECT tip_id INTO target_tip_id FROM payment_intents WHERE id = NEW.payment_intent_id;
  END IF;
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
CREATE CONSTRAINT TRIGGER tips_payment_consistency AFTER INSERT OR UPDATE ON tips
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION increment_four_check_payment_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_intents_tip_consistency AFTER INSERT OR UPDATE ON payment_intents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION increment_four_check_payment_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_capabilities_tip_consistency AFTER INSERT ON payment_guest_capabilities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION increment_four_check_payment_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_confirmations_tip_consistency AFTER INSERT ON payment_confirmations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION increment_four_check_payment_consistency();
