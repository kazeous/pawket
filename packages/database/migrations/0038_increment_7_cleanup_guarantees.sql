ALTER TABLE "commission_files" DROP CONSTRAINT "commission_files_filename_check";--> statement-breakpoint
ALTER TABLE "commission_files" ALTER COLUMN "filename_envelope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_files" ADD COLUMN "clean_copy_intent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The migration transaction holds the table lock. Conservatively treat every previously
-- uploaded row as an ambiguous writer, including records whose old purge stamp was premature.
-- This one-time correction leaves all identity and scan evidence untouched.
ALTER TABLE commission_files DISABLE TRIGGER commission_files_guard;
--> statement-breakpoint
UPDATE commission_files SET
  clean_copy_intent = uploaded_at IS NOT NULL,
  clean_purged_at = CASE WHEN uploaded_at IS NOT NULL THEN NULL ELSE clean_purged_at END,
  filename_envelope = CASE WHEN order_id IS NULL AND state IN ('rejected','scan_failed','expired','discarded') THEN NULL ELSE filename_envelope END,
  version = version + 1
WHERE uploaded_at IS NOT NULL OR (order_id IS NULL AND state IN ('rejected','scan_failed','expired','discarded'));
--> statement-breakpoint
-- Flush the deferred attachment graph checks queued by backfill before ALTER TABLE.
-- Without this, upgrading a populated 0037 schema fails with pending trigger events.
SET CONSTRAINTS commission_files_graph IMMEDIATE;
--> statement-breakpoint
ALTER TABLE commission_files ENABLE TRIGGER commission_files_guard;
--> statement-breakpoint
SET CONSTRAINTS commission_files_graph DEFERRED;
--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_filename_check" CHECK (case when "commission_files"."order_id" is null and "commission_files"."state" in ('rejected','scan_failed','expired','discarded') then "commission_files"."filename_envelope" is null else coalesce(
  jsonb_typeof("commission_files"."filename_envelope") = 'object' and octet_length("commission_files"."filename_envelope"::text) <= 24000
  and "commission_files"."filename_envelope"->'version' = '1'::jsonb and "commission_files"."filename_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_files"."filename_envelope"->'keyId') = 'string' and "commission_files"."filename_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_files"."filename_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_files"."filename_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_files"."filename_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_files"."filename_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false) end);
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
    OR NEW.declared_bytes <> OLD.declared_bytes OR NEW.object_key <> OLD.object_key
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
