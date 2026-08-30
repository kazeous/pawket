import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabase,
  publicContentReports,
  publicReportChallenges,
  publicReportSecurityEvents,
  publicVisibilityHolds,
  systemOutbox,
} from "@pawket/database";
import { hashOpaqueToken } from "@pawket/security";
import { createReportService, PublicReportError, type ReportTarget } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";
const migrationsFolder = fileURLToPath(new URL("../../database/migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const schemaName = `report_service_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
let connection: ReturnType<typeof createDatabase>;
let schemaClient: postgres.Sql;

const now = new Date("2026-08-30T04:00:00.000Z");
const target: ReportTarget = {
  targetType: "page",
  targetId: "10000000-0000-4000-8000-000000000001",
  publicationRevisionId: "20000000-0000-4000-8000-000000000002",
};
const networkKeyHmac = `hmac-sha256:v1:${"n".repeat(43)}`;
const lookupHmacKey = Buffer.alloc(32, 7);
const creatorUserId = `creator-${randomUUID()}`;

async function seedUser(userId: string) {
  await schemaClient`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values (${userId}, 'Report User', ${`${userId}@example.test`}, ${`${userId}@example.test`}, true,
      ${now.toISOString()}, 'password_email_challenge', 'active', 1, ${now.toISOString()}, ${now.toISOString()})`;
}

function leadingZeroBits(buffer: Buffer) {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) { count += 8; continue; }
    return count + Math.clz32(byte) - 24;
  }
  return count;
}

function solve(token: string): number {
  for (let solution = 0; solution < 5_000_000; solution += 1) {
    if (leadingZeroBits(createHash("sha256").update(`${token}.${solution}`).digest()) >= 18) return solution;
  }
  throw new Error("challenge was not solvable in test budget");
}

function service(overrides: Readonly<{
  clock?: () => Date;
  resolve?: (candidate: ReportTarget) => unknown | Promise<unknown>;
  key?: Uint8Array;
}> = {}) {
  return createReportService({
    db: connection.db,
    lookupHmacKey: overrides.key ?? lookupHmacKey,
    clock: overrides.clock ?? (() => new Date(now)),
    nonce: () => randomUUID().replaceAll("-", ""),
    catalogModeration: {
      async resolveVisibleReportTarget(_db, candidate) {
        if (overrides.resolve) return await overrides.resolve(candidate) as never;
        return candidate.targetType === target.targetType && candidate.targetId === target.targetId && candidate.publicationRevisionId === target.publicationRevisionId
          ? { target: { ...target }, pageId: target.targetId, creatorUserId, canonicalHandle: "creator-user", displayName: "Creator User", showcaseTitle: null, mediaAssetIds: [] }
          : null;
      },
      async readRevisionTarget() { return null; },
    },
  });
}

describe("contextual report submission", () => {
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schemaName}"`);
    connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName}%2Cpublic`);
    await migrate(connection.db, { migrationsFolder, migrationsSchema: journalSchema });
    schemaClient = postgres(databaseUrl, { max: 1 });
    await schemaClient.unsafe(`set search_path to "${schemaName}", public`);
    await seedUser(creatorUserId);
    await schemaClient`
      insert into creator_pages (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
      values (${target.targetId}, ${creatorUserId}, 1, ${randomUUID()}, ${now.toISOString()}, ${now.toISOString()})`;
    await schemaClient`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values (${target.publicationRevisionId}, ${target.targetId}, 1, 'creator-user', 'Creator User', 'Introduction',
        'illustration', array[]::text[], 'creator-discipline-v1', 'general-audience-v1',
        ${creatorUserId}, 'report-test-session', 1, 'report-test-publication', ${now.toISOString()})`;
  });

  afterAll(async () => {
    await connection.close();
    await schemaClient.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  });

  test("guest challenge is signed, exactly ten minutes long, and consumed once", async () => {
    const reportService = service();
    const challenge = await reportService.issueChallenge({ networkKeyHmac });
    expect(challenge.difficulty).toBe(18);
    expect(Date.parse(challenge.expiresAt) - now.getTime()).toBe(600_000);
    const solution = solve(challenge.token);
    const command = { requester: { kind: "guest", networkKeyHmac }, target, reason: "privacy", detail: "Cafe\u0301", challenge: { token: challenge.token, solution } } as const;
    await expect(reportService.submitReport(command)).resolves.toMatchObject({ accepted: true });
    await expect(reportService.submitReport(command)).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });
    const [row] = await connection.db.select().from(publicReportChallenges);
    expect(row?.consumedAt).toEqual(now);
  });

  test("rejects a changed signature and wrong network without consuming the valid challenge", async () => {
    const correctNetwork = `hmac-sha256:v1:${"r".repeat(43)}`;
    const wrongNetwork = `hmac-sha256:v1:${"s".repeat(43)}`;
    const reportService = service();
    const challenge = await reportService.issueChallenge({ networkKeyHmac: correctNetwork });
    const changed = `${challenge.token.slice(0, -1)}${challenge.token.endsWith("A") ? "B" : "A"}`;
    await expect(reportService.submitReport({ requester: { kind: "guest", networkKeyHmac: correctNetwork }, target, reason: "privacy", detail: null, challenge: { token: changed, solution: 0 } })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED", status: 400 });
    await expect(reportService.submitReport({ requester: { kind: "guest", networkKeyHmac: wrongNetwork }, target, reason: "privacy", detail: null, challenge: { token: challenge.token, solution: solve(challenge.token) } })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED", status: 400 });
    const [row] = await connection.db.select().from(publicReportChallenges).where(eq(publicReportChallenges.tokenHash, hashOpaqueToken(challenge.token, "public-report-challenge")));
    expect(row?.consumedAt).toBeNull();
  });

  test("uses the database as the requester-rate source of truth", async () => {
    const limitedNetwork = `hmac-sha256:v1:${"t".repeat(43)}`;
    await connection.db.insert(publicReportSecurityEvents).values(Array.from({ length: 5 }, (_, index) => ({
      id: randomUUID(), requesterKind: "guest", networkKeyHmac: limitedNetwork, actorUserId: null,
      targetHash: `sha256:v1:${String.fromCharCode(65 + index).repeat(43)}`,
      revisionHash: `sha256:v1:${String.fromCharCode(75 + index).repeat(43)}`,
      outcome: "accepted", outcomeCategory: "accepted", createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    })));
    const reportService = service();
    const challenge = await reportService.issueChallenge({ networkKeyHmac: limitedNetwork });
    await expect(reportService.submitReport({ requester: { kind: "guest", networkKeyHmac: limitedNetwork }, target, reason: "privacy", detail: null, challenge: { token: challenge.token, solution: solve(challenge.token) } })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED", status: 429 });
  });

  test("persists no network key in the report and emits only a safe event", async () => {
    const reportService = service();
    const challenge = await reportService.issueChallenge({ networkKeyHmac: `hmac-sha256:v1:${"p".repeat(43)}` });
    const detail = "private report detail";
    const result = await reportService.submitReport({ requester: { kind: "guest", networkKeyHmac: `hmac-sha256:v1:${"p".repeat(43)}` }, target: { ...target, targetId: "10000000-0000-4000-8000-000000000003" }, reason: "other", detail, challenge: { token: challenge.token, solution: solve(challenge.token) } }).catch((error) => error);
    expect(result).toMatchObject({ code: "REPORT_NOT_ACCEPTED" });

    const validChallenge = await reportService.issueChallenge({ networkKeyHmac: `hmac-sha256:v1:${"q".repeat(43)}` });
    await reportService.submitReport({ requester: { kind: "guest", networkKeyHmac: `hmac-sha256:v1:${"q".repeat(43)}` }, target, reason: "other", detail, challenge: { token: validChallenge.token, solution: solve(validChallenge.token) } });
    const reports = await connection.db.select().from(publicContentReports).where(eq(publicContentReports.detail, detail));
    const outbox = await connection.db.select().from(systemOutbox).where(eq(systemOutbox.eventType, "trust.public_content_reported.v1"));
    expect(JSON.stringify(reports)).not.toContain(networkKeyHmac);
    expect(JSON.stringify(outbox)).not.toContain(detail);
    expect(outbox.at(-1)?.payload).toEqual(expect.objectContaining({ targetType: "page", reason: "other" }));
    expect(Object.keys(outbox.at(-1)?.payload ?? {}).sort()).toEqual(["reason", "reportId", "targetType"]);
    const security = await connection.db.select().from(publicReportSecurityEvents);
    expect(security.every((event) => event.expiresAt.getTime() - event.createdAt.getTime() <= 86_400_000)).toBe(true);
  });

  test("normalizes before opening the transaction and rejects hostile inputs without invoking traps", async () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { requester: { kind: "authenticated", actorUserId: "actor-user" }, target, reason: "privacy" };
    Object.defineProperty(hostile, "detail", { enumerable: true, get() { getterCalls += 1; return "secret"; } });
    await expect(service().submitReport(hostile as never)).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });
    await expect(service().submitReport(new Proxy(hostile, {}) as never)).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });
    expect(getterCalls).toBe(0);
  });

  test("fails closed for hostile clock, key, and Catalog outputs", async () => {
    class HostileDate extends Date {}
    expect(() => service({ key: new Proxy(lookupHmacKey, {}) })).toThrowError(PublicReportError);
    await expect(service({ clock: () => new HostileDate(now) }).issueChallenge({ networkKeyHmac })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });

    const actorUserId = `hostile-actor-${randomUUID()}`;
    await seedUser(actorUserId);
    let trapCalls = 0;
    const hostileSnapshot = new Proxy({ target, pageId: target.targetId, creatorUserId, canonicalHandle: "creator-user", displayName: "Creator User", showcaseTitle: null, mediaAssetIds: [] }, {
      ownKeys(value) { trapCalls += 1; return Reflect.ownKeys(value); },
    });
    await expect(service({ resolve: () => hostileSnapshot }).submitReport({ requester: { kind: "authenticated", actorUserId }, target, reason: "privacy", detail: null })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });
    await expect(service({ resolve: () => ({ target, pageId: randomUUID(), creatorUserId, canonicalHandle: "creator-user", displayName: "Creator User", showcaseTitle: null, mediaAssetIds: [] }) }).submitReport({ requester: { kind: "authenticated", actorUserId }, target, reason: "privacy", detail: null })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });
    expect(trapCalls).toBe(0);
  });

  test("concurrent exact duplicate submissions produce one logical authenticated report", async () => {
    const actorUserId = `actor-${randomUUID()}`;
    await seedUser(actorUserId);
    const command = { requester: { kind: "authenticated", actorUserId }, target, reason: "spam_or_scam", detail: null } as const;
    const settled = await Promise.allSettled([service().submitReport(command), service().submitReport(command)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    const rows = await connection.db.select().from(publicContentReports).where(eq(publicContentReports.reporterUserId, actorUserId));
    expect(rows).toHaveLength(1);
    expect(await connection.db.select().from(publicVisibilityHolds)).toEqual([]);
  });

  test("target exhaustion stays uniform and does not use requester 429 semantics", async () => {
    const actorUserId = `target-limited-actor-${randomUUID()}`;
    await seedUser(actorUserId);
    await expect(service().submitReport({ requester: { kind: "authenticated", actorUserId }, target, reason: "privacy", detail: null }))
      .rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED", status: 400 });
  });
});
