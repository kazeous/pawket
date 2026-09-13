ALTER TABLE "system_retention_runs" DROP CONSTRAINT "system_retention_runs_dataset_check";--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" DROP CONSTRAINT "identity_email_handoffs_purpose_check";--> statement-breakpoint
ALTER TABLE "system_retention_runs" ADD CONSTRAINT "system_retention_tip_report_only_check" CHECK ("system_retention_runs"."dataset" not like 'tip_%' or ("system_retention_runs"."mode" = 'report_only' and "system_retention_runs"."processed_count" = 0 and "system_retention_runs"."protected_count" = "system_retention_runs"."candidate_count"));--> statement-breakpoint
ALTER TABLE "system_retention_runs" ADD CONSTRAINT "system_retention_runs_dataset_check" CHECK ("system_retention_runs"."dataset" in ('provisional_accounts', 'verifications', 'sessions', 'receiving_accounts', 'application_content', 'security_throttles', 'tip_guest_capabilities', 'tip_guest_content', 'tip_instructions', 'tip_claims', 'tip_confirmations'));--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_purpose_check" CHECK ("identity_email_handoffs"."purpose" in ('email_verification', 'password_reset', 'email_change', 'security_notice', 'application_outcome', 'creator_status', 'refund_status', 'tip_status'));
--> statement-breakpoint
-- Existing financial references remain protected even if a general retention
-- caller tries to minimize an old account version. The row lock also serializes
-- this guard against the receiving-account lock used during intent creation.
CREATE FUNCTION payments_guard_tip_account_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.minimized_at IS NOT NULL OR NEW.account_number_envelope IS NULL OR NEW.account_holder_label_envelope IS NULL)
     AND EXISTS (SELECT 1 FROM payment_intents WHERE account_version_id = OLD.id)
  THEN
    RAISE EXCEPTION 'Tip receiving-account evidence is protected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_tip_account_evidence_guard
BEFORE UPDATE OF minimized_at, account_number_envelope, account_holder_label_envelope
ON payments_receiving_account_onboarding
FOR EACH ROW EXECUTE FUNCTION payments_guard_tip_account_evidence();
