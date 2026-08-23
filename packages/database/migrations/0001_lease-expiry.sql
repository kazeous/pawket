DROP INDEX "system_outbox_lease_idx";--> statement-breakpoint
ALTER TABLE "system_outbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "system_outbox_lease_idx" ON "system_outbox" USING btree ("lease_expires_at") WHERE "system_outbox"."published_at" is null;