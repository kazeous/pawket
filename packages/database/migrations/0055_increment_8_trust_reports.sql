CREATE TABLE "trust_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_reference" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"order_id" uuid,
	"package_revision_id" uuid,
	"content_owner_user_id" text NOT NULL,
	"reporter_user_id" text,
	"reporter_network_hmac" text,
	"reason" text NOT NULL,
	"detail_envelope" jsonb,
	"case_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "trust_reports_reference_check" CHECK ("trust_reports"."report_reference" ~ '^report:v2:[A-Za-z0-9_-]{32}$'),
	CONSTRAINT "trust_reports_kind_check" CHECK ("trust_reports"."target_kind" in ('commission_package','commission_brief','commission_message','commission_file')),
	CONSTRAINT "trust_reports_target_check" CHECK (("trust_reports"."target_kind" = 'commission_package' and "trust_reports"."package_revision_id" is not null and "trust_reports"."order_id" is null)
    or ("trust_reports"."target_kind" <> 'commission_package' and "trust_reports"."package_revision_id" is null and "trust_reports"."order_id" is not null)),
	CONSTRAINT "trust_reports_reporter_check" CHECK (("trust_reports"."reporter_user_id" is not null) <> ("trust_reports"."reporter_network_hmac" is not null)),
	CONSTRAINT "trust_reports_network_check" CHECK ("trust_reports"."reporter_network_hmac" is null or ("trust_reports"."target_kind" = 'commission_package' and "trust_reports"."reporter_network_hmac" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$')),
	CONSTRAINT "trust_reports_owner_check" CHECK ("trust_reports"."reporter_user_id" is null or "trust_reports"."reporter_user_id" <> "trust_reports"."content_owner_user_id"),
	CONSTRAINT "trust_reports_reason_check" CHECK ("trust_reports"."reason" in ('impersonation','prohibited_or_age_restricted_content','harassment_or_hate','violence_or_self_harm','privacy','intellectual_property','spam_or_scam','other')),
	CONSTRAINT "trust_reports_detail_check" CHECK ("trust_reports"."detail_envelope" is null or coalesce(
  jsonb_typeof("trust_reports"."detail_envelope") = 'object' and octet_length("trust_reports"."detail_envelope"::text) <= 24000
  and "trust_reports"."detail_envelope"->'version' = '1'::jsonb and "trust_reports"."detail_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("trust_reports"."detail_envelope"->'keyId') = 'string' and "trust_reports"."detail_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "trust_reports"."detail_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "trust_reports"."detail_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "trust_reports"."detail_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "trust_reports"."detail_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "trust_reports_state_check" CHECK (("trust_reports"."state" = 'open' and "trust_reports"."closed_at" is null)
    or ("trust_reports"."state" = 'closed' and "trust_reports"."closed_at" is not null and "trust_reports"."closed_at" >= "trust_reports"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "trust_reports" ADD CONSTRAINT "trust_reports_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_reports" ADD CONSTRAINT "trust_reports_package_revision_id_commission_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "commission_package_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_reports" ADD CONSTRAINT "trust_reports_content_owner_user_id_identity_users_id_fk" FOREIGN KEY ("content_owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_reports" ADD CONSTRAINT "trust_reports_reporter_user_id_identity_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_reports" ADD CONSTRAINT "trust_reports_case_id_trust_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "trust_cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_reports_reference_uidx" ON "trust_reports" USING btree ("report_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_reports_actor_target_uidx" ON "trust_reports" USING btree ("target_kind","target_id","reporter_user_id") WHERE "trust_reports"."reporter_user_id" is not null;--> statement-breakpoint
CREATE INDEX "trust_reports_filed_idx" ON "trust_reports" USING btree ("reporter_user_id","created_at","id") WHERE "trust_reports"."reporter_user_id" is not null;--> statement-breakpoint
CREATE INDEX "trust_reports_case_idx" ON "trust_reports" USING btree ("case_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION trust_guard_report() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Trust reports cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Trust reports must start open' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trust_cases c WHERE c.id = NEW.case_id AND c.kind = 'report'
      AND c.state = 'open' AND c.source_type = NEW.target_kind AND c.source_id = NEW.target_id
      AND c.order_id IS NOT DISTINCT FROM NEW.order_id) THEN
      RAISE EXCEPTION 'Trust report case mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.target_kind = 'commission_package' AND NOT EXISTS (
      SELECT 1 FROM commission_package_revisions r WHERE r.id = NEW.package_revision_id AND r.package_id = NEW.target_id
        AND r.creator_user_id = NEW.content_owner_user_id) THEN
      RAISE EXCEPTION 'Trust report revision mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'closed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'closed_at'])
    OR OLD.state <> 'open' OR NEW.state <> 'closed' OR NEW.closed_at IS NULL OR NEW.closed_at < OLD.created_at THEN
    RAISE EXCEPTION 'Invalid trust report transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trust_reports_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_reports
FOR EACH ROW EXECUTE FUNCTION trust_guard_report();
