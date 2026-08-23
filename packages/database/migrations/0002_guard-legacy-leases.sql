-- Preserve in-flight legacy locks through the maximum configured five-minute lease window.
UPDATE "system_outbox"
SET "lease_expires_at" = "locked_at" + interval '5 minutes'
WHERE "locked_at" IS NOT NULL
  AND "lease_expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "system_outbox" ADD CONSTRAINT "system_outbox_lease_expiry_required" CHECK ("system_outbox"."locked_at" is null or "system_outbox"."lease_expires_at" is not null);
