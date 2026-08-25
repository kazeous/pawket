ALTER TABLE "identity_email_handoffs" DROP CONSTRAINT "identity_email_handoffs_purpose_check";--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" DROP CONSTRAINT "identity_email_handoffs_status_check";--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ALTER COLUMN "destination_envelope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD COLUMN "source_outbox_event_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_email_handoffs_source_outbox_uidx" ON "identity_email_handoffs" USING btree ("source_outbox_event_id") WHERE "identity_email_handoffs"."source_outbox_event_id" is not null;--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_destination_check" CHECK (("identity_email_handoffs"."status" = 'attention_required' and "identity_email_handoffs"."destination_envelope" is null and "identity_email_handoffs"."failure_code" is not null)
        or ("identity_email_handoffs"."status" <> 'attention_required' and "identity_email_handoffs"."destination_envelope" is not null));--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_purpose_check" CHECK ("identity_email_handoffs"."purpose" in ('email_verification', 'password_reset', 'email_change', 'security_notice', 'application_outcome', 'creator_status', 'refund_status'));--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_status_check" CHECK ("identity_email_handoffs"."status" in ('pending', 'processing', 'sent', 'failed', 'attention_required'));
