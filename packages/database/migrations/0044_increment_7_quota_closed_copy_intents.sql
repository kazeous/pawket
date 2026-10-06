-- Closed terminal copy-intent rows retain clean_copy_intent = true because the guard forbids clearing it.
-- Before 0043 they could not have clean_purged_at set; closure means the copy can no longer land.
-- Both purge timestamps therefore release their bytes from the order quota, regardless of the retained intent.
CREATE OR REPLACE FUNCTION commission_order_file_bytes(order_id uuid) RETURNS bigint
LANGUAGE sql SET search_path FROM CURRENT AS $$
  SELECT coalesce(sum(f.declared_bytes), 0)::bigint FROM commission_files f
  WHERE coalesce(f.order_id, f.upload_order_id) = $1
    AND NOT (f.state IN ('rejected','scan_failed','expired','discarded','deleted')
      AND f.quarantine_purged_at IS NOT NULL AND f.clean_purged_at IS NOT NULL);
$$;
