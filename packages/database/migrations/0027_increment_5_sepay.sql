CREATE TABLE "payments_sepay_account_cutovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_fingerprint" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_environment" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"primary_authenticated_at" timestamp with time zone NOT NULL,
	"totp_verified_at" timestamp with time zone,
	"cutover_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_cutover_fingerprint_check" CHECK ("payments_sepay_account_cutovers"."account_fingerprint" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "sepay_cutover_environment_check" CHECK ("payments_sepay_account_cutovers"."provider_environment" in ('test','live')),
	CONSTRAINT "sepay_cutover_provider_check" CHECK (char_length("payments_sepay_account_cutovers"."provider_tenant_id") between 1 and 200 and "payments_sepay_account_cutovers"."provider_tenant_id" !~ '[[:cntrl:]]' and "payments_sepay_account_cutovers"."provider_account_id" ~ '^[1-9][0-9]{0,39}$'),
	CONSTRAINT "sepay_cutover_actor_check" CHECK (char_length("payments_sepay_account_cutovers"."actor_session_id") between 1 and 200 and "payments_sepay_account_cutovers"."actor_session_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "sepay_cutover_assurance_check" CHECK ("payments_sepay_account_cutovers"."primary_authenticated_at" between "payments_sepay_account_cutovers"."cutover_at" - interval '15 minutes' and "payments_sepay_account_cutovers"."cutover_at"
    and ("payments_sepay_account_cutovers"."totp_verified_at" is null or "payments_sepay_account_cutovers"."totp_verified_at" between "payments_sepay_account_cutovers"."cutover_at" - interval '5 minutes' and "payments_sepay_account_cutovers"."cutover_at"))
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_connection_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"token_generation" integer DEFAULT 1 NOT NULL,
	"access_token_envelope" jsonb,
	"refresh_token_envelope" jsonb,
	"webhook_secret_envelope" jsonb NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"provider_tenant_id" text,
	"provider_account_id" text,
	"provider_binding_envelope" jsonb,
	"capability_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_revision_generation_check" CHECK ("payments_sepay_connection_revisions"."revision_number" > 0 and "payments_sepay_connection_revisions"."token_generation" > 0),
	CONSTRAINT "sepay_revision_webhook_envelope_check" CHECK (coalesce(jsonb_typeof("payments_sepay_connection_revisions"."webhook_secret_envelope") = 'object' and octet_length("payments_sepay_connection_revisions"."webhook_secret_envelope"::text) <= 24000
  and "payments_sepay_connection_revisions"."webhook_secret_envelope"->'version' = '1'::jsonb and "payments_sepay_connection_revisions"."webhook_secret_envelope"->>'algorithm' = 'A256GCM'
  and "payments_sepay_connection_revisions"."webhook_secret_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "payments_sepay_connection_revisions"."webhook_secret_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and "payments_sepay_connection_revisions"."webhook_secret_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "payments_sepay_connection_revisions"."webhook_secret_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payments_sepay_connection_revisions"."webhook_secret_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "sepay_revision_grant_check" CHECK (("payments_sepay_connection_revisions"."access_token_envelope" is null and "payments_sepay_connection_revisions"."refresh_token_envelope" is null and "payments_sepay_connection_revisions"."access_token_expires_at" is null)
    or ("payments_sepay_connection_revisions"."access_token_envelope" is not null and "payments_sepay_connection_revisions"."refresh_token_envelope" is not null and "payments_sepay_connection_revisions"."access_token_expires_at" > "payments_sepay_connection_revisions"."created_at" and coalesce(jsonb_typeof("payments_sepay_connection_revisions"."access_token_envelope") = 'object' and octet_length("payments_sepay_connection_revisions"."access_token_envelope"::text) <= 24000
  and "payments_sepay_connection_revisions"."access_token_envelope"->'version' = '1'::jsonb and "payments_sepay_connection_revisions"."access_token_envelope"->>'algorithm' = 'A256GCM'
  and "payments_sepay_connection_revisions"."access_token_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "payments_sepay_connection_revisions"."access_token_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and "payments_sepay_connection_revisions"."access_token_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "payments_sepay_connection_revisions"."access_token_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payments_sepay_connection_revisions"."access_token_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false) and coalesce(jsonb_typeof("payments_sepay_connection_revisions"."refresh_token_envelope") = 'object' and octet_length("payments_sepay_connection_revisions"."refresh_token_envelope"::text) <= 24000
  and "payments_sepay_connection_revisions"."refresh_token_envelope"->'version' = '1'::jsonb and "payments_sepay_connection_revisions"."refresh_token_envelope"->>'algorithm' = 'A256GCM'
  and "payments_sepay_connection_revisions"."refresh_token_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "payments_sepay_connection_revisions"."refresh_token_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and "payments_sepay_connection_revisions"."refresh_token_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "payments_sepay_connection_revisions"."refresh_token_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payments_sepay_connection_revisions"."refresh_token_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))),
	CONSTRAINT "sepay_revision_scopes_check" CHECK ("payments_sepay_connection_revisions"."scopes" <@ ARRAY['transaction:read','bank-account:read']::text[] and cardinality("payments_sepay_connection_revisions"."scopes") <= 2 and array_position("payments_sepay_connection_revisions"."scopes", null) is null),
	CONSTRAINT "sepay_revision_binding_check" CHECK (("payments_sepay_connection_revisions"."provider_tenant_id" is null and "payments_sepay_connection_revisions"."provider_account_id" is null) or ("payments_sepay_connection_revisions"."provider_tenant_id" is not null and char_length("payments_sepay_connection_revisions"."provider_tenant_id") between 1 and 200 and "payments_sepay_connection_revisions"."provider_tenant_id" !~ '[[:cntrl:]]' and "payments_sepay_connection_revisions"."provider_account_id" ~ '^[1-9][0-9]{0,39}$')),
	CONSTRAINT "sepay_revision_capabilities_check" CHECK (jsonb_typeof("payments_sepay_connection_revisions"."capability_evidence") = 'object' and octet_length("payments_sepay_connection_revisions"."capability_evidence"::text) <= 4096
    and not jsonb_path_exists("payments_sepay_connection_revisions"."capability_evidence", '$.* ? (@.type() != "boolean")')),
	CONSTRAINT "sepay_revision_provider_envelope_check" CHECK ("payments_sepay_connection_revisions"."provider_binding_envelope" is null or coalesce(jsonb_typeof("payments_sepay_connection_revisions"."provider_binding_envelope") = 'object' and octet_length("payments_sepay_connection_revisions"."provider_binding_envelope"::text) <= 24000
  and "payments_sepay_connection_revisions"."provider_binding_envelope"->'version' = '1'::jsonb and "payments_sepay_connection_revisions"."provider_binding_envelope"->>'algorithm' = 'A256GCM'
  and "payments_sepay_connection_revisions"."provider_binding_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "payments_sepay_connection_revisions"."provider_binding_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and "payments_sepay_connection_revisions"."provider_binding_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "payments_sepay_connection_revisions"."provider_binding_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payments_sepay_connection_revisions"."provider_binding_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"account_version_id" uuid NOT NULL,
	"account_fingerprint" text NOT NULL,
	"provider_environment" text NOT NULL,
	"provider_tenant_id" text,
	"provider_account_id" text,
	"status" text DEFAULT 'setup_pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"current_revision_id" uuid,
	"automation_enabled" boolean DEFAULT false NOT NULL,
	"refresh_lease_owner" text,
	"refresh_lease_expires_at" timestamp with time zone,
	"remote_revocation_status" text DEFAULT 'not_requested' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_connection_environment_check" CHECK ("payments_sepay_connections"."provider_environment" in ('test','live')),
	CONSTRAINT "sepay_connection_status_check" CHECK ("payments_sepay_connections"."status" in ('setup_pending','ready','paused','reconnect_required','disconnected')),
	CONSTRAINT "sepay_connection_version_check" CHECK ("payments_sepay_connections"."version" > 0 and "payments_sepay_connections"."updated_at" >= "payments_sepay_connections"."created_at"),
	CONSTRAINT "sepay_connection_fingerprint_check" CHECK ("payments_sepay_connections"."account_fingerprint" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "sepay_connection_binding_check" CHECK (("payments_sepay_connections"."provider_tenant_id" is null and "payments_sepay_connections"."provider_account_id" is null) or ("payments_sepay_connections"."provider_tenant_id" is not null and char_length("payments_sepay_connections"."provider_tenant_id") between 1 and 200 and "payments_sepay_connections"."provider_tenant_id" !~ '[[:cntrl:]]' and "payments_sepay_connections"."provider_account_id" ~ '^[1-9][0-9]{0,39}$')),
	CONSTRAINT "sepay_connection_ready_check" CHECK ("payments_sepay_connections"."status" <> 'ready' or ("payments_sepay_connections"."current_revision_id" is not null and "payments_sepay_connections"."provider_tenant_id" is not null and "payments_sepay_connections"."provider_account_id" is not null)),
	CONSTRAINT "sepay_connection_refresh_lease_check" CHECK (("payments_sepay_connections"."refresh_lease_owner" is null and "payments_sepay_connections"."refresh_lease_expires_at" is null) or ("payments_sepay_connections"."refresh_lease_owner" is not null and char_length("payments_sepay_connections"."refresh_lease_owner") between 1 and 200 and "payments_sepay_connections"."refresh_lease_owner" !~ '[[:cntrl:]]' and "payments_sepay_connections"."refresh_lease_expires_at" is not null)),
	CONSTRAINT "sepay_connection_revoke_check" CHECK ("payments_sepay_connections"."remote_revocation_status" in ('not_requested','unknown','revoked'))
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inbox_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"idempotency_key_hash" text,
	"expected_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_decision_action_check" CHECK ("payments_sepay_decisions"."action" in ('confirmed','review_required','ignored','retry','dismiss','reopen','conflict')),
	CONSTRAINT "sepay_decision_reason_check" CHECK (char_length("payments_sepay_decisions"."reason") between 1 and 500 and "payments_sepay_decisions"."reason" !~ '[[:cntrl:]]'),
	CONSTRAINT "sepay_decision_version_check" CHECK ("payments_sepay_decisions"."expected_version" > 0),
	CONSTRAINT "sepay_decision_actor_check" CHECK (("payments_sepay_decisions"."actor_user_id" is null and "payments_sepay_decisions"."actor_session_id" is null and "payments_sepay_decisions"."idempotency_key_hash" is null)
    or ("payments_sepay_decisions"."actor_user_id" is not null and "payments_sepay_decisions"."actor_session_id" is not null and char_length("payments_sepay_decisions"."actor_session_id") between 1 and 200 and "payments_sepay_decisions"."actor_session_id" !~ '[[:cntrl:]]' and "payments_sepay_decisions"."idempotency_key_hash" is not null and "payments_sepay_decisions"."idempotency_key_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'))
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"raw_envelope" jsonb,
	"disposition" text NOT NULL,
	"normalized_facts" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_inbox_event_id_check" CHECK ("payments_sepay_inbox"."provider_event_id" ~ '^(0|[1-9][0-9]{0,39})$'),
	CONSTRAINT "sepay_inbox_digest_check" CHECK ("payments_sepay_inbox"."payload_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "sepay_inbox_disposition_check" CHECK (("payments_sepay_inbox"."disposition" = 'accepted' and "payments_sepay_inbox"."raw_envelope" is not null and coalesce(jsonb_typeof("payments_sepay_inbox"."raw_envelope") = 'object' and octet_length("payments_sepay_inbox"."raw_envelope"::text) <= 24000
  and "payments_sepay_inbox"."raw_envelope"->'version' = '1'::jsonb and "payments_sepay_inbox"."raw_envelope"->>'algorithm' = 'A256GCM'
  and "payments_sepay_inbox"."raw_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "payments_sepay_inbox"."raw_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and "payments_sepay_inbox"."raw_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "payments_sepay_inbox"."raw_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payments_sepay_inbox"."raw_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)) or ("payments_sepay_inbox"."disposition" = 'ignored' and "payments_sepay_inbox"."raw_envelope" is null)),
	CONSTRAINT "sepay_inbox_facts_check" CHECK (jsonb_typeof("payments_sepay_inbox"."normalized_facts") = 'object' and octet_length("payments_sepay_inbox"."normalized_facts"::text) <= 4096),
	CONSTRAINT "sepay_inbox_ignored_minimal_check" CHECK ("payments_sepay_inbox"."disposition" <> 'ignored' or ("payments_sepay_inbox"."normalized_facts"->>'reason' in ('outgoing','non_pawket','mock')
    and "payments_sepay_inbox"."normalized_facts" - 'reason' = '{}'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_inbox_conflicts" (
	"inbox_id" uuid PRIMARY KEY NOT NULL,
	"payload_digest" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_conflict_digest_check" CHECK ("payments_sepay_inbox_conflicts"."payload_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_oauth_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"provider_environment" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_verifier_envelope" jsonb NOT NULL,
	"expected_connection_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_oauth_state_check" CHECK ("payments_sepay_oauth_attempts"."state_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "sepay_oauth_environment_check" CHECK ("payments_sepay_oauth_attempts"."provider_environment" in ('test','live')),
	CONSTRAINT "sepay_oauth_actor_check" CHECK (char_length("payments_sepay_oauth_attempts"."actor_session_id") between 1 and 200 and "payments_sepay_oauth_attempts"."actor_session_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "sepay_oauth_redirect_check" CHECK (char_length("payments_sepay_oauth_attempts"."redirect_uri") between 1 and 2048 and "payments_sepay_oauth_attempts"."redirect_uri" !~ '[[:cntrl:]]'),
	CONSTRAINT "sepay_oauth_verifier_check" CHECK (coalesce(jsonb_typeof("payments_sepay_oauth_attempts"."code_verifier_envelope") = 'object' and octet_length("payments_sepay_oauth_attempts"."code_verifier_envelope"::text) <= 24000
  and "payments_sepay_oauth_attempts"."code_verifier_envelope"->'version' = '1'::jsonb and "payments_sepay_oauth_attempts"."code_verifier_envelope"->>'algorithm' = 'A256GCM'
  and "payments_sepay_oauth_attempts"."code_verifier_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "payments_sepay_oauth_attempts"."code_verifier_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and "payments_sepay_oauth_attempts"."code_verifier_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "payments_sepay_oauth_attempts"."code_verifier_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "payments_sepay_oauth_attempts"."code_verifier_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "sepay_oauth_version_check" CHECK ("payments_sepay_oauth_attempts"."expected_connection_version" > 0),
	CONSTRAINT "sepay_oauth_time_check" CHECK ("payments_sepay_oauth_attempts"."expires_at" > "payments_sepay_oauth_attempts"."created_at" and "payments_sepay_oauth_attempts"."expires_at" <= "payments_sepay_oauth_attempts"."created_at" + interval '15 minutes' and ("payments_sepay_oauth_attempts"."consumed_at" is null or ("payments_sepay_oauth_attempts"."consumed_at" >= "payments_sepay_oauth_attempts"."created_at" and "payments_sepay_oauth_attempts"."consumed_at" < "payments_sepay_oauth_attempts"."expires_at"))),
	CONSTRAINT "sepay_oauth_status_check" CHECK (("payments_sepay_oauth_attempts"."status" = 'pending' and "payments_sepay_oauth_attempts"."consumed_at" is null) or ("payments_sepay_oauth_attempts"."status" in ('exchanging','completed','failed') and "payments_sepay_oauth_attempts"."consumed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_processing" (
	"inbox_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_processing_status_check" CHECK ("payments_sepay_processing"."status" in ('pending','processing','review_required','confirmed','ignored','dismissed')),
	CONSTRAINT "sepay_processing_attempt_check" CHECK ("payments_sepay_processing"."version" > 0 and "payments_sepay_processing"."attempts" between 0 and 100),
	CONSTRAINT "sepay_processing_lease_check" CHECK (("payments_sepay_processing"."status" = 'processing' and "payments_sepay_processing"."lease_owner" is not null and char_length("payments_sepay_processing"."lease_owner") between 1 and 200 and "payments_sepay_processing"."lease_owner" !~ '[[:cntrl:]]' and "payments_sepay_processing"."lease_expires_at" is not null)
    or ("payments_sepay_processing"."status" <> 'processing' and "payments_sepay_processing"."lease_owner" is null and "payments_sepay_processing"."lease_expires_at" is null)),
	CONSTRAINT "sepay_processing_error_check" CHECK ("payments_sepay_processing"."last_error_code" is null or "payments_sepay_processing"."last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "payments_sepay_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_environment" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision_id" uuid NOT NULL,
	"connection_version" integer NOT NULL,
	"inbox_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"reference_hash" text NOT NULL,
	"account_fingerprint" text NOT NULL,
	"transfer_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"readback_digest" text NOT NULL,
	CONSTRAINT "sepay_transaction_environment_check" CHECK ("payments_sepay_transactions"."provider_environment" in ('test','live')),
	CONSTRAINT "sepay_transaction_provider_check" CHECK (char_length("payments_sepay_transactions"."provider_tenant_id") between 1 and 200 and "payments_sepay_transactions"."provider_tenant_id" !~ '[[:cntrl:]]' and "payments_sepay_transactions"."provider_account_id" ~ '^[1-9][0-9]{0,39}$' and "payments_sepay_transactions"."provider_transaction_id" ~ '^[1-9][0-9]{0,39}$'),
	CONSTRAINT "sepay_transaction_amount_check" CHECK ("payments_sepay_transactions"."amount_vnd" between 1 and 9999999999999 and "payments_sepay_transactions"."connection_version" > 0),
	CONSTRAINT "sepay_transaction_reference_check" CHECK ("payments_sepay_transactions"."reference_hash" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "sepay_transaction_fingerprint_check" CHECK ("payments_sepay_transactions"."account_fingerprint" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "sepay_transaction_digest_check" CHECK ("payments_sepay_transactions"."readback_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "sepay_transaction_time_check" CHECK ("payments_sepay_transactions"."transfer_at" <= "payments_sepay_transactions"."verified_at")
);
--> statement-breakpoint
ALTER TABLE "payment_confirmations" DROP CONSTRAINT "payment_confirmations_source_check";
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ALTER COLUMN "bank_transaction_fingerprint" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ALTER COLUMN "attested_received" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ALTER COLUMN "actor_session_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ALTER COLUMN "primary_authenticated_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ALTER COLUMN "idempotency_key_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ADD COLUMN "provider_transaction_id" uuid;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ADD COLUMN "worker_identity" text;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "settlement_lane" text DEFAULT 'manual_attested' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "cutover_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_cutover_fingerprint_uidx" ON "payments_sepay_account_cutovers" USING btree ("account_fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_revision_number_uidx" ON "payments_sepay_connection_revisions" USING btree ("connection_id","revision_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_revision_connection_uidx" ON "payments_sepay_connection_revisions" USING btree ("id","connection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_connection_creator_account_uidx" ON "payments_sepay_connections" USING btree ("creator_user_id","provider_environment","account_fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_connection_current_creator_uidx" ON "payments_sepay_connections" USING btree ("creator_user_id","provider_environment") WHERE "payments_sepay_connections"."status" <> 'disconnected';
--> statement-breakpoint
CREATE INDEX "sepay_connection_account_idx" ON "payments_sepay_connections" USING btree ("account_fingerprint");
--> statement-breakpoint
CREATE INDEX "sepay_decision_inbox_idx" ON "payments_sepay_decisions" USING btree ("inbox_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_decision_idempotency_uidx" ON "payments_sepay_decisions" USING btree ("actor_user_id","idempotency_key_hash") WHERE "payments_sepay_decisions"."actor_user_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_inbox_event_uidx" ON "payments_sepay_inbox" USING btree ("connection_id","provider_event_id");
--> statement-breakpoint
CREATE INDEX "sepay_inbox_received_idx" ON "payments_sepay_inbox" USING btree ("received_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_oauth_state_uidx" ON "payments_sepay_oauth_attempts" USING btree ("state_hash");
--> statement-breakpoint
CREATE INDEX "sepay_oauth_expiry_idx" ON "payments_sepay_oauth_attempts" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "sepay_processing_available_idx" ON "payments_sepay_processing" USING btree ("status","available_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_transaction_identity_uidx" ON "payments_sepay_transactions" USING btree ("provider_environment","provider_tenant_id","provider_account_id","provider_transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sepay_transaction_intent_uidx" ON "payments_sepay_transactions" USING btree ("payment_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_confirmations_provider_txn_uidx" ON "payment_confirmations" USING btree ("provider_transaction_id");
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_source_check" CHECK (coalesce(
    ("payment_confirmations"."source" = 'creator_manual' and "payment_confirmations"."bank_transaction_fingerprint" is not null and "payment_confirmations"."provider_transaction_id" is null and "payment_confirmations"."worker_identity" is null
      and "payment_confirmations"."attested_received" = true and "payment_confirmations"."actor_session_id" is not null and "payment_confirmations"."primary_authenticated_at" is not null and "payment_confirmations"."idempotency_key_hash" is not null)
    or ("payment_confirmations"."source" = 'sepay_automatic' and "payment_confirmations"."bank_transaction_fingerprint" is null and "payment_confirmations"."provider_transaction_id" is not null
      and "payment_confirmations"."worker_identity" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and "payment_confirmations"."attested_received" is null and "payment_confirmations"."actor_session_id" is null
      and "payment_confirmations"."primary_authenticated_at" is null and "payment_confirmations"."totp_verified_at" is null and "payment_confirmations"."idempotency_key_hash" is null)
    or ("payment_confirmations"."source" = 'creator_reviewed_sepay' and "payment_confirmations"."bank_transaction_fingerprint" is null and "payment_confirmations"."provider_transaction_id" is not null and "payment_confirmations"."worker_identity" is null
      and "payment_confirmations"."attested_received" = true and "payment_confirmations"."actor_session_id" is not null and "payment_confirmations"."primary_authenticated_at" is not null and "payment_confirmations"."idempotency_key_hash" is not null), false));
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_settlement_lane_check" CHECK (("payment_intents"."settlement_lane" = 'manual_attested' and "payment_intents"."cutover_id" is null)
    or ("payment_intents"."settlement_lane" = 'provider_bound' and "payment_intents"."cutover_id" is not null));
--> statement-breakpoint
ALTER TABLE "payments_sepay_account_cutovers" ADD CONSTRAINT "payments_sepay_account_cutovers_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_account_cutovers" ADD CONSTRAINT "payments_sepay_account_cutovers_connection_id_payments_sepay_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "payments_sepay_connections"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_connection_revisions" ADD CONSTRAINT "payments_sepay_connection_revisions_connection_id_payments_sepay_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "payments_sepay_connections"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_connections" ADD CONSTRAINT "payments_sepay_connections_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_connections" ADD CONSTRAINT "payments_sepay_connections_account_version_id_payments_receiving_account_onboarding_id_fk" FOREIGN KEY ("account_version_id") REFERENCES "payments_receiving_account_onboarding"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_connections" ADD CONSTRAINT "payments_sepay_connections_current_revision_id_payments_sepay_connection_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "payments_sepay_connection_revisions"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_decisions" ADD CONSTRAINT "payments_sepay_decisions_inbox_id_payments_sepay_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "payments_sepay_inbox"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_decisions" ADD CONSTRAINT "payments_sepay_decisions_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_inbox" ADD CONSTRAINT "payments_sepay_inbox_connection_id_payments_sepay_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "payments_sepay_connections"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_inbox" ADD CONSTRAINT "sepay_inbox_revision_connection_fk" FOREIGN KEY ("connection_revision_id","connection_id") REFERENCES "payments_sepay_connection_revisions"("id","connection_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_inbox_conflicts" ADD CONSTRAINT "payments_sepay_inbox_conflicts_inbox_id_payments_sepay_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "payments_sepay_inbox"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_oauth_attempts" ADD CONSTRAINT "payments_sepay_oauth_attempts_connection_id_payments_sepay_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "payments_sepay_connections"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_oauth_attempts" ADD CONSTRAINT "payments_sepay_oauth_attempts_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_processing" ADD CONSTRAINT "payments_sepay_processing_inbox_id_payments_sepay_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "payments_sepay_inbox"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_transactions" ADD CONSTRAINT "payments_sepay_transactions_connection_id_payments_sepay_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "payments_sepay_connections"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_transactions" ADD CONSTRAINT "payments_sepay_transactions_inbox_id_payments_sepay_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "payments_sepay_inbox"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_transactions" ADD CONSTRAINT "payments_sepay_transactions_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payments_sepay_transactions" ADD CONSTRAINT "sepay_transaction_revision_connection_fk" FOREIGN KEY ("connection_revision_id","connection_id") REFERENCES "payments_sepay_connection_revisions"("id","connection_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_provider_transaction_id_payments_sepay_transactions_id_fk" FOREIGN KEY ("provider_transaction_id") REFERENCES "payments_sepay_transactions"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_cutover_id_payments_sepay_account_cutovers_id_fk" FOREIGN KEY ("cutover_id") REFERENCES "payments_sepay_account_cutovers"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
-- All financial writers use this fence before acquiring account, connection or
-- intent row locks. A row lock alone cannot fence a cutover that does not exist.
-- The key is global across creators because receiving-account fingerprints are
-- deliberately not unique in the legacy schema.
CREATE FUNCTION payments_lock_account_fingerprint(fingerprint text) RETURNS void
LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('payments:account-fingerprint:' || fingerprint, 0))
$$;
--> statement-breakpoint
CREATE FUNCTION sepay_guard_account_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM payments_lock_account_fingerprint(NEW.account_fingerprint);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_sepay_account_fence BEFORE INSERT OR UPDATE ON payments_receiving_account_onboarding
FOR EACH ROW EXECUTE FUNCTION sepay_guard_account_fence();
--> statement-breakpoint
CREATE FUNCTION sepay_guard_connection() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE account payments_receiving_account_onboarding%ROWTYPE;
  revision payments_sepay_connection_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SePay connection history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  PERFORM payments_lock_account_fingerprint(NEW.account_fingerprint);
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.creator_user_id, NEW.provider_environment, NEW.account_fingerprint, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.creator_user_id, OLD.provider_environment, OLD.account_fingerprint, OLD.created_at)
      OR (OLD.provider_tenant_id IS NOT NULL AND ROW(NEW.provider_tenant_id, NEW.provider_account_id)
        IS DISTINCT FROM ROW(OLD.provider_tenant_id, OLD.provider_account_id)) THEN
      RAISE EXCEPTION 'SePay connection identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF to_jsonb(NEW) - ARRAY['refresh_lease_owner','refresh_lease_expires_at','updated_at']
      IS DISTINCT FROM to_jsonb(OLD) - ARRAY['refresh_lease_owner','refresh_lease_expires_at','updated_at'] THEN
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'SePay connection changes require a new version' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'SePay connection clock cannot move backwards' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Pausing/disconnecting a retired account must remain possible. Only creating
  -- or rebinding a connection, and making it ready, require current eligibility.
  IF TG_OP = 'INSERT' OR NEW.status = 'ready' OR NEW.account_version_id IS DISTINCT FROM OLD.account_version_id THEN
    SELECT * INTO account FROM payments_receiving_account_onboarding WHERE id = NEW.account_version_id FOR SHARE;
    IF account.id IS NULL OR account.applicant_user_id <> NEW.creator_user_id OR account.account_fingerprint <> NEW.account_fingerprint
      OR account.retired_at IS NOT NULL OR account.minimized_at IS NOT NULL OR account.proof_state <> 'verified' THEN
      RAISE EXCEPTION 'SePay connection requires the current verified receiving account' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.current_revision_id IS NOT NULL THEN
    SELECT * INTO revision FROM payments_sepay_connection_revisions WHERE id = NEW.current_revision_id;
    IF revision.id IS NULL OR revision.connection_id <> NEW.id
      OR ROW(revision.provider_tenant_id, revision.provider_account_id) IS DISTINCT FROM ROW(NEW.provider_tenant_id, NEW.provider_account_id) THEN
      RAISE EXCEPTION 'SePay revision does not match its connection' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'ready' AND (revision.access_token_envelope IS NULL OR revision.refresh_token_envelope IS NULL
      OR revision.provider_binding_envelope IS NULL OR cardinality(revision.scopes) <> 2
      OR NOT (revision.scopes @> ARRAY['transaction:read','bank-account:read']::text[])) THEN
      RAISE EXCEPTION 'Ready SePay connection requires a scoped grant and verified binding' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sepay_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON payments_sepay_connections
FOR EACH ROW EXECUTE FUNCTION sepay_guard_connection();
--> statement-breakpoint
CREATE TRIGGER sepay_revision_append_only BEFORE UPDATE OR DELETE ON payments_sepay_connection_revisions
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER sepay_cutover_append_only BEFORE UPDATE OR DELETE ON payments_sepay_account_cutovers
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER sepay_inbox_append_only BEFORE UPDATE OR DELETE ON payments_sepay_inbox
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER sepay_conflict_append_only BEFORE UPDATE OR DELETE ON payments_sepay_inbox_conflicts
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER sepay_decision_append_only BEFORE UPDATE OR DELETE ON payments_sepay_decisions
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE TRIGGER sepay_transaction_append_only BEFORE UPDATE OR DELETE ON payments_sepay_transactions
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE FUNCTION sepay_guard_oauth_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE connection payments_sepay_connections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SePay authorization evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO connection FROM payments_sepay_connections WHERE id = NEW.connection_id;
    IF connection.id IS NULL OR connection.creator_user_id <> NEW.actor_user_id OR connection.provider_environment <> NEW.provider_environment
      OR connection.version <> NEW.expected_connection_version OR NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'SePay authorization attempt binding is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF to_jsonb(NEW) - ARRAY['status','consumed_at'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','consumed_at']
      OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
      RAISE EXCEPTION 'SePay authorization attempt binding is immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT ((OLD.status = 'pending' AND NEW.status = 'exchanging') OR (OLD.status = 'exchanging' AND NEW.status IN ('completed','failed'))) THEN
      RAISE EXCEPTION 'SePay authorization attempt cannot be consumed twice' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sepay_oauth_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON payments_sepay_oauth_attempts
FOR EACH ROW EXECUTE FUNCTION sepay_guard_oauth_attempt();
--> statement-breakpoint
CREATE FUNCTION sepay_guard_cutover() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE connection payments_sepay_connections%ROWTYPE; account payments_receiving_account_onboarding%ROWTYPE;
BEGIN
  PERFORM payments_lock_account_fingerprint(NEW.account_fingerprint);
  SELECT * INTO account FROM payments_receiving_account_onboarding
    WHERE applicant_user_id = NEW.creator_user_id AND retired_at IS NULL FOR SHARE;
  SELECT * INTO connection FROM payments_sepay_connections WHERE id = NEW.connection_id FOR SHARE;
  IF account.id IS NULL OR account.account_fingerprint <> NEW.account_fingerprint OR account.proof_state <> 'verified'
    OR account.minimized_at IS NOT NULL OR account.proof_verified_at > NEW.cutover_at
    OR connection.id IS NULL OR connection.account_version_id <> account.id OR connection.status <> 'ready'
    OR ROW(connection.creator_user_id, connection.account_fingerprint, connection.provider_environment, connection.provider_tenant_id, connection.provider_account_id)
      IS DISTINCT FROM ROW(NEW.creator_user_id, NEW.account_fingerprint, NEW.provider_environment, NEW.provider_tenant_id, NEW.provider_account_id) THEN
    RAISE EXCEPTION 'SePay cutover requires a ready bound connection' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM payments_receiving_account_onboarding other_account
    WHERE other_account.account_fingerprint = NEW.account_fingerprint AND other_account.retired_at IS NULL
      AND other_account.applicant_user_id <> NEW.creator_user_id) THEN
    RAISE EXCEPTION 'SePay cutover cannot claim a shared receiving account' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_intents intent JOIN payments_receiving_account_onboarding binding ON binding.id = intent.account_version_id
    WHERE binding.account_fingerprint = NEW.account_fingerprint AND intent.settlement_lane = 'manual_attested' AND intent.state = 'awaiting_transfer') THEN
    RAISE EXCEPTION 'SePay cutover requires all manual intents to be terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sepay_cutover_guard BEFORE INSERT ON payments_sepay_account_cutovers
FOR EACH ROW EXECUTE FUNCTION sepay_guard_cutover();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_guard_initial_destination() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE account payments_receiving_account_onboarding%ROWTYPE; cutover payments_sepay_account_cutovers%ROWTYPE;
  connection payments_sepay_connections%ROWTYPE; fingerprint text;
BEGIN
  SELECT account_fingerprint INTO fingerprint FROM payments_receiving_account_onboarding WHERE id = NEW.account_version_id;
  PERFORM payments_lock_account_fingerprint(fingerprint);
  SELECT * INTO account FROM payments_receiving_account_onboarding WHERE id = NEW.account_version_id FOR SHARE;
  IF account.id IS NULL OR account.applicant_user_id <> NEW.creator_user_id OR account.proof_state <> 'verified'
    OR account.proof_verified_at > NEW.created_at OR account.retired_at IS NOT NULL OR account.minimized_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment destination must be the verified current creator account' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO cutover FROM payments_sepay_account_cutovers WHERE account_fingerprint = account.account_fingerprint;
  IF cutover.id IS NULL THEN
    IF NEW.settlement_lane <> 'manual_attested' OR NEW.cutover_id IS NOT NULL THEN
      RAISE EXCEPTION 'provider payment requires a durable account cutover' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.settlement_lane <> 'provider_bound' OR NEW.cutover_id IS DISTINCT FROM cutover.id
      OR cutover.creator_user_id <> NEW.creator_user_id OR NEW.created_at < cutover.cutover_at THEN
      RAISE EXCEPTION 'payment cannot bypass its receiving-account cutover' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO connection FROM payments_sepay_connections WHERE id = cutover.connection_id FOR SHARE;
    IF connection.id IS NULL OR connection.status <> 'ready' OR NOT connection.automation_enabled OR connection.account_version_id <> account.id THEN
      RAISE EXCEPTION 'provider payment requires an enabled ready connection' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sepay_guard_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE intent payment_intents%ROWTYPE; account payments_receiving_account_onboarding%ROWTYPE;
  cutover payments_sepay_account_cutovers%ROWTYPE; connection payments_sepay_connections%ROWTYPE;
  inbox payments_sepay_inbox%ROWTYPE;
BEGIN
  PERFORM payments_lock_account_fingerprint(NEW.account_fingerprint);
  SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id;
  SELECT * INTO account FROM payments_receiving_account_onboarding WHERE id = intent.account_version_id FOR SHARE;
  SELECT * INTO cutover FROM payments_sepay_account_cutovers WHERE id = intent.cutover_id;
  SELECT * INTO connection FROM payments_sepay_connections WHERE id = NEW.connection_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('payments:sepay-transaction:' || jsonb_build_array(NEW.provider_environment, NEW.provider_tenant_id, NEW.provider_account_id, NEW.provider_transaction_id)::text, 0));
  SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id FOR UPDATE;
  SELECT * INTO inbox FROM payments_sepay_inbox WHERE id = NEW.inbox_id;
  IF intent.id IS NULL OR intent.settlement_lane <> 'provider_bound' OR intent.state <> 'awaiting_transfer'
    OR account.id IS NULL OR account.retired_at IS NOT NULL OR account.minimized_at IS NOT NULL OR account.proof_state <> 'verified'
    OR account.applicant_user_id <> intent.creator_user_id OR account.account_fingerprint <> NEW.account_fingerprint
    OR account.proof_verified_at > NEW.verified_at
    OR cutover.id IS NULL OR cutover.connection_id <> NEW.connection_id OR cutover.creator_user_id <> intent.creator_user_id
    OR ROW(cutover.provider_environment, cutover.provider_tenant_id, cutover.provider_account_id, cutover.account_fingerprint)
      IS DISTINCT FROM ROW(NEW.provider_environment, NEW.provider_tenant_id, NEW.provider_account_id, NEW.account_fingerprint)
    OR connection.id IS NULL OR connection.status <> 'ready' OR connection.version <> NEW.connection_version
    OR connection.current_revision_id IS DISTINCT FROM NEW.connection_revision_id OR connection.account_version_id <> account.id
    OR ROW(connection.provider_environment, connection.provider_tenant_id, connection.provider_account_id)
      IS DISTINCT FROM ROW(NEW.provider_environment, NEW.provider_tenant_id, NEW.provider_account_id)
    OR inbox.id IS NULL OR inbox.connection_id <> NEW.connection_id OR inbox.disposition <> 'accepted'
    OR EXISTS (SELECT 1 FROM payments_sepay_inbox_conflicts WHERE inbox_id = NEW.inbox_id)
    OR NEW.amount_vnd <> intent.amount_vnd OR NEW.reference_hash <> intent.reference_hash
    OR NEW.transfer_at < intent.created_at OR NEW.transfer_at < cutover.cutover_at
    OR NEW.verified_at < intent.created_at OR NEW.verified_at >= intent.expires_at THEN
    RAISE EXCEPTION 'SePay transaction evidence does not match the current payment binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sepay_transaction_guard BEFORE INSERT ON payments_sepay_transactions
FOR EACH ROW EXECUTE FUNCTION sepay_guard_transaction();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_guard_confirmation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE intent payment_intents%ROWTYPE; account payments_receiving_account_onboarding%ROWTYPE;
  provider_transaction payments_sepay_transactions%ROWTYPE; connection payments_sepay_connections%ROWTYPE; fingerprint text;
BEGIN
  SELECT receiving.account_fingerprint INTO fingerprint FROM payment_intents payment
    JOIN payments_receiving_account_onboarding receiving ON receiving.id = payment.account_version_id WHERE payment.id = NEW.payment_intent_id;
  PERFORM payments_lock_account_fingerprint(fingerprint);
  SELECT receiving.* INTO account FROM payment_intents payment
    JOIN payments_receiving_account_onboarding receiving ON receiving.id = payment.account_version_id
    WHERE payment.id = NEW.payment_intent_id FOR SHARE OF receiving;
  IF NEW.source <> 'creator_manual' THEN
    SELECT * INTO provider_transaction FROM payments_sepay_transactions WHERE id = NEW.provider_transaction_id;
    SELECT * INTO connection FROM payments_sepay_connections WHERE id = provider_transaction.connection_id FOR SHARE;
  END IF;
  SELECT * INTO intent FROM payment_intents WHERE id = NEW.payment_intent_id FOR UPDATE;
  IF intent.id IS NULL OR intent.state NOT IN ('awaiting_transfer','confirmed')
    OR NEW.confirmed_at < intent.created_at OR NEW.confirmed_at >= intent.expires_at THEN
    RAISE EXCEPTION 'confirmation requires an unexpired intent' USING ERRCODE = '23514';
  END IF;
  IF account.id IS NULL OR account.applicant_user_id <> NEW.creator_user_id OR account.retired_at IS NOT NULL
    OR account.minimized_at IS NOT NULL OR account.proof_state <> 'verified' OR account.proof_verified_at > NEW.confirmed_at THEN
    RAISE EXCEPTION 'confirmation account lineage is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.source = 'creator_manual' THEN
    IF intent.settlement_lane <> 'manual_attested' OR EXISTS (SELECT 1 FROM payments_sepay_account_cutovers WHERE account_fingerprint = fingerprint) THEN
      RAISE EXCEPTION 'manual confirmation cannot bypass a provider-bound account' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF intent.settlement_lane <> 'provider_bound' OR provider_transaction.id IS NULL OR provider_transaction.payment_intent_id <> intent.id
      OR provider_transaction.amount_vnd <> NEW.observed_amount_vnd OR provider_transaction.reference_hash <> NEW.reference_hash
      OR provider_transaction.verified_at > NEW.confirmed_at OR provider_transaction.verified_at < NEW.confirmed_at - interval '5 minutes'
      OR connection.id IS NULL OR connection.status <> 'ready' OR connection.version <> provider_transaction.connection_version
      OR connection.current_revision_id IS DISTINCT FROM provider_transaction.connection_revision_id
      OR (NEW.source = 'sepay_automatic' AND NOT connection.automation_enabled) THEN
      RAISE EXCEPTION 'provider confirmation requires current independently verified evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A reservation without a completed confirmation must roll back; otherwise a
-- crashed/partial writer could consume a canonical transfer permanently.
CREATE FUNCTION sepay_check_transaction_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_confirmations confirmation
    JOIN payment_intents intent ON intent.id = confirmation.payment_intent_id
    JOIN tips tip ON tip.id = intent.tip_id
    WHERE confirmation.provider_transaction_id = NEW.id AND confirmation.payment_intent_id = NEW.payment_intent_id
      AND confirmation.source IN ('sepay_automatic','creator_reviewed_sepay')
      AND intent.state = 'confirmed' AND tip.state = 'completed') THEN
    RAISE EXCEPTION 'SePay transaction reservation and confirmation must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sepay_transaction_completion AFTER INSERT ON payments_sepay_transactions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sepay_check_transaction_completion();
--> statement-breakpoint
CREATE FUNCTION sepay_guard_processing() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SePay processing evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.inbox_id <> OLD.inbox_id OR NEW.version <> OLD.version + 1 OR NEW.attempts < OLD.attempts
    OR NEW.updated_at < OLD.updated_at OR (OLD.status = 'confirmed' AND NEW.status <> 'confirmed') THEN
    RAISE EXCEPTION 'SePay processing projection cannot rewrite its history' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sepay_processing_guard BEFORE UPDATE OR DELETE ON payments_sepay_processing
FOR EACH ROW EXECUTE FUNCTION sepay_guard_processing();
--> statement-breakpoint
CREATE FUNCTION sepay_guard_review_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments_sepay_inbox inbox
    JOIN payments_sepay_connections connection ON connection.id = inbox.connection_id
    WHERE inbox.id = NEW.inbox_id AND connection.creator_user_id = NEW.actor_user_id) THEN
    RAISE EXCEPTION 'SePay review actor must own the connection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sepay_review_actor_guard BEFORE INSERT ON payments_sepay_decisions
FOR EACH ROW EXECUTE FUNCTION sepay_guard_review_actor();
