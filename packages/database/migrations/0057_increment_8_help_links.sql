CREATE TABLE "trust_help_link_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"network_key_hmac" text NOT NULL,
	"address_hmac" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_help_link_requests_hmac_check" CHECK ("trust_help_link_requests"."address_hmac" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$' and "trust_help_link_requests"."network_key_hmac" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "trust_help_link_requests_outcome_check" CHECK ("trust_help_link_requests"."outcome" in ('issued','ignored','rate_limited')),
	CONSTRAINT "trust_help_link_requests_time_check" CHECK ("trust_help_link_requests"."expires_at" > "trust_help_link_requests"."created_at" and "trust_help_link_requests"."expires_at" <= "trust_help_link_requests"."created_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE "trust_help_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"penalty_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"appeal_until" timestamp with time zone NOT NULL,
	"read_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "trust_help_links_hash_check" CHECK ("trust_help_links"."token_hash" ~ '^sha256:v1:[a-f0-9]{64}$'),
	CONSTRAINT "trust_help_links_time_check" CHECK ("trust_help_links"."issued_at" < "trust_help_links"."read_until" and "trust_help_links"."appeal_until" < "trust_help_links"."read_until" and ("trust_help_links"."revoked_at" is null or "trust_help_links"."revoked_at" >= "trust_help_links"."issued_at"))
);
--> statement-breakpoint
CREATE TABLE "trust_help_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_hash" text NOT NULL,
	"link_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"penalty_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "trust_help_sessions_hash_check" CHECK ("trust_help_sessions"."session_hash" ~ '^sha256:v1:[a-f0-9]{64}$'),
	CONSTRAINT "trust_help_sessions_time_check" CHECK ("trust_help_sessions"."expires_at" = "trust_help_sessions"."created_at" + interval '30 minutes' and ("trust_help_sessions"."revoked_at" is null or "trust_help_sessions"."revoked_at" >= "trust_help_sessions"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "trust_help_links" ADD CONSTRAINT "trust_help_links_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_help_links" ADD CONSTRAINT "trust_help_links_penalty_id_trust_penalties_id_fk" FOREIGN KEY ("penalty_id") REFERENCES "trust_penalties"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_help_sessions" ADD CONSTRAINT "trust_help_sessions_link_id_trust_help_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "trust_help_links"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_help_sessions" ADD CONSTRAINT "trust_help_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "trust_help_sessions" ADD CONSTRAINT "trust_help_sessions_penalty_id_trust_penalties_id_fk" FOREIGN KEY ("penalty_id") REFERENCES "trust_penalties"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "trust_help_link_requests_address_idx" ON "trust_help_link_requests" USING btree ("address_hmac","created_at");--> statement-breakpoint
CREATE INDEX "trust_help_link_requests_network_idx" ON "trust_help_link_requests" USING btree ("network_key_hmac","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_help_links_token_uidx" ON "trust_help_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_help_links_active_penalty_uidx" ON "trust_help_links" USING btree ("penalty_id") WHERE "trust_help_links"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_help_sessions_hash_uidx" ON "trust_help_sessions" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "trust_help_sessions_link_idx" ON "trust_help_sessions" USING btree ("link_id");
--> statement-breakpoint
CREATE FUNCTION trust_help_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p trust_penalties%ROWTYPE;
BEGIN
  SELECT * INTO p FROM trust_penalties WHERE id = NEW.penalty_id;
  IF NOT FOUND OR NEW.user_id <> p.subject_user_id OR p.target <> 'account'
    OR p.kind NOT IN ('suspension', 'removal') OR NEW.issued_at < p.created_at
    OR NEW.appeal_until <> p.created_at + interval '14 days'
    OR NEW.read_until <> p.created_at + interval '90 days' THEN
    RAISE EXCEPTION 'Invalid help link binding' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'Invalid help link transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trust_help_link_guard_trigger BEFORE INSERT OR UPDATE ON trust_help_links
  FOR EACH ROW EXECUTE FUNCTION trust_help_link_guard();
--> statement-breakpoint
CREATE FUNCTION trust_help_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l trust_help_links%ROWTYPE;
BEGIN
  SELECT * INTO l FROM trust_help_links WHERE id = NEW.link_id;
  IF NOT FOUND OR NEW.user_id <> l.user_id OR NEW.penalty_id <> l.penalty_id OR NEW.created_at < l.issued_at
    OR NEW.created_at >= l.read_until OR (TG_OP = 'INSERT' AND l.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid help session binding' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'Invalid help session transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trust_help_session_guard_trigger BEFORE INSERT OR UPDATE ON trust_help_sessions
  FOR EACH ROW EXECUTE FUNCTION trust_help_session_guard();
