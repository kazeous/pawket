CREATE TABLE "public_media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"declared_source_format" text NOT NULL,
	"state" text DEFAULT 'awaiting_upload' NOT NULL,
	"source_allocation_bytes" bigint NOT NULL,
	"source_object_key" text NOT NULL,
	"source_object_version_id" text,
	"source_object_etag" text,
	"normalized_master_object_key" text,
	"normalized_master_object_version_id" text,
	"actual_source_bytes" bigint,
	"source_deleted_at" timestamp with time zone,
	"width" integer,
	"height" integer,
	"failure_code" text,
	"ready_at" timestamp with time zone,
	"deletion_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_media_assets_purpose_check" CHECK ("purpose" in ('avatar','cover','showcase')),
	CONSTRAINT "public_media_assets_source_format_check" CHECK ("declared_source_format" in ('jpeg','png','webp')),
	CONSTRAINT "public_media_assets_state_check" CHECK ("state" in ('awaiting_upload','pending','processing','ready','failed','deleted')),
	CONSTRAINT "public_media_assets_allocation_check" CHECK ("source_allocation_bytes" between 0 and 10485760),
	CONSTRAINT "public_media_assets_actual_bytes_check" CHECK ("actual_source_bytes" is null or "actual_source_bytes" between 0 and 10485760),
	CONSTRAINT "public_media_assets_dimensions_check" CHECK (("width" is null and "height" is null) or ("width" between 1 and 4096 and "height" between 1 and 4096 and "width" * "height" <= 40000000)),
	CONSTRAINT "public_media_assets_master_identity_check" CHECK (("normalized_master_object_key" is null and "normalized_master_object_version_id" is null) or ("normalized_master_object_key" is not null and "normalized_master_object_version_id" is not null)),
	CONSTRAINT "public_media_assets_master_key_check" CHECK ("normalized_master_object_key" is null or "normalized_master_object_key" ~ '^derivatives/[0-9a-f-]{36}/master/[A-Za-z0-9_-]+[.]webp$'),
	CONSTRAINT "public_media_assets_master_version_check" CHECK ("normalized_master_object_version_id" is null or char_length("normalized_master_object_version_id") between 1 and 512),
	CONSTRAINT "public_media_assets_source_version_check" CHECK (("source_object_version_id" is null and "source_object_etag" is null) or ("source_object_version_id" is not null and "source_object_etag" is not null)),
	CONSTRAINT "public_media_assets_failure_check" CHECK (("failure_code" is null and "state" <> 'failed') or ("failure_code" is not null and "state" = 'failed')),
	CONSTRAINT "public_media_assets_failure_code_check" CHECK ("failure_code" is null or "failure_code" in ('failed_validation','unsupported_format','malformed_image','dimensions_exceeded','output_too_large','storage_error','processing_error','derivative_key_conflict')),
	CONSTRAINT "public_media_assets_ready_time_check" CHECK (("ready_at" is null and "state" not in ('ready','deleted')) or ("ready_at" is not null and "state" in ('ready','deleted') and "ready_at" >= "created_at")),
	CONSTRAINT "public_media_assets_source_cleanup_check" CHECK ("source_deleted_at" is null or "state" in ('ready','failed','deleted')),
	CONSTRAINT "public_media_assets_deletion_review_check" CHECK (("deletion_reviewed_at" is null and "state" <> 'deleted') or ("deletion_reviewed_at" is not null and "state" = 'deleted')),
	CONSTRAINT "public_media_assets_source_key_check" CHECK ("source_object_key" ~ '^quarantine/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
	CONSTRAINT "public_media_assets_timestamps_check" CHECK ("updated_at" >= "created_at")
);
--> statement-breakpoint
ALTER TABLE "public_media_assets" ADD CONSTRAINT "public_media_assets_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "public_media_assets_id_owner_purpose_format_uidx" ON "public_media_assets" USING btree ("id","owner_user_id","purpose","declared_source_format");
--> statement-breakpoint
CREATE INDEX "public_media_assets_owner_state_idx" ON "public_media_assets" USING btree ("owner_user_id","state","created_at");
--> statement-breakpoint
CREATE INDEX "public_media_assets_quota_idx" ON "public_media_assets" USING btree ("owner_user_id","state","source_deleted_at","source_allocation_bytes");
--> statement-breakpoint
CREATE INDEX "public_media_assets_cleanup_idx" ON "public_media_assets" USING btree ("state","source_deleted_at","updated_at");
--> statement-breakpoint
CREATE TABLE "public_media_upload_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"declared_source_format" text NOT NULL,
	"max_source_bytes" bigint NOT NULL,
	"max_source_pixels" bigint NOT NULL,
	"object_key" text NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_media_upload_intents_purpose_check" CHECK ("purpose" in ('avatar','cover','showcase')),
	CONSTRAINT "public_media_upload_intents_source_format_check" CHECK ("declared_source_format" in ('jpeg','png','webp')),
	CONSTRAINT "public_media_upload_intents_limits_check" CHECK ("max_source_bytes" between 1 and 10485760 and "max_source_pixels" between 1 and 40000000),
	CONSTRAINT "public_media_upload_intents_state_check" CHECK ("state" in ('issued','completed','expired')),
	CONSTRAINT "public_media_upload_intents_expiry_check" CHECK ("expires_at" = "created_at" + interval '15 minutes'),
	CONSTRAINT "public_media_upload_intents_completion_check" CHECK (("state" = 'completed' and "completed_at" is not null) or ("state" <> 'completed' and "completed_at" is null)),
	CONSTRAINT "public_media_upload_intents_object_key_check" CHECK ("object_key" ~ '^quarantine/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
	CONSTRAINT "public_media_upload_intents_timestamps_check" CHECK ("updated_at" >= "created_at")
);
--> statement-breakpoint
ALTER TABLE "public_media_upload_intents" ADD CONSTRAINT "public_media_upload_intents_asset_fk" FOREIGN KEY ("asset_id","owner_user_id","purpose","declared_source_format") REFERENCES "public_media_assets"("id","owner_user_id","purpose","declared_source_format") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public_media_upload_intents" ADD CONSTRAINT "public_media_upload_intents_asset_id_public_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public_media_assets"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public_media_upload_intents" ADD CONSTRAINT "public_media_upload_intents_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "public_media_upload_intents_asset_uidx" ON "public_media_upload_intents" USING btree ("asset_id");
--> statement-breakpoint
CREATE INDEX "public_media_upload_intents_owner_expiry_idx" ON "public_media_upload_intents" USING btree ("owner_user_id","expires_at");
--> statement-breakpoint
CREATE INDEX "public_media_upload_intents_expiry_idx" ON "public_media_upload_intents" USING btree ("state","expires_at");
--> statement-breakpoint
CREATE TABLE "public_media_derivatives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"format" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"object_key" text NOT NULL,
	"object_version_id" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_media_derivatives_variant_check" CHECK ("variant" in ('master','thumb','display','large')),
	CONSTRAINT "public_media_derivatives_format_check" CHECK ("format" = 'webp'),
	CONSTRAINT "public_media_derivatives_dimensions_check" CHECK ("width" between 1 and 4096 and "height" between 1 and 4096 and "width" * "height" <= 40000000),
	CONSTRAINT "public_media_derivatives_variant_dimensions_check" CHECK (("variant" = 'master' and "width" <= 4096 and "height" <= 4096) or ("variant" = 'thumb' and "width" <= 384 and "height" <= 384) or ("variant" = 'display' and "width" <= 1280 and "height" <= 1280) or ("variant" = 'large' and "width" <= 2400 and "height" <= 2400)),
	CONSTRAINT "public_media_derivatives_bytes_check" CHECK ("byte_size" between 1 and 10485760),
	CONSTRAINT "public_media_derivatives_hash_check" CHECK ("content_hash" ~ '^sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "public_media_derivatives_object_key_check" CHECK ("object_key" ~ '^derivatives/[0-9a-f-]{36}/(master|thumb|display|large)/[A-Za-z0-9_-]+[.]webp$'),
	CONSTRAINT "public_media_derivatives_object_version_check" CHECK (char_length("object_version_id") between 1 and 512),
	CONSTRAINT "public_media_derivatives_timestamps_check" CHECK ("updated_at" >= "created_at")
 );
--> statement-breakpoint
ALTER TABLE "public_media_derivatives" ADD CONSTRAINT "public_media_derivatives_asset_id_public_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public_media_assets"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "public_media_derivatives_asset_variant_uidx" ON "public_media_derivatives" USING btree ("asset_id","variant");
--> statement-breakpoint
CREATE INDEX "public_media_derivatives_asset_idx" ON "public_media_derivatives" USING btree ("asset_id","variant");
--> statement-breakpoint
CREATE INDEX "public_media_derivatives_cleanup_idx" ON "public_media_derivatives" USING btree ("asset_id","verified_at");
--> statement-breakpoint
CREATE TABLE "public_media_processing_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_id" text NOT NULL,
	"outcome_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_media_processing_attempts_number_check" CHECK ("attempt_number" between 1 and 8),
	CONSTRAINT "public_media_processing_attempts_worker_check" CHECK (char_length("worker_id") between 1 and 128),
	CONSTRAINT "public_media_processing_attempts_outcome_check" CHECK ("outcome_code" is null or "outcome_code" in ('started','succeeded','retryable','retryable_error','failed_validation','unsupported_format','malformed_image','dimensions_exceeded','output_too_large','storage_unavailable','storage_error','processing_error','derivative_key_conflict','failed')),
	CONSTRAINT "public_media_processing_attempts_completion_check" CHECK (("finished_at" is null and ("outcome_code" is null or "outcome_code" = 'started')) or ("finished_at" is not null and "outcome_code" is not null and "outcome_code" <> 'started')),
	CONSTRAINT "public_media_processing_attempts_retry_check" CHECK ("next_retry_at" is null or "outcome_code" in ('retryable','retryable_error')),
	CONSTRAINT "public_media_processing_attempts_time_check" CHECK (("updated_at" >= "created_at") and ("finished_at" is null or "finished_at" >= "started_at"))
 );
--> statement-breakpoint
ALTER TABLE "public_media_processing_attempts" ADD CONSTRAINT "public_media_processing_attempts_asset_id_public_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public_media_assets"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "public_media_processing_attempts_asset_number_uidx" ON "public_media_processing_attempts" USING btree ("asset_id","attempt_number");
--> statement-breakpoint
CREATE INDEX "public_media_processing_attempts_worker_idx" ON "public_media_processing_attempts" USING btree ("worker_id","started_at");
--> statement-breakpoint
CREATE INDEX "public_media_processing_attempts_asset_idx" ON "public_media_processing_attempts" USING btree ("asset_id","attempt_number");
--> statement-breakpoint
CREATE INDEX "public_media_processing_attempts_retry_idx" ON "public_media_processing_attempts" USING btree ("next_retry_at","finished_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public_media_guard_asset_lifecycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_upload' THEN
      RAISE EXCEPTION 'public media assets must start awaiting_upload' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.state IN ('failed', 'deleted') THEN
      IF NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'failed and deleted media assets are terminal' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.state = 'ready' AND NEW.state NOT IN ('ready', 'deleted') THEN
      RAISE EXCEPTION 'ready media assets may only be cleaned up to deleted' USING ERRCODE = '55000';
    ELSIF OLD.state = 'awaiting_upload' AND NEW.state NOT IN ('awaiting_upload', 'pending', 'failed') THEN
      RAISE EXCEPTION 'invalid awaiting_upload media transition' USING ERRCODE = '23514';
    ELSIF OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'processing', 'failed') THEN
      RAISE EXCEPTION 'invalid pending media transition' USING ERRCODE = '23514';
    ELSIF OLD.state = 'processing' AND NEW.state NOT IN ('processing', 'pending', 'ready', 'failed') THEN
      RAISE EXCEPTION 'invalid processing media transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'ready' AND NEW.state = 'deleted' AND NEW.deletion_reviewed_at IS NULL THEN
      RAISE EXCEPTION 'ready media cleanup requires review' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'ready' THEN
    IF NEW.normalized_master_object_key IS NULL
      OR NEW.normalized_master_object_version_id IS NULL
      OR NEW.width IS NULL
      OR NEW.height IS NULL
    THEN
      RAISE EXCEPTION 'ready media assets require a normalized master and dimensions' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM (VALUES ('master'), ('thumb'), ('display'), ('large')) required(variant)
      WHERE NOT EXISTS (
        SELECT 1 FROM public_media_derivatives d
        WHERE d.asset_id = NEW.id AND d.variant = required.variant AND d.verified_at IS NOT NULL
      )
    ) THEN
      RAISE EXCEPTION 'ready media assets require all four verified required derivatives' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER public_media_assets_lifecycle_guard
BEFORE INSERT OR UPDATE ON "public_media_assets"
FOR EACH ROW EXECUTE FUNCTION public_media_guard_asset_lifecycle();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public_media_guard_derivative_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE asset_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT state INTO asset_state FROM public_media_assets WHERE id = OLD.asset_id;
  ELSE
    SELECT state INTO asset_state FROM public_media_assets WHERE id = NEW.asset_id;
  END IF;
  IF asset_state IN ('ready', 'failed', 'deleted') THEN
    RAISE EXCEPTION 'derivatives cannot mutate after asset readiness or terminal failure' USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.variant IS DISTINCT FROM OLD.variant) THEN
    RAISE EXCEPTION 'derivative identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER public_media_derivatives_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON "public_media_derivatives"
FOR EACH ROW EXECUTE FUNCTION public_media_guard_derivative_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public_media_guard_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'media processing attempts are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'terminal media processing attempts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'media processing attempt identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER public_media_attempts_one_way_close
BEFORE UPDATE OR DELETE ON "public_media_processing_attempts"
FOR EACH ROW EXECUTE FUNCTION public_media_guard_attempt_mutation();
