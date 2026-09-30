CREATE TABLE "identity_oidc_cutover" (
	"id" integer PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"provider_revision" text NOT NULL,
	"application_revision" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"operator_reference" text NOT NULL,
	"acceptance_reference" text NOT NULL,
	"backup_reference" text NOT NULL,
	"recovery_reference" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"rollback_until" timestamp with time zone NOT NULL,
	"backup_retained_until" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_oidc_cutover_singleton_check" CHECK ("identity_oidc_cutover"."id" = 1),
	CONSTRAINT "identity_oidc_cutover_window_check" CHECK ("identity_oidc_cutover"."rollback_until" > "identity_oidc_cutover"."activated_at" and "identity_oidc_cutover"."backup_retained_until" >= "identity_oidc_cutover"."rollback_until")
);
--> statement-breakpoint
ALTER TABLE "identity_oidc_cutover" ADD CONSTRAINT "identity_oidc_cutover_owner_user_id_identity_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION pawket_enforce_oidc_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_oidc_cutover WHERE id = 1)
     AND EXISTS (SELECT 1 FROM identity_sessions s WHERE s.id = NEW.id AND s.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM identity_oidc_sessions o JOIN identity_accounts a ON a.id = o.account_id
         JOIN identity_oidc_cutover c ON c.id = 1 AND c.issuer = a.issuer AND c.client_id = o.client_id
         WHERE o.session_id = s.id AND o.user_id = s.user_id AND a.user_id = s.user_id AND a.provider_id = 'authentik')) THEN
    RAISE EXCEPTION 'AUTH_MOVED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER identity_oidc_session_cutover_guard AFTER INSERT OR UPDATE ON identity_sessions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pawket_enforce_oidc_session();
--> statement-breakpoint
CREATE FUNCTION pawket_reject_legacy_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_oidc_cutover WHERE id = 1) THEN
    RAISE EXCEPTION 'AUTH_MOVED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER identity_verification_cutover_guard BEFORE INSERT ON identity_verifications
FOR EACH ROW EXECUTE FUNCTION pawket_reject_legacy_challenge();
--> statement-breakpoint
CREATE TRIGGER identity_external_link_cutover_guard BEFORE INSERT ON identity_external_link_transactions
FOR EACH ROW EXECUTE FUNCTION pawket_reject_legacy_challenge();
--> statement-breakpoint
CREATE FUNCTION pawket_preserve_oidc_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OIDC_CUTOVER_IMMUTABLE' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER identity_oidc_cutover_immutable BEFORE UPDATE OR DELETE ON identity_oidc_cutover
FOR EACH ROW EXECUTE FUNCTION pawket_preserve_oidc_cutover();
