-- A cancelled copy cannot complete 24 hours later, because S3 calls are capped at 60 s (Stage A fix wave).
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
    OR (NEW.clean_copy_intent AND OLD.clean_purged_at IS NULL AND NEW.clean_purged_at IS NOT NULL
      AND NOT (NEW.state IN ('rejected','scan_failed','expired','discarded','deleted')
        AND NEW.ended_at <= NEW.updated_at - interval '24 hours')) THEN
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
