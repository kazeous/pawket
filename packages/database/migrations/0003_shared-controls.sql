CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"assurance" jsonb NOT NULL,
	"application_revision" text NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_audit_events_outcome_check" CHECK ("admin_audit_events"."outcome" in ('succeeded', 'denied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "system_business_calendar_holidays" (
	"calendar_version" text NOT NULL,
	"holiday_date" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "system_business_calendar_holidays_pk" PRIMARY KEY("calendar_version","holiday_date")
);
--> statement-breakpoint
CREATE TABLE "system_business_calendar_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"jurisdiction" text DEFAULT 'VN' NOT NULL,
	"time_zone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	"source_label" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "system_business_calendar_versions_vn_check" CHECK ("system_business_calendar_versions"."jurisdiction" = 'VN' and "system_business_calendar_versions"."time_zone" = 'Asia/Ho_Chi_Minh')
);
--> statement-breakpoint
CREATE TABLE "system_command_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"command_scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"result_reference" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "system_command_idempotency_status_check" CHECK ("system_command_idempotency"."status" in ('in_progress', 'completed')),
	CONSTRAINT "system_command_idempotency_completion_check" CHECK (("system_command_idempotency"."status" = 'in_progress' and "system_command_idempotency"."completed_at" is null and "system_command_idempotency"."result_reference" is null)
        or ("system_command_idempotency"."status" = 'completed' and "system_command_idempotency"."completed_at" is not null and "system_command_idempotency"."result_reference" is not null)),
	CONSTRAINT "system_command_idempotency_expiry_check" CHECK ("system_command_idempotency"."expires_at" > "system_command_idempotency"."created_at")
);
--> statement-breakpoint
ALTER TABLE "system_business_calendar_holidays" ADD CONSTRAINT "system_business_calendar_holidays_calendar_version_system_business_calendar_versions_version_fk" FOREIGN KEY ("calendar_version") REFERENCES "system_business_calendar_versions"("version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "admin_audit_events_subject_idx" ON "admin_audit_events" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "admin_audit_events_actor_idx" ON "admin_audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "system_business_calendar_holidays_date_idx" ON "system_business_calendar_holidays" USING btree ("holiday_date");--> statement-breakpoint
CREATE UNIQUE INDEX "system_command_idempotency_actor_scope_key_uidx" ON "system_command_idempotency" USING btree ("actor_user_id","command_scope","key_hash");--> statement-breakpoint
CREATE INDEX "system_command_idempotency_expiry_idx" ON "system_command_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE FUNCTION "reject_immutable_control_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'immutable control record' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "admin_audit_events_immutable"
BEFORE UPDATE OR DELETE ON "admin_audit_events"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_control_change"();--> statement-breakpoint
CREATE TRIGGER "system_business_calendar_versions_immutable"
BEFORE UPDATE OR DELETE ON "system_business_calendar_versions"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_control_change"();--> statement-breakpoint
CREATE TRIGGER "system_business_calendar_holidays_immutable"
BEFORE UPDATE OR DELETE ON "system_business_calendar_holidays"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_control_change"();
