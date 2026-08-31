import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  publicContentReports,
  publicVisibilityHolds,
  systemRetentionHolds,
  type PawketTransaction,
} from "@pawket/database";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createTriageService, type ReportTarget } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";
const migrationsFolder = fileURLToPath(new URL("../../database/migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const schemaName = `visibility_port_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const now = new Date("2026-08-31T04:00:00.000Z");
const pageId = "11000000-0000-4000-8000-000000000201";
const revisionId = "22000000-0000-4000-8000-000000000202";
const showcaseId = "33000000-0000-4000-8000-000000000203";
const showcaseRowId = "44000000-0000-4000-8000-000000000204";
const avatarAssetId = "55000000-0000-4000-8000-000000000205";
const coverAssetId = "55000000-0000-4000-8000-000000000206";
const showcaseAssetId = "55000000-0000-4000-8000-000000000207";
const unprotectedAssetId = "55000000-0000-4000-8000-000000000208";
const creatorUserId = "visibility-creator";
const ownerUserId = "visibility-owner";
let connection: ReturnType<typeof createDatabase>;
let schemaClient: postgres.Sql;

async function seedUser(userId: string): Promise<void> {
  await schemaClient`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values (${userId}, 'Visibility User', ${`${userId}@example.test`}, ${`${userId}@example.test`}, true,
      ${now.toISOString()}, 'password_email_challenge', 'active', 1, ${now.toISOString()}, ${now.toISOString()})`;
}

function snapshot(candidate: ReportTarget) {
  return {
    target: { ...candidate },
    pageId,
    creatorUserId,
    canonicalHandle: "visibility-creator",
    displayName: "Visibility Creator",
    showcaseTitle: candidate.targetType === "showcase" ? "Stable showcase" : null,
    mediaAssetIds: candidate.targetType === "page" ? [avatarAssetId, coverAssetId, showcaseAssetId] : [showcaseAssetId],
  };
}

function service() {
  return createTriageService({
    db: connection.db,
    commandFingerprintKey: Buffer.alloc(32, 18),
    clock: () => new Date(now),
    catalogModeration: {
      async resolveVisibleReportTarget() { return null; },
      async readRevisionTarget(_db, candidate) {
        return candidate.publicationRevisionId === revisionId && (candidate.targetId === pageId || candidate.targetId === showcaseId) ? snapshot(candidate) : null;
      },
    },
    consumeStepUpProof: async (_tx: PawketTransaction, proof) => proof.proofId === proof.actionClass.replace("owner.public_report_", ""),
  });
}

async function report(targetType: "page" | "showcase", state = "open"): Promise<string> {
  const reportId = randomUUID();
  await connection.db.insert(publicContentReports).values({
    id: reportId,
    reportReference: `report:v1:${randomUUID().replaceAll("-", "")}`,
    targetType,
    targetId: targetType === "page" ? pageId : showcaseId,
    publicationRevisionId: revisionId,
    reason: "privacy",
    detail: null,
    reporterUserId: null,
    state,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  return reportId;
}

function hideCommand(reportId: string) {
  return {
    ownerUserId,
    ownerSessionId: "owner-session",
    stepUpProofId: "hide",
    reportId,
    expectedVersion: 1,
    reason: "Hidden after owner review.",
    idempotencyKey: `hide-${reportId}`,
    requestId: `request-${reportId}`,
  };
}

describe("Trust visibility and public-media retention adapters", () => {
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schemaName}"`);
    connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName}%2Cpublic`);
    await migrate(connection.db, { migrationsFolder, migrationsSchema: journalSchema });
    schemaClient = postgres(databaseUrl, { max: 1 });
    await schemaClient.unsafe(`set search_path to "${schemaName}", public`);
    await Promise.all([seedUser(creatorUserId), seedUser(ownerUserId)]);
    await schemaClient`
      insert into creator_pages
        (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
      values (${pageId}, ${creatorUserId}, 1, ${randomUUID()}, ${now.toISOString()}, ${now.toISOString()})`;
    await schemaClient`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         avatar_asset_id, cover_asset_id, actor_user_id, actor_session_id,
         expected_draft_version, request_id, published_at)
      values (${revisionId}, ${pageId}, 1, 'visibility-creator', 'Visibility Creator', 'Introduction',
        'illustration', array[]::text[], 'creator-discipline-v1', 'general-audience-v1',
        ${avatarAssetId}, ${coverAssetId}, ${creatorUserId}, 'creator-session', 1,
        'creator-publication', ${now.toISOString()})`;
    await schemaClient`
      insert into creator_publication_showcases
        (id, revision_id, source_showcase_id, position, title, description, discipline, content_label, external_url)
      values (${showcaseRowId}, ${revisionId}, ${showcaseId}, 0, 'Stable showcase', '', 'illustration', 'general_audience', null)`;
    await schemaClient`
      insert into creator_publication_media
        (id, publication_showcase_id, asset_id, position, alternative_text,
         thumb_derivative_id, display_derivative_id, large_derivative_id)
      values (${randomUUID()}, ${showcaseRowId}, ${showcaseAssetId}, 0, 'Artwork',
        ${randomUUID()}, ${randomUUID()}, ${randomUUID()})`;
    for (const assetId of [avatarAssetId, coverAssetId, showcaseAssetId, unprotectedAssetId]) {
      await schemaClient`
        insert into public_media_assets
          (id, owner_user_id, purpose, declared_source_format, state, source_allocation_bytes,
           source_object_key, created_at, updated_at)
        values (${assetId}, ${creatorUserId}, 'showcase', 'jpeg', 'awaiting_upload', 100,
          ${`quarantine/${assetId}/${randomUUID()}`}, ${now.toISOString()}, ${now.toISOString()})`;
    }
  });

  beforeEach(async () => {
    await connection.db.execute(sql.raw("truncate table public_content_triage_events, public_visibility_holds, public_content_reports, system_command_idempotency, admin_audit_events, system_outbox, system_retention_holds cascade"));
  });

  afterAll(async () => {
    await connection.close();
    await schemaClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  });

  test("stable page and showcase holds remain effective across later publication revisions", async () => {
    // Break caught: a creator evades a hold by republishing under a new revision ID.
    const pageReportId = await report("page");
    await service().hide(hideCommand(pageReportId));
    expect(await connection.db.select({ reportId: publicVisibilityHolds.reportId, targetId: publicVisibilityHolds.targetId, publicationRevisionId: publicVisibilityHolds.publicationRevisionId }).from(publicVisibilityHolds)).toEqual([{
      reportId: pageReportId,
      targetId: pageId,
      publicationRevisionId: revisionId,
    }]);
    const laterRevisionId = randomUUID();
    expect(await service().visibilityReadPort.readHolds(connection.db, pageId, laterRevisionId, [showcaseId])).toEqual({
      pageHeld: true,
      heldShowcaseIds: new Set(),
    });

    await connection.db.execute(sql.raw("truncate table public_content_triage_events, public_visibility_holds, public_content_reports, system_command_idempotency, admin_audit_events, system_outbox cascade"));
    const showcaseReportId = await report("showcase");
    await service().hide(hideCommand(showcaseReportId));
    expect(await service().visibilityReadPort.readHolds(connection.db, pageId, laterRevisionId, [showcaseId, randomUUID()])).toEqual({
      pageHeld: false,
      heldShowcaseIds: new Set([showcaseId]),
    });
    const batch = await service().visibilityReadPort.readHoldsBatch(connection.db, [{ pageId, revisionId: laterRevisionId, showcaseIds: [showcaseId] }]);
    expect(batch).toEqual(new Map([[pageId, { pageHeld: false, heldShowcaseIds: new Set([showcaseId]) }]]));
  });

  test("open reports and active visibility holds protect the exact referenced media", async () => {
    // Break caught: cleanup deletes revision evidence while its report is open or its stable target remains held.
    const reportId = await report("page");
    const candidates = [avatarAssetId, coverAssetId, showcaseAssetId, unprotectedAssetId];
    await expect(service().publicMediaRetentionHoldPort.protectedAssetIds(connection.db, candidates)).resolves.toEqual(new Set([avatarAssetId, coverAssetId, showcaseAssetId]));

    await service().hide(hideCommand(reportId));
    await expect(service().publicMediaRetentionHoldPort.protectedAssetIds(connection.db, candidates)).resolves.toEqual(new Set([avatarAssetId, coverAssetId, showcaseAssetId]));
  });

  test.each(["incident", "legal"] as const)("an active user-level %s hold protects all creator assets", async (reasonCategory) => {
    // Break caught: media cleanup ignores an active incident/legal retention hold on the asset owner.
    await connection.db.insert(systemRetentionHolds).values({
      dataset: "sessions",
      subjectType: "user",
      subjectId: creatorUserId,
      reasonCategory,
      referenceId: `${reasonCategory}-visibility-incident`,
      startsAt: now,
      releasedAt: null,
      createdAt: now,
    });
    await expect(service().publicMediaRetentionHoldPort.protectedAssetIds(connection.db, [unprotectedAssetId])).resolves.toEqual(new Set([unprotectedAssetId]));
  });
});
