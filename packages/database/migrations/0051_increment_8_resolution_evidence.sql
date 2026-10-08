ALTER TABLE "commission_file_attachments" DROP CONSTRAINT "commission_file_attachment_target_check";--> statement-breakpoint
ALTER TABLE "commission_files" DROP CONSTRAINT "commission_files_context_check";--> statement-breakpoint
ALTER TABLE "commission_files" DROP CONSTRAINT "commission_files_type_check";--> statement-breakpoint
ALTER TABLE "commission_file_attachments" ADD CONSTRAINT "commission_file_attachment_target_check" CHECK (("commission_file_attachments"."target_kind" = 'brief' and "commission_file_attachments"."target_id" = "commission_file_attachments"."order_id" and "commission_file_attachments"."position" between 0 and 9)
    or ("commission_file_attachments"."target_kind" = 'message' and "commission_file_attachments"."position" between 0 and 9) or ("commission_file_attachments"."target_kind" = 'submission' and "commission_file_attachments"."position" between 0 and 19)
    or ("commission_file_attachments"."target_kind" in ('refund_send','late_claim') and "commission_file_attachments"."position" between 0 and 2));--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_context_check" CHECK (("commission_files"."context" = 'brief' and "commission_files"."package_id" is not null and "commission_files"."upload_order_id" is null)
    or ("commission_files"."context" in ('thread','submission','resolution_evidence') and "commission_files"."package_id" is null and "commission_files"."upload_order_id" is not null));--> statement-breakpoint
ALTER TABLE "commission_files" ADD CONSTRAINT "commission_files_type_check" CHECK ("commission_files"."detected_type" is null or "commission_files"."detected_type" in ('jpeg','png','webp','pdf')
    or ("commission_files"."context" <> 'resolution_evidence' and "commission_files"."detected_type" = 'gif')
    or ("commission_files"."context" = 'submission' and "commission_files"."detected_type" in ('psd','clip','zip')));
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
  ELSIF link.target_kind = 'refund_send' THEN
    IF file_row.context <> 'resolution_evidence' OR file_row.upload_order_id IS DISTINCT FROM link.order_id OR file_row.owner_user_id <> order_row.creator_user_id
      OR NOT EXISTS (SELECT 1 FROM commission_refund_sends s JOIN commission_refund_obligations o ON o.id = s.obligation_id
        WHERE s.id = link.target_id AND o.order_id = link.order_id AND s.actor_user_id = file_row.owner_user_id) THEN
      RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF link.target_kind = 'late_claim' THEN
    IF file_row.context <> 'resolution_evidence' OR file_row.upload_order_id IS DISTINCT FROM link.order_id OR file_row.owner_user_id <> order_row.buyer_user_id
      OR NOT EXISTS (SELECT 1 FROM commission_late_payment_claims c WHERE c.id = link.target_id AND c.order_id = link.order_id AND c.buyer_user_id = file_row.owner_user_id) THEN
      RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Commission file attachment mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
