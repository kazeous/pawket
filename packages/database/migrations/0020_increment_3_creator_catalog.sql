CREATE TABLE "creator_discovery_projections" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"canonical_handle" text NOT NULL,
	"display_name" text NOT NULL,
	"short_introduction" text NOT NULL,
	"disciplines" text[] NOT NULL,
	"avatar_thumb_derivative_id" uuid,
	"revision_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "creator_discovery_projections_canonical_handle_check" CHECK (char_length("creator_discovery_projections"."canonical_handle") between 3 and 30 and "creator_discovery_projections"."canonical_handle" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "creator_discovery_projections_disciplines_check" CHECK (cardinality("creator_discovery_projections"."disciplines") between 1 and 3 and "creator_discovery_projections"."disciplines" <@ ARRAY['illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other']::text[])
);
--> statement-breakpoint
CREATE TABLE "creator_handle_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"normalized_handle" text NOT NULL,
	"kind" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone,
	CONSTRAINT "creator_handle_claims_kind_check" CHECK ("creator_handle_claims"."kind" in ('canonical','alias')),
	CONSTRAINT "creator_handle_claims_normalized_handle_check" CHECK (char_length("creator_handle_claims"."normalized_handle") between 3 and 30 and "creator_handle_claims"."normalized_handle" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "creator_handle_claims_replaced_check" CHECK (("creator_handle_claims"."kind" = 'canonical' and "creator_handle_claims"."replaced_at" is null) or ("creator_handle_claims"."kind" = 'alias' and "creator_handle_claims"."replaced_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "creator_page_drafts" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"short_introduction" text NOT NULL,
	"primary_discipline" text NOT NULL,
	"secondary_disciplines" text[] DEFAULT '{}'::text[] NOT NULL,
	"avatar_asset_id" uuid,
	"cover_asset_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_page_drafts_display_name_check" CHECK (char_length("creator_page_drafts"."display_name") between 1 and 80),
	CONSTRAINT "creator_page_drafts_short_introduction_check" CHECK (char_length("creator_page_drafts"."short_introduction") between 1 and 500),
	CONSTRAINT "creator_page_drafts_primary_discipline_check" CHECK ("creator_page_drafts"."primary_discipline" in ('illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other')),
	CONSTRAINT "creator_page_drafts_secondary_disciplines_check" CHECK (cardinality("creator_page_drafts"."secondary_disciplines") between 0 and 2 and "creator_page_drafts"."secondary_disciplines" <@ ARRAY['illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other']::text[] and array_position("creator_page_drafts"."secondary_disciplines", "creator_page_drafts"."primary_discipline") is null)
);
--> statement-breakpoint
CREATE TABLE "creator_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"draft_version" integer DEFAULT 1 NOT NULL,
	"published_revision_id" uuid,
	"rename_available_at" timestamp with time zone,
	"initialized_from_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_pages_draft_version_check" CHECK ("creator_pages"."draft_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "creator_publication_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_id" uuid,
	"type" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"expected_draft_version" integer NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_publication_events_type_check" CHECK ("creator_publication_events"."type" in ('published','unpublished')),
	CONSTRAINT "creator_publication_events_expected_draft_version_check" CHECK ("creator_publication_events"."expected_draft_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "creator_publication_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publication_showcase_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"alternative_text" text NOT NULL,
	"thumb_derivative_id" uuid NOT NULL,
	"display_derivative_id" uuid NOT NULL,
	"large_derivative_id" uuid NOT NULL,
	CONSTRAINT "creator_publication_media_position_check" CHECK ("creator_publication_media"."position" between 0 and 3),
	CONSTRAINT "creator_publication_media_alternative_text_check" CHECK (char_length("creator_publication_media"."alternative_text") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "creator_publication_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"canonical_handle" text NOT NULL,
	"display_name" text NOT NULL,
	"short_introduction" text NOT NULL,
	"primary_discipline" text NOT NULL,
	"secondary_disciplines" text[] NOT NULL,
	"avatar_asset_id" uuid,
	"avatar_thumb_derivative_id" uuid,
	"avatar_display_derivative_id" uuid,
	"cover_asset_id" uuid,
	"cover_display_derivative_id" uuid,
	"taxonomy_version" text DEFAULT 'creator-discipline-v1' NOT NULL,
	"policy_version" text DEFAULT 'general-audience-v1' NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"expected_draft_version" integer NOT NULL,
	"request_id" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_publication_revisions_number_check" CHECK ("creator_publication_revisions"."revision_number" > 0),
	CONSTRAINT "creator_publication_revisions_canonical_handle_check" CHECK (char_length("creator_publication_revisions"."canonical_handle") between 3 and 30 and "creator_publication_revisions"."canonical_handle" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "creator_publication_revisions_display_name_check" CHECK (char_length("creator_publication_revisions"."display_name") between 1 and 80),
	CONSTRAINT "creator_publication_revisions_short_introduction_check" CHECK (char_length("creator_publication_revisions"."short_introduction") between 1 and 500),
	CONSTRAINT "creator_publication_revisions_primary_discipline_check" CHECK ("creator_publication_revisions"."primary_discipline" in ('illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other')),
	CONSTRAINT "creator_publication_revisions_secondary_disciplines_check" CHECK (cardinality("creator_publication_revisions"."secondary_disciplines") between 0 and 2 and "creator_publication_revisions"."secondary_disciplines" <@ ARRAY['illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other']::text[] and array_position("creator_publication_revisions"."secondary_disciplines", "creator_publication_revisions"."primary_discipline") is null),
	CONSTRAINT "creator_publication_revisions_policy_check" CHECK ("creator_publication_revisions"."taxonomy_version" = 'creator-discipline-v1' and "creator_publication_revisions"."policy_version" = 'general-audience-v1'),
	CONSTRAINT "creator_publication_revisions_expected_draft_version_check" CHECK ("creator_publication_revisions"."expected_draft_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "creator_publication_showcases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"source_showcase_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"discipline" text NOT NULL,
	"content_label" text NOT NULL,
	"external_url" text,
	CONSTRAINT "creator_publication_showcases_position_check" CHECK ("creator_publication_showcases"."position" between 0 and 11),
	CONSTRAINT "creator_publication_showcases_title_check" CHECK (char_length("creator_publication_showcases"."title") between 1 and 100),
	CONSTRAINT "creator_publication_showcases_description_check" CHECK (char_length("creator_publication_showcases"."description") between 0 and 1000),
	CONSTRAINT "creator_publication_showcases_discipline_check" CHECK ("creator_publication_showcases"."discipline" in ('illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other')),
	CONSTRAINT "creator_publication_showcases_content_label_check" CHECK ("creator_publication_showcases"."content_label" = 'general_audience')
);
--> statement-breakpoint
CREATE TABLE "creator_showcase_draft_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"showcase_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"alternative_text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_showcase_draft_media_position_check" CHECK ("creator_showcase_draft_media"."position" between 0 and 3),
	CONSTRAINT "creator_showcase_draft_media_alternative_text_check" CHECK (char_length("creator_showcase_draft_media"."alternative_text") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "creator_showcase_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"discipline" text NOT NULL,
	"content_label" text DEFAULT 'general_audience' NOT NULL,
	"external_url" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_showcase_drafts_position_check" CHECK ("creator_showcase_drafts"."position" between 0 and 11),
	CONSTRAINT "creator_showcase_drafts_title_check" CHECK (char_length("creator_showcase_drafts"."title") between 1 and 100),
	CONSTRAINT "creator_showcase_drafts_description_check" CHECK (char_length("creator_showcase_drafts"."description") between 0 and 1000),
	CONSTRAINT "creator_showcase_drafts_discipline_check" CHECK ("creator_showcase_drafts"."discipline" in ('illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other')),
	CONSTRAINT "creator_showcase_drafts_content_label_check" CHECK ("creator_showcase_drafts"."content_label" = 'general_audience')
);
--> statement-breakpoint
ALTER TABLE "creator_discovery_projections" ADD CONSTRAINT "creator_discovery_projections_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_handle_claims" ADD CONSTRAINT "creator_handle_claims_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_page_drafts" ADD CONSTRAINT "creator_page_drafts_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_pages" ADD CONSTRAINT "creator_pages_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_publication_events" ADD CONSTRAINT "creator_publication_events_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_publication_events" ADD CONSTRAINT "creator_publication_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_publication_media" ADD CONSTRAINT "creator_publication_media_publication_showcase_id_creator_publication_showcases_id_fk" FOREIGN KEY ("publication_showcase_id") REFERENCES "creator_publication_showcases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_publication_revisions" ADD CONSTRAINT "creator_publication_revisions_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_publication_revisions" ADD CONSTRAINT "creator_publication_revisions_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_publication_showcases" ADD CONSTRAINT "creator_publication_showcases_revision_id_creator_publication_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "creator_publication_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_showcase_draft_media" ADD CONSTRAINT "creator_showcase_draft_media_showcase_id_creator_showcase_drafts_id_fk" FOREIGN KEY ("showcase_id") REFERENCES "creator_showcase_drafts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_showcase_drafts" ADD CONSTRAINT "creator_showcase_drafts_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_discovery_projections_canonical_handle_uidx" ON "creator_discovery_projections" USING btree (lower("canonical_handle"));--> statement-breakpoint
CREATE INDEX "creator_discovery_projections_enabled_handle_idx" ON "creator_discovery_projections" USING btree ("canonical_handle","page_id") WHERE "creator_discovery_projections"."enabled";--> statement-breakpoint
CREATE INDEX "creator_handle_claims_page_idx" ON "creator_handle_claims" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_handle_claims_one_canonical_page_uidx" ON "creator_handle_claims" USING btree ("page_id") WHERE "creator_handle_claims"."kind" = 'canonical';--> statement-breakpoint
CREATE UNIQUE INDEX "creator_handle_claims_normalized_handle_uidx" ON "creator_handle_claims" USING btree (lower("normalized_handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "creator_pages_user_uidx" ON "creator_pages" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_pages_published_revision_uidx" ON "creator_pages" USING btree ("published_revision_id") WHERE "creator_pages"."published_revision_id" is not null;--> statement-breakpoint
CREATE INDEX "creator_publication_events_page_idx" ON "creator_publication_events" USING btree ("page_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_publication_media_position_uidx" ON "creator_publication_media" USING btree ("publication_showcase_id","position");--> statement-breakpoint
CREATE INDEX "creator_publication_media_asset_showcase_idx" ON "creator_publication_media" USING btree ("asset_id","publication_showcase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_publication_revisions_number_uidx" ON "creator_publication_revisions" USING btree ("page_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_publication_revisions_id_page_uidx" ON "creator_publication_revisions" USING btree ("id","page_id");--> statement-breakpoint
CREATE INDEX "creator_publication_revisions_page_idx" ON "creator_publication_revisions" USING btree ("page_id","published_at");--> statement-breakpoint
CREATE INDEX "creator_publication_revisions_avatar_asset_idx" ON "creator_publication_revisions" USING btree ("avatar_asset_id","page_id") WHERE "creator_publication_revisions"."avatar_asset_id" is not null;--> statement-breakpoint
CREATE INDEX "creator_publication_revisions_cover_asset_idx" ON "creator_publication_revisions" USING btree ("cover_asset_id","page_id") WHERE "creator_publication_revisions"."cover_asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_publication_showcases_position_uidx" ON "creator_publication_showcases" USING btree ("revision_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_showcase_draft_media_position_uidx" ON "creator_showcase_draft_media" USING btree ("showcase_id","position");--> statement-breakpoint
CREATE INDEX "creator_showcase_drafts_page_idx" ON "creator_showcase_drafts" USING btree ("page_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_showcase_drafts_active_position_uidx" ON "creator_showcase_drafts" USING btree ("page_id","position") WHERE "creator_showcase_drafts"."removed_at" is null;
--> statement-breakpoint
ALTER TABLE "creator_pages" ADD CONSTRAINT "creator_pages_published_head_fk"
FOREIGN KEY ("published_revision_id", "id") REFERENCES "creator_publication_revisions"("id", "page_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "creator_publication_events" ADD CONSTRAINT "creator_publication_events_revision_page_fk"
FOREIGN KEY ("revision_id", "page_id") REFERENCES "creator_publication_revisions"("id", "page_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "creator_discovery_projections" ADD CONSTRAINT "creator_discovery_projections_revision_page_fk"
FOREIGN KEY ("revision_id", "page_id") REFERENCES "creator_publication_revisions"("id", "page_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_catalog_reject_direct_alias_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'alias' THEN
    RAISE EXCEPTION 'creator handle aliases must arise from a canonical replacement' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_handle_claims_reject_direct_alias
BEFORE INSERT ON "creator_handle_claims"
FOR EACH ROW EXECUTE FUNCTION creator_catalog_reject_direct_alias_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_catalog_reject_handle_claim_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'creator handle claims are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.kind = 'canonical'
    AND NEW.kind = 'alias'
    AND OLD.replaced_at IS NULL
    AND NEW.replaced_at IS NOT NULL
    AND ROW(OLD.id, OLD.page_id, OLD.normalized_handle, OLD.claimed_at)
      IS NOT DISTINCT FROM ROW(NEW.id, NEW.page_id, NEW.normalized_handle, NEW.claimed_at)
    AND EXISTS (
      SELECT 1 FROM creator_handle_claims
      WHERE page_id = NEW.page_id AND kind = 'canonical' AND id <> NEW.id
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'creator handle claims are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER creator_handle_claims_append_only
AFTER UPDATE OR DELETE ON "creator_handle_claims"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION creator_catalog_reject_handle_claim_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_catalog_limit_active_showcases() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.removed_at IS NULL
    AND (TG_OP = 'INSERT' OR OLD.removed_at IS NOT NULL OR OLD.page_id IS DISTINCT FROM NEW.page_id)
    AND (SELECT count(*) FROM creator_showcase_drafts WHERE page_id = NEW.page_id AND removed_at IS NULL AND id <> NEW.id) >= 12
  THEN
    RAISE EXCEPTION 'creator pages may have at most 12 active showcases' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_showcase_drafts_limit_active
BEFORE INSERT OR UPDATE ON "creator_showcase_drafts"
FOR EACH ROW EXECUTE FUNCTION creator_catalog_limit_active_showcases();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_catalog_limit_showcase_media() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.showcase_id IS DISTINCT FROM NEW.showcase_id THEN
    IF (SELECT count(*) FROM creator_showcase_draft_media WHERE showcase_id = NEW.showcase_id AND id <> NEW.id) >= 4 THEN
      RAISE EXCEPTION 'creator showcases may have at most four media rows' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_showcase_draft_media_limit
BEFORE INSERT OR UPDATE ON "creator_showcase_draft_media"
FOR EACH ROW EXECUTE FUNCTION creator_catalog_limit_showcase_media();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_catalog_reject_publication_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'creator publication records are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_publication_revisions_append_only BEFORE UPDATE OR DELETE ON "creator_publication_revisions" FOR EACH ROW EXECUTE FUNCTION creator_catalog_reject_publication_mutation();
--> statement-breakpoint
CREATE TRIGGER creator_publication_showcases_append_only BEFORE UPDATE OR DELETE ON "creator_publication_showcases" FOR EACH ROW EXECUTE FUNCTION creator_catalog_reject_publication_mutation();
--> statement-breakpoint
CREATE TRIGGER creator_publication_media_append_only BEFORE UPDATE OR DELETE ON "creator_publication_media" FOR EACH ROW EXECUTE FUNCTION creator_catalog_reject_publication_mutation();
--> statement-breakpoint
CREATE TRIGGER creator_publication_events_append_only BEFORE UPDATE OR DELETE ON "creator_publication_events" FOR EACH ROW EXECUTE FUNCTION creator_catalog_reject_publication_mutation();
