ALTER TABLE "system_retention_holds" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "system_retention_holds" ADD CONSTRAINT "system_retention_holds_dataset_subject_check" CHECK (("system_retention_holds"."dataset" = 'provisional_accounts' and "system_retention_holds"."subject_type" = 'user')
        or ("system_retention_holds"."dataset" = 'verifications' and "system_retention_holds"."subject_type" in ('user', 'verification'))
        or ("system_retention_holds"."dataset" = 'sessions' and "system_retention_holds"."subject_type" in ('user', 'session'))
        or ("system_retention_holds"."dataset" = 'security_throttles' and "system_retention_holds"."subject_type" = 'security_throttle')
        or ("system_retention_holds"."dataset" = 'receiving_accounts' and "system_retention_holds"."subject_type" in ('user', 'receiving_account'))
        or ("system_retention_holds"."dataset" = 'application_content' and "system_retention_holds"."subject_type" in ('user', 'creator_application')));--> statement-breakpoint
CREATE OR REPLACE FUNCTION system_guard_retention_hold_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'pawket.retention.' || CASE WHEN TG_OP = 'INSERT' THEN NEW.dataset ELSE OLD.dataset END,
      0
    )
  );

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retention hold records are append-only' USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD.id,
    OLD.dataset,
    OLD.subject_type,
    OLD.subject_id,
    OLD.reason_category,
    OLD.reference_id,
    OLD.starts_at,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.dataset,
    NEW.subject_type,
    NEW.subject_id,
    NEW.reason_category,
    NEW.reference_id,
    NEW.starts_at,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'retention hold records are append-only' USING ERRCODE = '55000';
  END IF;

  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'retention hold release is final' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER system_retention_holds_guard
BEFORE INSERT OR UPDATE OR DELETE ON system_retention_holds
FOR EACH ROW
EXECUTE FUNCTION system_guard_retention_hold_change();
