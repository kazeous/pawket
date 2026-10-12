CREATE TABLE "notification_preferences" (
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_category_channel_pk" PRIMARY KEY("user_id","category","channel"),
	CONSTRAINT "notification_preferences_category_check" CHECK ("notification_preferences"."category" in ('orders', 'messages', 'deliveries', 'disputes_refunds', 'moderation', 'owner_queue')),
	CONSTRAINT "notification_preferences_channel_check" CHECK ("notification_preferences"."channel" in ('email'))
);
--> statement-breakpoint
CREATE TABLE "notification_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"clock" text NOT NULL,
	"stage" text NOT NULL,
	"effective_deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_reminders_clock_check" CHECK ("notification_reminders"."clock" in ('request_response', 'quote_acceptance', 'payment', 'delivery_due', 'review_window', 'proposal_response', 'dispute_response', 'late_claim_response', 'refund_send', 'refund_confirm', 'appeal_window')),
	CONSTRAINT "notification_reminders_stage_check" CHECK ("notification_reminders"."stage" in ('due_24h','missed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"variant" text,
	"category" text NOT NULL,
	"action_required" boolean NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"link_path" text NOT NULL,
	"collapse_key" text,
	"collapsed_count" integer DEFAULT 1 NOT NULL,
	"last_sequence" integer,
	"source_key" text NOT NULL,
	"email_state" text NOT NULL,
	"email_due_at" timestamp with time zone,
	"email_queued_at" timestamp with time zone,
	"email_handoff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('order_requested', 'order_quoted', 'order_payment_due', 'order_transfer_claimed', 'order_in_progress', 'order_delivered', 'order_completed', 'order_closed', 'order_messages', 'draft_sent', 'draft_responded', 'proposal_received', 'proposal_ended', 'dispute_opened', 'dispute_statement', 'dispute_closed', 'ruling_recorded', 'ruling_corrected', 'late_claim_filed', 'late_claim_ended', 'refund_account_needed', 'refund_owed', 'refund_send_due', 'refund_sent', 'refund_not_received', 'refund_resend_required', 'refund_settled', 'refund_overdue', 'content_hidden', 'content_restored', 'penalty_applied', 'penalty_ended', 'appeal_received', 'appeal_decided', 'report_received', 'report_closed', 'owner_case_opened', 'tip_status', 'tip_transfer_claimed', 'account_application', 'account_creator_status', 'account_deposit_refund', 'reminder_due', 'deadline_missed')),
	CONSTRAINT "notifications_variant_check" CHECK ("notifications"."variant" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "notifications_category_check" CHECK ("notifications"."category" in ('orders', 'messages', 'deliveries', 'disputes_refunds', 'moderation', 'owner_queue', 'tips', 'account')),
	CONSTRAINT "notifications_subject_type_check" CHECK ("notifications"."subject_type" in ('commission_order', 'commission_proposal', 'commission_dispute', 'commission_late_payment_claim', 'commission_refund_obligation', 'trust_case', 'trust_content_hide', 'trust_penalty', 'trust_appeal', 'trust_report', 'tip', 'creator_application', 'creator_capability', 'verification_deposit')),
	CONSTRAINT "notifications_link_path_check" CHECK ("notifications"."link_path" ~ '^/[A-Za-z0-9/_-]{1,200}$' and "notifications"."link_path" !~ '//'),
	CONSTRAINT "notifications_collapse_key_check" CHECK ("notifications"."collapse_key" ~ '^messages:[0-9a-f-]{36}$'),
	CONSTRAINT "notifications_collapsed_count_check" CHECK ("notifications"."collapsed_count" >= 1),
	CONSTRAINT "notifications_last_sequence_check" CHECK (("notifications"."last_sequence" is not null) = ("notifications"."collapse_key" is not null)),
	CONSTRAINT "notifications_email_state_check" CHECK ("notifications"."email_state" in ('none','pending','queued','suppressed','attention_required')),
	CONSTRAINT "notifications_email_due_check" CHECK (("notifications"."email_due_at" is not null) = ("notifications"."email_state" = 'pending')),
	CONSTRAINT "notifications_email_handoff_check" CHECK (("notifications"."email_handoff_id" is not null) = ("notifications"."email_state" in ('queued','attention_required'))),
	CONSTRAINT "notifications_read_at_check" CHECK ("notifications"."read_at" >= "notifications"."created_at")
);
--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" DROP CONSTRAINT "identity_email_handoffs_purpose_check";--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_identity_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_email_handoff_id_identity_email_handoffs_id_fk" FOREIGN KEY ("email_handoff_id") REFERENCES "identity_email_handoffs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_reminders_deadline_uidx" ON "notification_reminders" USING btree ("subject_type","subject_id","clock","stage","effective_deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_source_recipient_uidx" ON "notifications" USING btree ("source_key","recipient_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_unread_collapse_uidx" ON "notifications" USING btree ("recipient_user_id","collapse_key") WHERE "notifications"."collapse_key" is not null and "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_pending_email_idx" ON "notifications" USING btree ("email_due_at") WHERE "notifications"."email_state" = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_retention_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "identity_email_handoffs" ADD CONSTRAINT "identity_email_handoffs_purpose_check" CHECK ("identity_email_handoffs"."purpose" in ('email_verification', 'password_reset', 'email_change', 'security_notice', 'application_outcome', 'creator_status', 'refund_status', 'tip_status', 'enforcement_notice', 'notification'));