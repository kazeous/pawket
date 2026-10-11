CREATE TABLE "trust_content_hides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"order_id" uuid,
	"content_owner_user_id" text NOT NULL,
	"hidden_at" timestamp with time zone NOT NULL,
	"hidden_by_user_id" text NOT NULL,
	"hidden_by_session_id" text NOT NULL,
	"reason_envelope" jsonb NOT NULL,
	"request_id" text NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" text,
	"release_kind" text,
	"release_request_id" text,
	CONSTRAINT "trust_content_hides_kind_check" CHECK ("trust_content_hides"."target_kind" in ('commission_message','commission_file','commission_package')),
	CONSTRAINT "trust_content_hides_order_check" CHECK (("trust_content_hides"."target_kind" = 'commission_package') = ("trust_content_hides"."order_id" is null)),
	CONSTRAINT "trust_content_hides_reason_check" CHECK (coalesce(
  jsonb_typeof("trust_content_hides"."reason_envelope") = 'object' and octet_length("trust_content_hides"."reason_envelope"::text) <= 24000
  and "trust_content_hides"."reason_envelope"->'version' = '1'::jsonb and "trust_content_hides"."reason_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_content_hides"."reason_envelope"->'keyId') = 'string' and "trust_content_hides"."reason_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_content_hides"."reason_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_content_hides"."reason_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_content_hides"."reason_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_content_hides"."reason_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "trust_content_hides_release_check" CHECK (("trust_content_hides"."released_at" is null and "trust_content_hides"."released_by_user_id" is null and "trust_content_hides"."release_kind" is null and "trust_content_hides"."release_request_id" is null)
    or ("trust_content_hides"."released_at" is not null and "trust_content_hides"."released_at" >= "trust_content_hides"."hidden_at" and "trust_content_hides"."release_request_id" is not null
      and (("trust_content_hides"."release_kind" = 'owner_restore' and "trust_content_hides"."released_by_user_id" is not null) or ("trust_content_hides"."release_kind" = 'appeal_reversed' and "trust_content_hides"."released_by_user_id" is null))))
);
--> statement-breakpoint
ALTER TABLE "trust_content_hides" ADD CONSTRAINT "trust_content_hides_case_id_trust_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "trust_cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_content_hides" ADD CONSTRAINT "trust_content_hides_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_content_hides" ADD CONSTRAINT "trust_content_hides_content_owner_user_id_identity_users_id_fk" FOREIGN KEY ("content_owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_content_hides" ADD CONSTRAINT "trust_content_hides_hidden_by_user_id_identity_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_content_hides" ADD CONSTRAINT "trust_content_hides_released_by_user_id_identity_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_content_hides_active_uidx" ON "trust_content_hides" USING btree ("target_kind","target_id") WHERE "trust_content_hides"."released_at" is null;--> statement-breakpoint
CREATE INDEX "trust_content_hides_case_idx" ON "trust_content_hides" USING btree ("case_id","hidden_at","id");
--> statement-breakpoint
CREATE FUNCTION trust_guard_content_hide() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Trust content hides cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.release_kind IS NOT NULL OR NEW.released_by_user_id IS NOT NULL OR NEW.release_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Trust content hides must start active' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trust_cases c JOIN trust_reports r ON r.case_id = c.id
      WHERE c.id = NEW.case_id AND c.kind = 'report' AND c.state = 'open'
        AND c.source_type = NEW.target_kind AND c.source_id = NEW.target_id AND c.order_id IS NOT DISTINCT FROM NEW.order_id
        AND r.target_kind = NEW.target_kind AND r.target_id = NEW.target_id AND r.content_owner_user_id = NEW.content_owner_user_id)
      OR (NEW.target_kind = 'commission_package' AND NOT EXISTS (SELECT 1 FROM commission_packages p WHERE p.id = NEW.target_id AND p.creator_user_id = NEW.content_owner_user_id))
      OR (NEW.target_kind = 'commission_message' AND NOT EXISTS (SELECT 1 FROM commission_messages m WHERE m.id = NEW.target_id AND m.order_id = NEW.order_id AND m.author_user_id = NEW.content_owner_user_id))
      OR (NEW.target_kind = 'commission_file' AND NOT EXISTS (SELECT 1 FROM commission_files f JOIN commission_file_attachments a ON a.file_id = f.id AND a.order_id = f.order_id
        WHERE f.id = NEW.target_id AND f.order_id = NEW.order_id AND f.owner_user_id = NEW.content_owner_user_id AND f.context IN ('thread','submission') AND a.target_kind IN ('message','submission'))) THEN
      RAISE EXCEPTION 'Trust content hide case or target mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['released_at','released_by_user_id','release_kind','release_request_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','released_by_user_id','release_kind','release_request_id'])
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.released_at < OLD.hidden_at
    OR NEW.release_kind IS NULL OR NEW.release_request_id IS NULL
    OR NEW.release_kind NOT IN ('owner_restore','appeal_reversed')
    OR (NEW.release_kind = 'owner_restore' AND NEW.released_by_user_id IS NULL)
    OR (NEW.release_kind = 'appeal_reversed' AND NEW.released_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid trust content hide release' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_content_hides_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_content_hides
FOR EACH ROW EXECUTE FUNCTION trust_guard_content_hide();
