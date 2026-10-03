CREATE TABLE "commission_file_attachments" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"attached_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_file_attachment_target_check" CHECK ("commission_file_attachments"."target_kind" = 'brief' and "commission_file_attachments"."target_id" = "commission_file_attachments"."order_id"),
	CONSTRAINT "commission_file_attachment_position_check" CHECK ("commission_file_attachments"."position" between 0 and 9)
);
--> statement-breakpoint
CREATE TABLE "commission_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"context" text NOT NULL,
	"package_id" uuid,
	"order_id" uuid,
	"state" text DEFAULT 'awaiting_upload' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"filename_envelope" jsonb NOT NULL,
	"object_key" text NOT NULL,
	"quarantine_version_id" text,
	"clean_version_id" text,
	"detected_type" text,
	"sha256" text,
	"rejection_reason" text,
	"malware_signature" text,
	"scan_attempts" integer DEFAULT 0 NOT NULL,
	"next_scan_at" timestamp with time zone,
	"scan_lease_expires_at" timestamp with time zone,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone,
	"scan_deadline_at" timestamp with time zone,
	"clean_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"quarantine_purged_at" timestamp with time zone,
	"clean_purged_at" timestamp with time zone,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_files_context_check" CHECK ("commission_files"."context" = 'brief' and "commission_files"."package_id" is not null),
	CONSTRAINT "commission_files_state_check" CHECK ("commission_files"."state" in ('awaiting_upload','scanning','clean','attached','rejected','scan_failed','expired','discarded','deleted') and "commission_files"."version" > 0 and "commission_files"."scan_attempts" between 0 and 1000),
	CONSTRAINT "commission_files_order_check" CHECK (("commission_files"."state" in ('attached','deleted')) = ("commission_files"."order_id" is not null and "commission_files"."attached_at" is not null)),
	CONSTRAINT "commission_files_size_check" CHECK ("commission_files"."declared_bytes" between 1 and 26214400),
	CONSTRAINT "commission_files_key_check" CHECK ("commission_files"."object_key" = 'commission/' || "commission_files"."id"::text),
	CONSTRAINT "commission_files_filename_check" CHECK (coalesce(
  jsonb_typeof("commission_files"."filename_envelope") = 'object' and octet_length("commission_files"."filename_envelope"::text) <= 24000
  and "commission_files"."filename_envelope"->'version' = '1'::jsonb and "commission_files"."filename_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_files"."filename_envelope"->'keyId') = 'string' and "commission_files"."filename_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_files"."filename_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_files"."filename_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_files"."filename_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_files"."filename_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_files_type_check" CHECK ("commission_files"."detected_type" is null or "commission_files"."detected_type" in ('jpeg','png','webp','gif','pdf')),
	CONSTRAINT "commission_files_digest_check" CHECK ("commission_files"."sha256" is null or "commission_files"."sha256" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "commission_files_clean_evidence_check" CHECK (("commission_files"."state" not in ('clean','attached','deleted') or ("commission_files"."sha256" is not null and "commission_files"."detected_type" is not null and "commission_files"."clean_version_id" is not null and "commission_files"."clean_at" is not null))
    and ("commission_files"."state" not in ('awaiting_upload','scanning') or ("commission_files"."sha256" is null and "commission_files"."detected_type" is null and "commission_files"."clean_version_id" is null and "commission_files"."clean_at" is null))),
	CONSTRAINT "commission_files_rejection_check" CHECK (("commission_files"."state" = 'rejected') = ("commission_files"."rejection_reason" is not null)
    and ("commission_files"."rejection_reason" is null or "commission_files"."rejection_reason" in ('malware','type_not_allowed','size_mismatch','encrypted_archive','limits_exceeded'))
    and coalesce("commission_files"."rejection_reason" = 'malware', false) = ("commission_files"."malware_signature" is not null)
    and ("commission_files"."malware_signature" is null or "commission_files"."malware_signature" ~ '^[A-Za-z0-9._:-]{1,200}$')),
	CONSTRAINT "commission_files_upload_time_check" CHECK (("commission_files"."state" not in ('awaiting_upload','expired') or "commission_files"."uploaded_at" is null)
    and ("commission_files"."state" not in ('scanning','clean','attached','rejected','scan_failed','deleted') or "commission_files"."uploaded_at" is not null)
    and ("commission_files"."uploaded_at" is null) = ("commission_files"."scan_deadline_at" is null)
    and ("commission_files"."uploaded_at" is null or ("commission_files"."uploaded_at" >= "commission_files"."created_at" and "commission_files"."scan_deadline_at" = "commission_files"."uploaded_at" + interval '24 hours'))
    and "commission_files"."upload_expires_at" = "commission_files"."created_at" + interval '15 minutes'),
	CONSTRAINT "commission_files_end_check" CHECK (("commission_files"."state" in ('rejected','scan_failed','expired','discarded','deleted')) = ("commission_files"."ended_at" is not null)),
	CONSTRAINT "commission_files_lease_check" CHECK (("commission_files"."scan_lease_expires_at" is null or "commission_files"."state" = 'scanning') and ("commission_files"."next_scan_at" is null or "commission_files"."state" = 'scanning')),
	CONSTRAINT "commission_files_time_check" CHECK ("commission_files"."updated_at" >= "commission_files"."created_at" and char_length("commission_files"."request_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "commission_file_attachments" ADD CONSTRAINT "commission_file_attachments_file_id_commission_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "commission_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_file_attachments" ADD CONSTRAINT "commission_file_attachments_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_package_id_commission_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "commission_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_file_attachment_position_uidx" ON "commission_file_attachments" USING btree ("target_kind","target_id","position");--> statement-breakpoint
CREATE INDEX "commission_file_attachment_order_idx" ON "commission_file_attachments" USING btree ("order_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "commission_files_owner_state_idx" ON "commission_files" USING btree ("owner_user_id","state","created_at");--> statement-breakpoint
CREATE INDEX "commission_files_order_idx" ON "commission_files" USING btree ("order_id","state");--> statement-breakpoint
CREATE INDEX "commission_files_scan_due_idx" ON "commission_files" USING btree ("next_scan_at","id") WHERE "commission_files"."state" = 'scanning';--> statement-breakpoint
CREATE INDEX "commission_files_upload_expiry_idx" ON "commission_files" USING btree ("upload_expires_at","id") WHERE "commission_files"."state" = 'awaiting_upload';--> statement-breakpoint
CREATE INDEX "commission_files_unsent_idx" ON "commission_files" USING btree ("clean_at","id") WHERE "commission_files"."state" = 'clean';--> statement-breakpoint
CREATE INDEX "commission_files_purge_idx" ON "commission_files" USING btree ("updated_at","id") WHERE "commission_files"."state" in ('rejected','scan_failed','expired','discarded','deleted','clean','attached') and ("commission_files"."quarantine_purged_at" is null or ("commission_files"."clean_purged_at" is null and "commission_files"."state" in ('rejected','scan_failed','expired','discarded','deleted')));
--> statement-breakpoint
CREATE TRIGGER commission_file_attachments_immutable BEFORE UPDATE OR DELETE ON commission_file_attachments
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE FUNCTION commission_guard_file() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission files cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_upload' OR NEW.version <> 1 OR NEW.scan_attempts <> 0 OR NEW.order_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial commission file' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_user_id <> OLD.owner_user_id OR NEW.context <> OLD.context OR NEW.package_id IS DISTINCT FROM OLD.package_id
    OR NEW.declared_bytes <> OLD.declared_bytes OR NEW.filename_envelope <> OLD.filename_envelope OR NEW.object_key <> OLD.object_key
    OR NEW.request_id <> OLD.request_id OR NEW.created_at <> OLD.created_at OR NEW.upload_expires_at <> OLD.upload_expires_at
    OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Commission file identity/version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'Commission file order binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.sha256 IS NOT NULL AND (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.detected_type IS DISTINCT FROM OLD.detected_type
    OR NEW.clean_version_id IS DISTINCT FROM OLD.clean_version_id OR NEW.clean_at IS DISTINCT FROM OLD.clean_at) THEN
    RAISE EXCEPTION 'Commission file scan evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.quarantine_purged_at IS NOT NULL AND NEW.quarantine_purged_at IS DISTINCT FROM OLD.quarantine_purged_at
    OR OLD.clean_purged_at IS NOT NULL AND NEW.clean_purged_at IS DISTINCT FROM OLD.clean_purged_at THEN
    RAISE EXCEPTION 'Commission file purge facts are immutable' USING ERRCODE = '23514';
  END IF;
  allowed := CASE OLD.state
    WHEN 'awaiting_upload' THEN NEW.state IN ('scanning','expired','discarded')
    WHEN 'scanning' THEN NEW.state IN ('scanning','clean','rejected','scan_failed','discarded')
    WHEN 'clean' THEN NEW.state IN ('clean','attached','discarded')
    WHEN 'attached' THEN NEW.state IN ('attached','deleted')
    ELSE NEW.state = OLD.state
  END;
  IF NOT coalesce(allowed, false) THEN RAISE EXCEPTION 'Forbidden commission file transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_files_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_files
FOR EACH ROW EXECUTE FUNCTION commission_guard_file();
--> statement-breakpoint
CREATE FUNCTION commission_check_file_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE file_row commission_files%ROWTYPE; order_row commission_orders%ROWTYPE; link commission_file_attachments%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'commission_file_attachments' THEN
    SELECT * INTO file_row FROM commission_files WHERE id = NEW.file_id;
    link := NEW;
  ELSE
    IF NEW.state NOT IN ('attached','deleted') THEN RETURN NULL; END IF;
    file_row := NEW;
    SELECT * INTO link FROM commission_file_attachments WHERE file_id = NEW.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Attached commission file has no attachment' USING ERRCODE = '23514'; END IF;
  END IF;
  SELECT * INTO order_row FROM commission_orders WHERE id = link.order_id;
  IF file_row.id IS NULL OR file_row.state NOT IN ('attached','deleted') OR file_row.order_id IS DISTINCT FROM link.order_id
    OR file_row.attached_at IS DISTINCT FROM link.attached_at OR order_row.id IS NULL
    OR file_row.owner_user_id <> order_row.buyer_user_id OR file_row.package_id <> order_row.package_id THEN
    RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_file_attachments_graph AFTER INSERT ON commission_file_attachments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commission_check_file_attachment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_files_graph AFTER UPDATE ON commission_files
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commission_check_file_attachment();
