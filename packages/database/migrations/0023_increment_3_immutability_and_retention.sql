ALTER TABLE "creator_publication_events" DROP CONSTRAINT "creator_publication_events_type_check";--> statement-breakpoint
ALTER TABLE "creator_publication_events" ADD CONSTRAINT "creator_publication_events_type_check" CHECK ("creator_publication_events"."type" in ('published','unpublished','suspension_unpublish'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public_media_guard_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'media processing attempts are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'terminal media processing attempts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'media processing attempt identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.finished_at IS NULL OR NEW.outcome_code IS NULL OR NEW.outcome_code = 'started' THEN
    RAISE EXCEPTION 'media processing attempts may only close once' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'media processing attempt timestamps cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION block_held_public_media_cleanup() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.source_deleted_at IS NULL OR NEW.source_deleted_at IS NOT DISTINCT FROM OLD.source_deleted_at THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT report.target_type, report.target_id, report.publication_revision_id
      FROM public_content_reports report
      WHERE report.state = 'open'
      UNION ALL
      SELECT hold.target_type, hold.target_id, hold.publication_revision_id
      FROM public_visibility_holds hold
      WHERE hold.released_at IS NULL
    ) target
    JOIN creator_publication_revisions revision
      ON revision.id = target.publication_revision_id
    LEFT JOIN creator_publication_showcases showcase
      ON showcase.revision_id = revision.id
    LEFT JOIN creator_publication_media media
      ON media.publication_showcase_id = showcase.id
    WHERE (
      target.target_type = 'page'
      AND target.target_id = revision.page_id
      AND (
        NEW.id = revision.avatar_asset_id
        OR NEW.id = revision.cover_asset_id
        OR NEW.id = media.asset_id
      )
    ) OR (
      target.target_type = 'showcase'
      AND target.target_id = showcase.source_showcase_id
      AND NEW.id = media.asset_id
    )
  ) OR EXISTS (
    SELECT 1
    FROM system_retention_holds hold
    WHERE hold.released_at IS NULL
      AND hold.reason_category IN ('incident', 'legal')
      AND (
        (hold.subject_type = 'user' AND hold.subject_id = NEW.owner_user_id)
        OR (
          hold.subject_type = 'creator_application'
          AND EXISTS (
            SELECT 1
            FROM creator_applications application
            WHERE application.id::text = hold.subject_id
              AND application.user_id = NEW.owner_user_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'public media source cleanup is blocked by an active retention hold' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER public_media_cleanup_hold_guard
BEFORE UPDATE OF source_deleted_at ON "public_media_assets"
FOR EACH ROW EXECUTE FUNCTION block_held_public_media_cleanup();
