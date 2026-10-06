CREATE TABLE "commission_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"author_session_id" text NOT NULL,
	"text_envelope" jsonb,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_messages_text_check" CHECK ("commission_messages"."text_envelope" is null or coalesce(
  jsonb_typeof("commission_messages"."text_envelope") = 'object' and octet_length("commission_messages"."text_envelope"::text) <= 24000
  and "commission_messages"."text_envelope"->'version' = '1'::jsonb and "commission_messages"."text_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_messages"."text_envelope"->'keyId') = 'string' and "commission_messages"."text_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_messages"."text_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_messages"."text_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_messages"."text_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_messages"."text_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))
);
--> statement-breakpoint
CREATE TABLE "commission_thread_entries" (
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_thread_entries_order_id_sequence_pk" PRIMARY KEY("order_id","sequence"),
	CONSTRAINT "commission_thread_entries_check" CHECK ("commission_thread_entries"."kind" in ('message','submission') and "commission_thread_entries"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "commission_threads" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_threads_sequence_check" CHECK ("commission_threads"."next_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "commission_file_attachments" DROP CONSTRAINT "commission_file_attachment_position_check";--> statement-breakpoint
ALTER TABLE "commission_file_attachments" DROP CONSTRAINT "commission_file_attachment_target_check";--> statement-breakpoint
ALTER TABLE "commission_files" DROP CONSTRAINT "commission_files_context_check";--> statement-breakpoint
ALTER TABLE "commission_files" DROP CONSTRAINT "commission_files_size_check";--> statement-breakpoint
ALTER TABLE "commission_files" DROP CONSTRAINT "commission_files_type_check";--> statement-breakpoint
ALTER TABLE "commission_files" ADD COLUMN "upload_order_id" uuid;--> statement-breakpoint
ALTER TABLE "commission_messages" ADD CONSTRAINT "commission_messages_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_messages" ADD CONSTRAINT "commission_messages_author_user_id_identity_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_thread_entries" ADD CONSTRAINT "commission_thread_entries_order_id_commission_threads_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_threads"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_threads" ADD CONSTRAINT "commission_threads_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_thread_entries_entry_uidx" ON "commission_thread_entries" USING btree ("kind","entry_id");--> statement-breakpoint
CREATE INDEX "commission_thread_entries_order_idx" ON "commission_thread_entries" USING btree ("order_id","sequence" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_upload_order_id_commission_orders_id_fk" FOREIGN KEY ("upload_order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_files_upload_order_idx" ON "commission_files" USING btree ("upload_order_id","state") WHERE "commission_files"."upload_order_id" is not null;--> statement-breakpoint
ALTER TABLE "commission_file_attachments" ADD CONSTRAINT "commission_file_attachment_target_check" CHECK (("commission_file_attachments"."target_kind" = 'brief' and "commission_file_attachments"."target_id" = "commission_file_attachments"."order_id" and "commission_file_attachments"."position" between 0 and 9)
    or ("commission_file_attachments"."target_kind" = 'message' and "commission_file_attachments"."position" between 0 and 9) or ("commission_file_attachments"."target_kind" = 'submission' and "commission_file_attachments"."position" between 0 and 19));--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_context_check" CHECK (("commission_files"."context" = 'brief' and "commission_files"."package_id" is not null and "commission_files"."upload_order_id" is null)
    or ("commission_files"."context" in ('thread','submission') and "commission_files"."package_id" is null and "commission_files"."upload_order_id" is not null));--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_size_check" CHECK ("commission_files"."declared_bytes" between 1 and case when "commission_files"."context" = 'submission' then 262144000 else 26214400 end);--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_type_check" CHECK ("commission_files"."detected_type" is null or "commission_files"."detected_type" in ('jpeg','png','webp','gif','pdf')
    or ("commission_files"."context" = 'submission' and "commission_files"."detected_type" in ('psd','clip','zip')));
--> statement-breakpoint
CREATE FUNCTION commission_order_file_bytes(order_id uuid) RETURNS bigint
LANGUAGE sql SET search_path FROM CURRENT AS $$
  SELECT coalesce(sum(f.declared_bytes), 0)::bigint FROM commission_files f
  WHERE coalesce(f.order_id, f.upload_order_id) = $1
    AND NOT (f.state IN ('rejected','scan_failed','expired','discarded','deleted')
      AND f.quarantine_purged_at IS NOT NULL AND f.clean_purged_at IS NOT NULL AND NOT f.clean_copy_intent);
$$;
--> statement-breakpoint
CREATE FUNCTION commission_guard_file_quota() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('commission-files:order:' || NEW.upload_order_id, 0));
  IF commission_order_file_bytes(NEW.upload_order_id) + NEW.declared_bytes > 1073741824 THEN
    RAISE EXCEPTION 'Commission order file quota exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION commission_guard_message() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE order_row commission_orders%ROWTYPE;
BEGIN
  SELECT * INTO order_row FROM commission_orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid commission message order' USING ERRCODE = '23514'; END IF;
  PERFORM commission_try_creator_fence(order_row.creator_user_id);
  IF NEW.author_user_id NOT IN (order_row.buyer_user_id, order_row.creator_user_id) OR order_row.state NOT IN ('in_progress','delivered') THEN
    RAISE EXCEPTION 'Commission message author/state mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION commission_check_message() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (SELECT count(*) FROM commission_thread_entries WHERE kind = 'message' AND entry_id = NEW.id AND order_id = NEW.order_id) <> 1 THEN
    RAISE EXCEPTION 'Commission message thread entry mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.text_envelope IS NULL AND NOT EXISTS (SELECT 1 FROM commission_file_attachments WHERE target_kind = 'message' AND target_id = NEW.id AND order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'Commission message needs text or an attachment' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION commission_check_thread_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commission_threads WHERE order_id = NEW.order_id AND next_sequence > NEW.sequence)
    OR (NEW.kind = 'message' AND NOT EXISTS (SELECT 1 FROM commission_messages WHERE id = NEW.entry_id AND order_id = NEW.order_id))
    OR (NEW.kind = 'submission' AND NOT EXISTS (SELECT 1 FROM commission_submissions WHERE id = NEW.entry_id AND order_id = NEW.order_id)) THEN
    RAISE EXCEPTION 'Commission thread entry mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION commission_guard_thread() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission threads cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF NEW.order_id <> OLD.order_id OR NEW.created_at <> OLD.created_at OR NEW.next_sequence <> OLD.next_sequence + 1 THEN
    RAISE EXCEPTION 'Commission thread sequence/identity mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_guard_file() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission files cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_upload' OR NEW.version <> 1 OR NEW.scan_attempts <> 0 OR NEW.order_id IS NOT NULL OR NEW.clean_copy_intent THEN
      RAISE EXCEPTION 'Invalid initial commission file' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.filename_envelope IS DISTINCT FROM OLD.filename_envelope
    AND NOT (NEW.filename_envelope IS NULL AND NEW.order_id IS NULL AND NEW.state IN ('rejected','scan_failed','expired','discarded')) THEN
    RAISE EXCEPTION 'Commission file filename cannot be changed or restored' USING ERRCODE = '23514';
  END IF;
  IF NEW.order_id IS NULL AND NEW.state IN ('rejected','scan_failed','expired','discarded') THEN
    NEW.filename_envelope := NULL;
  END IF;
  IF (OLD.clean_copy_intent AND NOT NEW.clean_copy_intent)
    OR (NOT OLD.clean_copy_intent AND NEW.clean_copy_intent AND (NEW.state <> 'scanning' OR NEW.clean_purged_at IS NOT NULL))
    OR (NEW.clean_copy_intent AND OLD.clean_purged_at IS NULL AND NEW.clean_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Commission file copy intent requires ongoing cleanup' USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_user_id <> OLD.owner_user_id OR NEW.context <> OLD.context OR NEW.package_id IS DISTINCT FROM OLD.package_id
    OR NEW.upload_order_id IS DISTINCT FROM OLD.upload_order_id
    OR NEW.declared_bytes <> OLD.declared_bytes OR NEW.object_key <> OLD.object_key
    OR NEW.request_id <> OLD.request_id OR NEW.created_at <> OLD.created_at OR NEW.upload_expires_at <> OLD.upload_expires_at
    OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Commission file identity/version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'Commission file order binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.context <> 'brief' AND NEW.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM NEW.upload_order_id THEN
    RAISE EXCEPTION 'Commission file order binding must match upload order' USING ERRCODE = '23514';
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
CREATE OR REPLACE FUNCTION commission_check_file_attachment() RETURNS trigger
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
    OR file_row.attached_at IS DISTINCT FROM link.attached_at OR order_row.id IS NULL THEN
    RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
  END IF;
  IF link.target_kind = 'brief' THEN
    IF file_row.context <> 'brief' OR file_row.owner_user_id <> order_row.buyer_user_id OR file_row.package_id <> order_row.package_id THEN
      RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF link.target_kind = 'message' THEN
    IF file_row.context <> 'thread' OR file_row.upload_order_id IS DISTINCT FROM link.order_id
      OR NOT EXISTS (SELECT 1 FROM commission_messages m WHERE m.id = link.target_id AND m.order_id = link.order_id AND m.author_user_id = file_row.owner_user_id) THEN
      RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF link.target_kind = 'submission' THEN
    IF file_row.context <> 'submission' OR file_row.upload_order_id IS DISTINCT FROM link.order_id OR file_row.owner_user_id <> order_row.creator_user_id
      OR NOT EXISTS (SELECT 1 FROM commission_submissions s WHERE s.id = link.target_id AND s.order_id = link.order_id) THEN
      RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_files_quota BEFORE INSERT ON commission_files
FOR EACH ROW WHEN (NEW.upload_order_id IS NOT NULL) EXECUTE FUNCTION commission_guard_file_quota();
--> statement-breakpoint
CREATE TRIGGER commission_messages_guard BEFORE INSERT ON commission_messages
FOR EACH ROW EXECUTE FUNCTION commission_guard_message();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_messages_graph AFTER INSERT ON commission_messages
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commission_check_message();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commission_thread_entries_graph AFTER INSERT ON commission_thread_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commission_check_thread_entry();
--> statement-breakpoint
CREATE TRIGGER commission_threads_guard BEFORE UPDATE OR DELETE ON commission_threads
FOR EACH ROW EXECUTE FUNCTION commission_guard_thread();
--> statement-breakpoint
CREATE TRIGGER commission_messages_immutable BEFORE UPDATE OR DELETE ON commission_messages
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_thread_entries_immutable BEFORE UPDATE OR DELETE ON commission_thread_entries
FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation();
