import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  adminAuditEvents,
  createDatabase,
  publicContentReports,
  publicContentTriageEvents,
  publicVisibilityHolds,
  systemOutbox,
  type PawketTransaction,
} from "@pawket/database";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  createTriageService,
  TriageServiceError,
  type OwnerTriageCommand,
  type ReportTarget,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";
const migrationsFolder = fileURLToPath(new URL("../../database/migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const schemaName = `triage_service_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const baseTime = new Date("2026-08-31T03:00:00.000Z");
const pageId = "10000000-0000-4000-8000-000000000101";
const revisionId = "20000000-0000-4000-8000-000000000102";
const showcaseId = "30000000-0000-4000-8000-000000000103";
const creatorUserId = "triage-creator";
const ownerUserId = "triage-owner";
const reporterUserId = "triage-reporter";
const target: ReportTarget = { targetType: "page", targetId: pageId, publicationRevisionId: revisionId };

let connection: ReturnType<typeof createDatabase>;
let schemaClient: postgres.Sql;
let currentTime = new Date(baseTime);

async function seedUser(userId: string): Promise<void> {
  await schemaClient`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values (${userId}, 'Triage User', ${`${userId}@example.test`}, ${`${userId}@example.test`}, true,
      ${baseTime.toISOString()}, 'password_email_challenge', 'active', 1,
      ${baseTime.toISOString()}, ${baseTime.toISOString()})`;
}

async function seedReport(input: { target?: ReportTarget; reporter?: string | null } = {}): Promise<string> {
  const reportId = randomUUID();
  const reportTarget = input.target ?? target;
  await connection.db.insert(publicContentReports).values({
    id: reportId,
    reportReference: `report:v1:${randomUUID().replaceAll("-", "")}`,
    targetType: reportTarget.targetType,
    targetId: reportTarget.targetId,
    publicationRevisionId: reportTarget.publicationRevisionId,
    reason: "privacy",
    detail: "Private reporter detail",
    reporterUserId: input.reporter === undefined ? reporterUserId : input.reporter,
    state: "open",
    version: 1,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  return reportId;
}

function service() {
  return createTriageService({
    db: connection.db,
    commandFingerprintKey: Buffer.alloc(32, 12),
    clock: () => new Date(currentTime),
    catalogModeration: {
      async resolveVisibleReportTarget() { return null; },
      async readRevisionTarget(_db, candidate) {
        if (candidate.publicationRevisionId !== revisionId || candidate.targetId !== (candidate.targetType === "page" ? pageId : showcaseId)) return null;
        return {
          target: { ...candidate },
          pageId,
          creatorUserId,
          canonicalHandle: "triage-creator",
          displayName: "Triage Creator",
          showcaseTitle: candidate.targetType === "showcase" ? "Stable showcase" : null,
          mediaAssetIds: [],
        };
      },
    },
    consumeStepUpProof: async (_tx: PawketTransaction, proof) =>
      proof.proofId !== "expired" &&
      proof.userId === ownerUserId &&
      proof.sessionId === "owner-session" &&
      proof.actionClass === `owner.public_report_${proof.proofId}`,
  });
}

function command(reportId: string, action: "dismiss" | "hide" | "restore", overrides: Partial<OwnerTriageCommand & { holdId: string }> = {}) {
  return {
    ownerUserId,
    ownerSessionId: "owner-session",
    stepUpProofId: action,
    reportId,
    expectedVersion: 1,
    reason: "Reviewed by the Pawket owner.",
    idempotencyKey: `${action}-triage-command`,
    requestId: `${action}-triage-request`,
    ...overrides,
  };
}

describe("owner public-report triage", () => {
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schemaName}"`);
    connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName}%2Cpublic`);
    await migrate(connection.db, { migrationsFolder, migrationsSchema: journalSchema });
    schemaClient = postgres(databaseUrl, { max: 1 });
    await schemaClient.unsafe(`set search_path to "${schemaName}", public`);
    await Promise.all([seedUser(creatorUserId), seedUser(ownerUserId), seedUser(reporterUserId)]);
    await schemaClient`
      insert into creator_pages
        (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
      values (${pageId}, ${creatorUserId}, 1, ${randomUUID()}, ${baseTime.toISOString()}, ${baseTime.toISOString()})`;
    await schemaClient`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values (${revisionId}, ${pageId}, 1, 'triage-creator', 'Triage Creator', 'Introduction',
        'illustration', array[]::text[], 'creator-discipline-v1', 'general-audience-v1',
        ${creatorUserId}, 'creator-session', 1, 'creator-publication', ${baseTime.toISOString()})`;
  });

  beforeEach(async () => {
    currentTime = new Date(baseTime);
    await connection.db.execute(sql.raw("truncate table public_content_triage_events, public_visibility_holds, public_content_reports, system_command_idempotency, admin_audit_events, system_outbox cascade"));
  });

  afterAll(async () => {
    await connection.close();
    await schemaClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  });

  test.each(["dismiss", "hide", "restore"] as const)("%s requires fresh action-scoped owner TOTP and expected version", async (action) => {
    // Break caught: an owner mutation accepts an expired/cross-action proof or ignores optimistic concurrency.
    const reportId = await seedReport();
    let holdId: string | undefined;
    let expectedVersion = 1;
    if (action === "restore") {
      const hidden = await service().hide(command(reportId, "hide"));
      if (!hidden.holdId) throw new Error("hide did not create a hold");
      holdId = hidden.holdId;
      expectedVersion = hidden.reportVersion;
      currentTime = new Date(baseTime.getTime() + 1);
    }
    const invoke = (overrides: Record<string, unknown>) => action === "restore"
      ? service().restore({ ...command(reportId, action), holdId: holdId!, expectedVersion, ...overrides })
      : service()[action](command(reportId, action, { expectedVersion, ...overrides }));

    await expect(invoke({ stepUpProofId: "expired" })).rejects.toMatchObject({ code: "OWNER_TOTP_REQUIRED" });
    await expect(invoke({ expectedVersion: 99 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  test("same-key hide replays and different-body reuse conflicts without another fact", async () => {
    // Break caught: retrying a committed hide creates a second hold/event, or changed input reuses the first result.
    const reportId = await seedReport();
    const hide = command(reportId, "hide");
    const first = await service().hide(hide);
    await expect(service().hide(hide)).resolves.toEqual(first);
    await expect(service().hide({ ...hide, reason: "Different owner explanation." })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await connection.db.select().from(publicVisibilityHolds)).toHaveLength(1);
    expect(await connection.db.select().from(publicContentTriageEvents)).toHaveLength(1);
  });

  test("restore is compensating, releases exactly one hold, and records complete safe facts", async () => {
    // Break caught: restore rewrites/deletes the hide fact, leaves the hold effective, or omits audit/outbox evidence.
    const reportId = await seedReport();
    const hidden = await service().hide(command(reportId, "hide"));
    if (!hidden.holdId) throw new Error("hide did not create a hold");
    currentTime = new Date(baseTime.getTime() + 1);
    const restored = await service().restore({ ...command(reportId, "restore"),
      holdId: hidden.holdId,
      expectedVersion: hidden.reportVersion,
    });

    expect(restored).toEqual({ reportId, reportState: "closed", reportVersion: 3, holdId: hidden.holdId, holdVersion: 2 });
    const [report] = await connection.db.select().from(publicContentReports).where(eq(publicContentReports.id, reportId));
    const [hold] = await connection.db.select().from(publicVisibilityHolds).where(eq(publicVisibilityHolds.id, hidden.holdId));
    expect(report).toMatchObject({ state: "closed", version: 3 });
    expect(hold).toMatchObject({ version: 2, releaseReason: "Reviewed by the Pawket owner." });
    expect(hold?.releasedAt).toEqual(currentTime);
    expect((await connection.db.select().from(publicContentTriageEvents).where(eq(publicContentTriageEvents.reportId, reportId))).map((event) => ({ action: event.action, before: event.beforeState, after: event.afterState, version: event.resultingReportVersion }))).toEqual([
      { action: "hide", before: "open", after: "held", version: 2 },
      { action: "restore", before: "held", after: "closed", version: 3 },
    ]);
    expect((await connection.db.select().from(adminAuditEvents)).map((event) => event.action)).toEqual(["trust.public_report.hide", "trust.public_report.restore"]);
    const outbox = await connection.db.select().from(systemOutbox).where(eq(systemOutbox.eventType, "trust.public_report_triaged.v1"));
    expect(outbox).toHaveLength(2);
    expect(JSON.stringify(outbox)).not.toContain("Private reporter detail");
    expect(JSON.stringify(outbox)).not.toContain(reporterUserId);
  });

  test("owner projections include bounded privacy-safe dismiss, hide, and restore history", async () => {
    // Break caught: owner triage loses prior action context or leaks actor/session/request identifiers in that history.
    const dismissedReportId = await seedReport({ reporter: null });
    await service().dismiss(command(dismissedReportId, "dismiss"));
    const dismissed = await service().getDetail(dismissedReportId);
    expect(dismissed.priorActions).toEqual([{
      action: "dismiss",
      reason: "Reviewed by the Pawket owner.",
      beforeState: "open",
      afterState: "dismissed",
      resultingReportVersion: 2,
      occurredAt: baseTime.toISOString(),
    }]);

    currentTime = new Date(baseTime.getTime() + 1);
    const heldReportId = await seedReport();
    const hidden = await service().hide(command(heldReportId, "hide"));
    expect((await service().listQueue()).find((item) => item.reportId === heldReportId)?.priorActions).toEqual([{
      action: "hide",
      reason: "Reviewed by the Pawket owner.",
      beforeState: "open",
      afterState: "held",
      resultingReportVersion: 2,
      occurredAt: currentTime.toISOString(),
    }]);

    if (!hidden.holdId) throw new Error("hide did not create a hold");
    currentTime = new Date(baseTime.getTime() + 2);
    await service().restore({
      ...command(heldReportId, "restore"),
      holdId: hidden.holdId,
      expectedVersion: hidden.reportVersion,
    });
    const restored = await service().getDetail(heldReportId);
    expect(restored.priorActions).toEqual([
      {
        action: "hide",
        reason: "Reviewed by the Pawket owner.",
        beforeState: "open",
        afterState: "held",
        resultingReportVersion: 2,
        occurredAt: new Date(baseTime.getTime() + 1).toISOString(),
      },
      {
        action: "restore",
        reason: "Reviewed by the Pawket owner.",
        beforeState: "held",
        afterState: "closed",
        resultingReportVersion: 3,
        occurredAt: currentTime.toISOString(),
      },
    ]);
    expect(JSON.stringify(restored.priorActions)).not.toContain(ownerUserId);
    expect(JSON.stringify(restored.priorActions)).not.toContain("owner-session");
    expect(JSON.stringify(restored.priorActions)).not.toContain("request-");
  });

  test("owner and creator projections expose only their bounded audiences", async () => {
    // Break caught: the owner queue leaks network data or the creator receives report detail/reporter identity.
    const reportId = await seedReport();
    const hidden = await service().hide(command(reportId, "hide"));
    if (!hidden.holdId) throw new Error("hide did not create a hold");
    const queue = await service().listQueue();
    const detail = await service().getDetail(reportId);
    const creator = await service().listCreatorEnforcements(creatorUserId);

    expect(queue).toEqual([detail]);
    expect(detail).toMatchObject({
      reportId,
      reason: "privacy",
      detail: "Private reporter detail",
      state: "held",
      version: 2,
      authenticatedReporter: true,
      activeHold: { holdId: hidden.holdId, targetType: "page" },
    });
    expect(Reflect.ownKeys(detail).sort()).toEqual(["activeHold", "authenticatedReporter", "detail", "priorActions", "reason", "reportId", "snapshot", "state", "target", "version"]);
    expect(creator).toEqual([{
      targetType: "page",
      targetId: pageId,
      held: true,
      explanation: "Reviewed by the Pawket owner.",
      occurredAt: baseTime.toISOString(),
    }]);
    expect(JSON.stringify(creator)).not.toContain("Private reporter detail");
    expect(JSON.stringify(creator)).not.toContain(reporterUserId);
  });

  test("factory snapshots exact dependencies without invoking hostile traps", () => {
    // Break caught: a proxy/accessor supplied at composition executes before Trust can fail with a stable error.
    let trapCalls = 0;
    const hostile = new Proxy({
      db: connection.db,
      commandFingerprintKey: Buffer.alloc(32, 12),
      catalogModeration: {},
      consumeStepUpProof: async () => true,
    }, {
      get() { trapCalls += 1; throw new Error("composition secret"); },
    });
    expect(() => createTriageService(hostile as never)).toThrowError(TriageServiceError);
    expect(trapCalls).toBe(0);

    expect(() => createTriageService({
      db: connection.db,
      commandFingerprintKey: Buffer.alloc(32, 12),
      catalogModeration: {
        async resolveVisibleReportTarget() { return null; },
        async readRevisionTarget() { return null; },
        async unrelatedCatalogMethod() { return "safe broad adapter"; },
      },
      consumeStepUpProof: async () => true,
    } as never)).not.toThrow();
  });
});
