CREATE TABLE "payments_unmatched_deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"possible_challenge_id" uuid,
	"bank_transaction_fingerprint" text NOT NULL,
	"actual_amount_vnd" integer NOT NULL,
	"actual_reference_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source_bank_bin" text,
	"source_account_fingerprint" text,
	"source_masked_suffix" text,
	"reason" text NOT NULL,
	"resolution_state" text DEFAULT 'pending_review' NOT NULL,
	"refund_liability_state" text NOT NULL,
	"private_note" text NOT NULL,
	"reconciled_by_owner_user_id" text NOT NULL,
	"owner_session_id" text NOT NULL,
	"step_up_proof_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_unmatched_amount_check" CHECK ("payments_unmatched_deposits"."actual_amount_vnd" > 0),
	CONSTRAINT "payments_unmatched_reason_check" CHECK ("payments_unmatched_deposits"."reason" in ('amount_mismatch', 'reference_mismatch', 'source_mismatch', 'unidentified_source', 'late', 'duplicate')),
	CONSTRAINT "payments_unmatched_resolution_check" CHECK ("payments_unmatched_deposits"."resolution_state" in ('pending_review', 'refund_required', 'resolved')),
	CONSTRAINT "payments_unmatched_liability_check" CHECK ("payments_unmatched_deposits"."refund_liability_state" in ('unknown', 'pending', 'sent', 'attention_required'))
);
--> statement-breakpoint
CREATE TABLE "payments_verification_deposit_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"account_version_id" uuid NOT NULL,
	"amount_vnd" integer NOT NULL,
	"reference_hash" text NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"issued_by_owner_user_id" text NOT NULL,
	"step_up_proof_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_deposit_challenge_amount_check" CHECK ("payments_verification_deposit_challenges"."amount_vnd" between 1000 and 50000),
	CONSTRAINT "payments_deposit_challenge_reference_check" CHECK ("payments_verification_deposit_challenges"."reference_hash" ~ '^sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payments_deposit_challenge_state_check" CHECK ("payments_verification_deposit_challenges"."state" in ('issued', 'sent_reported', 'verified', 'expired')),
	CONSTRAINT "payments_deposit_challenge_expiry_check" CHECK ("payments_verification_deposit_challenges"."expires_at" = "payments_verification_deposit_challenges"."issued_at" + interval '72 hours'),
	CONSTRAINT "payments_deposit_challenge_verified_check" CHECK (("payments_verification_deposit_challenges"."state" = 'verified' and "payments_verification_deposit_challenges"."verified_at" is not null)
        or ("payments_verification_deposit_challenges"."state" <> 'verified' and "payments_verification_deposit_challenges"."verified_at" is null))
);
--> statement-breakpoint
CREATE TABLE "payments_verification_deposit_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_id" uuid NOT NULL,
	"bank_transaction_fingerprint" text NOT NULL,
	"actual_amount_vnd" integer NOT NULL,
	"actual_reference_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source_bank_bin" text NOT NULL,
	"source_account_fingerprint" text NOT NULL,
	"source_masked_suffix" text NOT NULL,
	"private_note" text NOT NULL,
	"result" text DEFAULT 'matched' NOT NULL,
	"reconciled_by_owner_user_id" text NOT NULL,
	"owner_session_id" text NOT NULL,
	"step_up_proof_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_deposit_receipt_amount_check" CHECK ("payments_verification_deposit_receipts"."actual_amount_vnd" > 0),
	CONSTRAINT "payments_deposit_receipt_result_check" CHECK ("payments_verification_deposit_receipts"."result" = 'matched')
);
--> statement-breakpoint
CREATE TABLE "payments_verification_deposit_refund_obligations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"account_version_id" uuid NOT NULL,
	"applicant_user_id" text NOT NULL,
	"amount_vnd" integer NOT NULL,
	"locked_bank_bin" text NOT NULL,
	"locked_bank_name" text NOT NULL,
	"locked_account_number_envelope" jsonb NOT NULL,
	"locked_account_holder_label_envelope" jsonb NOT NULL,
	"locked_masked_suffix" text NOT NULL,
	"locked_account_fingerprint" text NOT NULL,
	"calendar_version" text NOT NULL,
	"receipt_date" date NOT NULL,
	"refund_not_before" date NOT NULL,
	"refund_due" date NOT NULL,
	"state" text DEFAULT 'pending_window' NOT NULL,
	"attention_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_refund_obligation_amount_check" CHECK ("payments_verification_deposit_refund_obligations"."amount_vnd" > 0),
	CONSTRAINT "payments_refund_obligation_window_check" CHECK ("payments_verification_deposit_refund_obligations"."refund_not_before" > "payments_verification_deposit_refund_obligations"."receipt_date" and "payments_verification_deposit_refund_obligations"."refund_due" >= "payments_verification_deposit_refund_obligations"."refund_not_before"),
	CONSTRAINT "payments_refund_obligation_state_check" CHECK ("payments_verification_deposit_refund_obligations"."state" in ('pending_window', 'ready', 'sent', 'attention_required')),
	CONSTRAINT "payments_refund_obligation_attention_check" CHECK (("payments_verification_deposit_refund_obligations"."state" = 'attention_required' and "payments_verification_deposit_refund_obligations"."attention_reason" is not null)
        or ("payments_verification_deposit_refund_obligations"."state" <> 'attention_required' and "payments_verification_deposit_refund_obligations"."attention_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "payments_verification_deposit_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"obligation_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"outbound_bank_reference_fingerprint" text,
	"outbound_bank_reference_masked" text,
	"sent_at" timestamp with time zone,
	"attention_reason" text,
	"recorded_by_owner_user_id" text NOT NULL,
	"owner_session_id" text NOT NULL,
	"step_up_proof_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_refund_outcome_check" CHECK ("payments_verification_deposit_refunds"."outcome" in ('sent', 'attention_required')),
	CONSTRAINT "payments_refund_evidence_check" CHECK (("payments_verification_deposit_refunds"."outcome" = 'sent' and "payments_verification_deposit_refunds"."outbound_bank_reference_fingerprint" is not null
            and "payments_verification_deposit_refunds"."outbound_bank_reference_masked" is not null and "payments_verification_deposit_refunds"."sent_at" is not null
            and "payments_verification_deposit_refunds"."attention_reason" is null)
        or ("payments_verification_deposit_refunds"."outcome" = 'attention_required' and "payments_verification_deposit_refunds"."sent_at" is null
            and "payments_verification_deposit_refunds"."attention_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "payments_verification_deposit_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_id" uuid NOT NULL,
	"applicant_user_id" text NOT NULL,
	"reported_sent_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments_unmatched_deposits" ADD CONSTRAINT "payments_unmatched_deposits_possible_challenge_id_payments_verification_deposit_challenges_id_fk" FOREIGN KEY ("possible_challenge_id") REFERENCES "payments_verification_deposit_challenges"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_unmatched_deposits" ADD CONSTRAINT "payments_unmatched_deposits_reconciled_by_owner_user_id_identity_users_id_fk" FOREIGN KEY ("reconciled_by_owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_challenges" ADD CONSTRAINT "payments_verification_deposit_challenges_application_id_creator_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "creator_applications"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_challenges" ADD CONSTRAINT "payments_verification_deposit_challenges_revision_id_creator_application_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "creator_application_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_challenges" ADD CONSTRAINT "payments_verification_deposit_challenges_account_version_id_payments_receiving_account_onboarding_id_fk" FOREIGN KEY ("account_version_id") REFERENCES "payments_receiving_account_onboarding"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_challenges" ADD CONSTRAINT "payments_verification_deposit_challenges_issued_by_owner_user_id_identity_users_id_fk" FOREIGN KEY ("issued_by_owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_receipts" ADD CONSTRAINT "payments_verification_deposit_receipts_challenge_id_payments_verification_deposit_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "payments_verification_deposit_challenges"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_receipts" ADD CONSTRAINT "payments_verification_deposit_receipts_reconciled_by_owner_user_id_identity_users_id_fk" FOREIGN KEY ("reconciled_by_owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD CONSTRAINT "payments_verification_deposit_refund_obligations_receipt_id_payments_verification_deposit_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "payments_verification_deposit_receipts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD CONSTRAINT "payments_verification_deposit_refund_obligations_challenge_id_payments_verification_deposit_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "payments_verification_deposit_challenges"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD CONSTRAINT "payments_verification_deposit_refund_obligations_account_version_id_payments_receiving_account_onboarding_id_fk" FOREIGN KEY ("account_version_id") REFERENCES "payments_receiving_account_onboarding"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD CONSTRAINT "payments_verification_deposit_refund_obligations_applicant_user_id_identity_users_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD CONSTRAINT "payments_verification_deposit_refund_obligations_calendar_version_system_business_calendar_versions_version_fk" FOREIGN KEY ("calendar_version") REFERENCES "system_business_calendar_versions"("version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refunds" ADD CONSTRAINT "payments_verification_deposit_refunds_obligation_id_payments_verification_deposit_refund_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "payments_verification_deposit_refund_obligations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refunds" ADD CONSTRAINT "payments_verification_deposit_refunds_recorded_by_owner_user_id_identity_users_id_fk" FOREIGN KEY ("recorded_by_owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_reports" ADD CONSTRAINT "payments_verification_deposit_reports_challenge_id_payments_verification_deposit_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "payments_verification_deposit_challenges"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_reports" ADD CONSTRAINT "payments_verification_deposit_reports_applicant_user_id_identity_users_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "payments_unmatched_resolution_idx" ON "payments_unmatched_deposits" USING btree ("resolution_state","created_at");--> statement-breakpoint
CREATE INDEX "payments_unmatched_bank_txn_idx" ON "payments_unmatched_deposits" USING btree ("bank_transaction_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_deposit_challenge_reference_uidx" ON "payments_verification_deposit_challenges" USING btree ("reference_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_deposit_challenge_active_revision_uidx" ON "payments_verification_deposit_challenges" USING btree ("revision_id","account_version_id") WHERE "payments_verification_deposit_challenges"."state" in ('issued', 'sent_reported');--> statement-breakpoint
CREATE INDEX "payments_deposit_challenge_application_idx" ON "payments_verification_deposit_challenges" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_deposit_receipt_challenge_uidx" ON "payments_verification_deposit_receipts" USING btree ("challenge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_deposit_receipt_bank_txn_uidx" ON "payments_verification_deposit_receipts" USING btree ("bank_transaction_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_refund_obligation_receipt_uidx" ON "payments_verification_deposit_refund_obligations" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_refund_obligation_challenge_uidx" ON "payments_verification_deposit_refund_obligations" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "payments_refund_obligation_state_due_idx" ON "payments_verification_deposit_refund_obligations" USING btree ("state","refund_due");--> statement-breakpoint
CREATE INDEX "payments_refund_obligation_applicant_idx" ON "payments_verification_deposit_refund_obligations" USING btree ("applicant_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_refund_sent_obligation_uidx" ON "payments_verification_deposit_refunds" USING btree ("obligation_id") WHERE "payments_verification_deposit_refunds"."outcome" = 'sent';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_refund_outbound_reference_uidx" ON "payments_verification_deposit_refunds" USING btree ("outbound_bank_reference_fingerprint") WHERE "payments_verification_deposit_refunds"."outbound_bank_reference_fingerprint" is not null;--> statement-breakpoint
CREATE INDEX "payments_refund_obligation_idx" ON "payments_verification_deposit_refunds" USING btree ("obligation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_deposit_report_challenge_uidx" ON "payments_verification_deposit_reports" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "payments_deposit_report_applicant_idx" ON "payments_verification_deposit_reports" USING btree ("applicant_user_id","reported_at");
