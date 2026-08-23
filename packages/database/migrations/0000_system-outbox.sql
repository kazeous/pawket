CREATE TABLE "system_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"published_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "system_outbox_pending_idx" ON "system_outbox" USING btree ("available_at","occurred_at") WHERE "system_outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "system_outbox_lease_idx" ON "system_outbox" USING btree ("locked_at") WHERE "system_outbox"."published_at" is null;