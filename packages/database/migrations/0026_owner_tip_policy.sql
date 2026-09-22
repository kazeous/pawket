-- Selected-schema binding supports both production and isolated upgrade tests.
CREATE FUNCTION platform_tip_policy_presets_valid(presets integer[], minimum bigint, maximum bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_ndims(presets) = 1 and array_lower(presets, 1) = 1
    and cardinality(presets) between 3 and 10
    and array_position(presets, null) is null
    and (SELECT count(distinct amount) FROM unnest(presets) amount) = cardinality(presets)
    and NOT EXISTS (SELECT 1 FROM unnest(presets) amount WHERE amount < minimum or amount > maximum), false)
$$;
--> statement-breakpoint
CREATE TABLE "platform_tip_policy_current" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_tip_policy_singleton_check" CHECK ("platform_tip_policy_current"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "platform_tip_policy_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_number" integer NOT NULL,
	"previous_revision_id" uuid,
	"minimum_vnd" bigint NOT NULL,
	"maximum_vnd" bigint NOT NULL,
	"allowed_presets_vnd" integer[] NOT NULL,
	"origin" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"request_id" text,
	"reason" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_tip_policy_bounds_check" CHECK ("platform_tip_policy_revisions"."minimum_vnd" >= 10000 and "platform_tip_policy_revisions"."maximum_vnd" <= 5000000 and "platform_tip_policy_revisions"."maximum_vnd" >= "platform_tip_policy_revisions"."minimum_vnd"),
	CONSTRAINT "platform_tip_policy_presets_check" CHECK (platform_tip_policy_presets_valid("platform_tip_policy_revisions"."allowed_presets_vnd", "platform_tip_policy_revisions"."minimum_vnd", "platform_tip_policy_revisions"."maximum_vnd")),
	CONSTRAINT "platform_tip_policy_origin_check" CHECK (("platform_tip_policy_revisions"."origin" = 'system_bootstrap' and "platform_tip_policy_revisions"."revision_number" = 1 and "platform_tip_policy_revisions"."previous_revision_id" is null and "platform_tip_policy_revisions"."actor_user_id" is null and "platform_tip_policy_revisions"."actor_session_id" is null and "platform_tip_policy_revisions"."request_id" is null)
    or ("platform_tip_policy_revisions"."origin" = 'owner' and "platform_tip_policy_revisions"."revision_number" > 1 and "platform_tip_policy_revisions"."previous_revision_id" is not null and "platform_tip_policy_revisions"."actor_user_id" is not null and "platform_tip_policy_revisions"."actor_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and "platform_tip_policy_revisions"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')),
	CONSTRAINT "platform_tip_policy_owner_evidence_check" CHECK ("platform_tip_policy_revisions"."origin" <> 'owner' or ("platform_tip_policy_revisions"."actor_session_id" is not null and "platform_tip_policy_revisions"."request_id" is not null)),
	CONSTRAINT "platform_tip_policy_reason_check" CHECK (char_length("platform_tip_policy_revisions"."reason") between 3 and 500 and "platform_tip_policy_revisions"."reason" = btrim("platform_tip_policy_revisions"."reason") and "platform_tip_policy_revisions"."reason" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "creator_tip_setting_revisions" ADD COLUMN "platform_policy_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "platform_policy_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_tip_policy_current" ADD CONSTRAINT "platform_tip_policy_current_revision_id_platform_tip_policy_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "platform_tip_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "platform_tip_policy_revisions" ADD CONSTRAINT "platform_tip_policy_revisions_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "platform_tip_policy_revisions" ADD CONSTRAINT "platform_tip_policy_previous_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "platform_tip_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_tip_policy_number_uidx" ON "platform_tip_policy_revisions" USING btree ("revision_number");--> statement-breakpoint
ALTER TABLE "creator_tip_setting_revisions" ADD CONSTRAINT "creator_tip_setting_revisions_platform_policy_revision_id_platform_tip_policy_revisions_id_fk" FOREIGN KEY ("platform_policy_revision_id") REFERENCES "platform_tip_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_platform_policy_revision_id_platform_tip_policy_revisions_id_fk" FOREIGN KEY ("platform_policy_revision_id") REFERENCES "platform_tip_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
-- Migration journal makes this bootstrap one-time. Legacy rows deliberately stay
-- NULL: the original env policy cannot be attributed to this database revision.
INSERT INTO platform_tip_policy_revisions (id, revision_number, minimum_vnd, maximum_vnd,
  allowed_presets_vnd, origin, reason, effective_at)
VALUES ('00000000-0000-4000-8000-000000000001', 1, 10000, 5000000,
  ARRAY[20000,50000,100000], 'system_bootstrap', 'Bootstrap approved launch policy', transaction_timestamp());
--> statement-breakpoint
INSERT INTO platform_tip_policy_current (singleton, revision_id, updated_at)
SELECT true, id, effective_at FROM platform_tip_policy_revisions WHERE revision_number = 1;
--> statement-breakpoint
CREATE TRIGGER platform_tip_policy_append_only BEFORE UPDATE OR DELETE ON platform_tip_policy_revisions
FOR EACH ROW EXECUTE FUNCTION increment_four_reject_fact_mutation();
--> statement-breakpoint
CREATE FUNCTION platform_tip_policy_guard_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE current_revision platform_tip_policy_revisions%ROWTYPE;
BEGIN
  SELECT revision.* INTO current_revision FROM platform_tip_policy_current pointer
    JOIN platform_tip_policy_revisions revision ON revision.id = pointer.revision_id
    WHERE pointer.singleton = true FOR SHARE OF pointer;
  IF current_revision.id IS NULL OR NEW.origin <> 'owner'
    OR NEW.previous_revision_id IS DISTINCT FROM current_revision.id
    OR NEW.revision_number <> current_revision.revision_number + 1
    OR NEW.effective_at < current_revision.effective_at THEN
    RAISE EXCEPTION 'platform tip policy must extend current revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER platform_tip_policy_revision_guard BEFORE INSERT ON platform_tip_policy_revisions
FOR EACH ROW EXECUTE FUNCTION platform_tip_policy_guard_revision();
--> statement-breakpoint
CREATE FUNCTION platform_tip_policy_guard_pointer() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE revision platform_tip_policy_revisions%ROWTYPE; old_number integer;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'platform tip policy pointer cannot be recreated or deleted' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO revision FROM platform_tip_policy_revisions WHERE id = NEW.revision_id;
  SELECT revision_number INTO old_number FROM platform_tip_policy_revisions WHERE id = OLD.revision_id;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR revision.previous_revision_id IS DISTINCT FROM OLD.revision_id
    OR revision.revision_number IS DISTINCT FROM old_number + 1
    OR NEW.updated_at IS DISTINCT FROM revision.effective_at OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'platform tip policy pointer must advance exactly once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER platform_tip_policy_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON platform_tip_policy_current
FOR EACH ROW EXECUTE FUNCTION platform_tip_policy_guard_pointer();
--> statement-breakpoint
-- A revision and its pointer advance are one aggregate change. Without this
-- deferred check a direct insert could leave an orphan occupying the next
-- revision number and prevent all future owner updates.
CREATE FUNCTION platform_tip_policy_guard_committed_pointer() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE pointer_id uuid; latest_id uuid;
BEGIN
  SELECT revision_id INTO pointer_id FROM platform_tip_policy_current
    WHERE singleton = true FOR SHARE;
  SELECT id INTO latest_id FROM platform_tip_policy_revisions
    ORDER BY revision_number DESC LIMIT 1;
  IF pointer_id IS NULL OR pointer_id IS DISTINCT FROM latest_id THEN
    RAISE EXCEPTION 'platform tip policy revision and pointer must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER platform_tip_policy_committed_pointer_guard
AFTER INSERT ON platform_tip_policy_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION platform_tip_policy_guard_committed_pointer();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER platform_tip_policy_committed_revision_guard
AFTER UPDATE ON platform_tip_policy_current DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION platform_tip_policy_guard_committed_pointer();
--> statement-breakpoint
CREATE FUNCTION platform_tip_policy_guard_new_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE policy platform_tip_policy_revisions%ROWTYPE;
BEGIN
  -- The shared lock is held until commit, including direct SQL callers. An old
  -- binary cannot insert unbound financial evidence after this migration.
  SELECT revision.* INTO policy FROM platform_tip_policy_current pointer
    JOIN platform_tip_policy_revisions revision ON revision.id = pointer.revision_id
    WHERE pointer.singleton = true FOR SHARE OF pointer;
  IF policy.id IS NULL OR NEW.platform_policy_revision_id IS DISTINCT FROM policy.id THEN
    RAISE EXCEPTION 'new tip evidence requires current platform policy' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'creator_tip_setting_revisions' THEN
    IF NEW.minimum_vnd <> policy.minimum_vnd OR NEW.maximum_vnd <> policy.maximum_vnd
      OR NOT (NEW.presets_vnd <@ policy.allowed_presets_vnd) THEN
      RAISE EXCEPTION 'creator presets must adopt current platform policy' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.amount_vnd < policy.minimum_vnd OR NEW.amount_vnd > policy.maximum_vnd THEN
      RAISE EXCEPTION 'new tip amount violates current platform policy' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_tip_platform_policy_guard BEFORE INSERT ON creator_tip_setting_revisions
FOR EACH ROW EXECUTE FUNCTION platform_tip_policy_guard_new_evidence();
--> statement-breakpoint
CREATE TRIGGER tips_platform_policy_guard BEFORE INSERT ON tips
FOR EACH ROW EXECUTE FUNCTION platform_tip_policy_guard_new_evidence();
