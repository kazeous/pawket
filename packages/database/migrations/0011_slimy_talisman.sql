ALTER TABLE "payments_verification_deposit_refund_obligations" ADD COLUMN "due_soon_emitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD COLUMN "due_today_emitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refund_obligations" ADD COLUMN "overdue_emitted_at" timestamp with time zone;--> statement-breakpoint
CREATE FUNCTION "payments_reject_receiving_account_binding_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' OR ROW(
		OLD.id, OLD.onboarding_id, OLD.applicant_user_id, OLD.version,
		OLD.bank_bin, OLD.bank_name, OLD.account_number_envelope,
		OLD.account_holder_label_envelope, OLD.masked_suffix,
		OLD.account_fingerprint, OLD.created_at
	) IS DISTINCT FROM ROW(
		NEW.id, NEW.onboarding_id, NEW.applicant_user_id, NEW.version,
		NEW.bank_bin, NEW.bank_name, NEW.account_number_envelope,
		NEW.account_holder_label_envelope, NEW.masked_suffix,
		NEW.account_fingerprint, NEW.created_at
	) THEN
		RAISE EXCEPTION 'payments receiving account versions are immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payments_receiving_account_binding_immutable"
BEFORE UPDATE OR DELETE ON "payments_receiving_account_onboarding"
FOR EACH ROW EXECUTE FUNCTION "payments_reject_receiving_account_binding_change"();--> statement-breakpoint
CREATE FUNCTION "payments_reject_challenge_binding_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' OR ROW(
		OLD.id, OLD.application_id, OLD.revision_id, OLD.account_version_id,
		OLD.amount_vnd, OLD.reference_hash, OLD.issued_by_owner_user_id,
		OLD.step_up_proof_id, OLD.issued_at, OLD.expires_at, OLD.created_at
	) IS DISTINCT FROM ROW(
		NEW.id, NEW.application_id, NEW.revision_id, NEW.account_version_id,
		NEW.amount_vnd, NEW.reference_hash, NEW.issued_by_owner_user_id,
		NEW.step_up_proof_id, NEW.issued_at, NEW.expires_at, NEW.created_at
	) THEN
		RAISE EXCEPTION 'payments verification challenge binding is immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payments_verification_challenge_binding_immutable"
BEFORE UPDATE OR DELETE ON "payments_verification_deposit_challenges"
FOR EACH ROW EXECUTE FUNCTION "payments_reject_challenge_binding_change"();--> statement-breakpoint
CREATE FUNCTION "payments_reject_refund_obligation_binding_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' OR ROW(
		OLD.id, OLD.receipt_id, OLD.challenge_id, OLD.account_version_id,
		OLD.applicant_user_id, OLD.amount_vnd, OLD.locked_bank_bin,
		OLD.locked_bank_name, OLD.locked_account_number_envelope,
		OLD.locked_account_holder_label_envelope, OLD.locked_masked_suffix,
		OLD.locked_account_fingerprint, OLD.calendar_version, OLD.receipt_date,
		OLD.refund_not_before, OLD.refund_due, OLD.created_at
	) IS DISTINCT FROM ROW(
		NEW.id, NEW.receipt_id, NEW.challenge_id, NEW.account_version_id,
		NEW.applicant_user_id, NEW.amount_vnd, NEW.locked_bank_bin,
		NEW.locked_bank_name, NEW.locked_account_number_envelope,
		NEW.locked_account_holder_label_envelope, NEW.locked_masked_suffix,
		NEW.locked_account_fingerprint, NEW.calendar_version, NEW.receipt_date,
		NEW.refund_not_before, NEW.refund_due, NEW.created_at
	) THEN
		RAISE EXCEPTION 'payments refund obligation binding is immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payments_refund_obligation_binding_immutable"
BEFORE UPDATE OR DELETE ON "payments_verification_deposit_refund_obligations"
FOR EACH ROW EXECUTE FUNCTION "payments_reject_refund_obligation_binding_change"();--> statement-breakpoint
CREATE TRIGGER "payments_verification_receipts_immutable"
BEFORE UPDATE OR DELETE ON "payments_verification_deposit_receipts"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_control_change"();--> statement-breakpoint
CREATE TRIGGER "payments_verification_reports_immutable"
BEFORE UPDATE OR DELETE ON "payments_verification_deposit_reports"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_control_change"();--> statement-breakpoint
CREATE TRIGGER "payments_verification_refunds_immutable"
BEFORE UPDATE OR DELETE ON "payments_verification_deposit_refunds"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_control_change"();
