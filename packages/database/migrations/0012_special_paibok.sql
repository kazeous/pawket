ALTER TABLE "payments_verification_deposit_refunds" DROP CONSTRAINT "payments_refund_evidence_check";--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refunds" ADD COLUMN "actual_amount_vnd" integer;--> statement-breakpoint
ALTER TABLE "payments_verification_deposit_refunds" ADD CONSTRAINT "payments_refund_evidence_check" CHECK (("payments_verification_deposit_refunds"."outcome" = 'sent' and "payments_verification_deposit_refunds"."actual_amount_vnd" > 0
            and "payments_verification_deposit_refunds"."outbound_bank_reference_fingerprint" is not null
            and "payments_verification_deposit_refunds"."outbound_bank_reference_masked" is not null and "payments_verification_deposit_refunds"."sent_at" is not null
            and "payments_verification_deposit_refunds"."attention_reason" is null)
        or ("payments_verification_deposit_refunds"."outcome" = 'attention_required' and "payments_verification_deposit_refunds"."sent_at" is null
            and "payments_verification_deposit_refunds"."actual_amount_vnd" is null and "payments_verification_deposit_refunds"."attention_reason" is not null));