import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  publicContentReports,
  publicContentTriageEvents,
  publicReportChallenges,
  publicReportSecurityEvents,
  publicVisibilityHolds,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const schemaName = `public_trust_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;

const now = new Date();
const userId = `trust-user-${randomUUID()}`;
const pageId = randomUUID();
const revisionId = randomUUID();
const initializedFromRevisionId = randomUUID();

async function seedCatalog() {
  await client`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values (${userId}, 'Trust User', ${`${userId}@example.test`}, ${`${userId}@example.test`}, true,
      ${now.toISOString()}, 'password_email_challenge', 'active', 1, ${now.toISOString()}, ${now.toISOString()})`;
  await client`
    insert into creator_pages (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
    values (${pageId}, ${userId}, 1, ${initializedFromRevisionId}, ${now.toISOString()}, ${now.toISOString()})`;
  await client`
    insert into creator_publication_revisions
      (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
       primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
       actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
    values (${revisionId}, ${pageId}, 1, 'trust-user', 'Trust User', 'Introduction',
      'illustration', array[]::text[], 'creator-discipline-v1', 'general-audience-v1',
      ${userId}, 'trust-schema-session', 1, 'trust-schema-fixture', ${now.toISOString()})`;
}

async function insertReport(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.insert(publicContentReports).values({
    id,
    reportReference: `report:v1:${Buffer.from(randomUUID()).toString("base64url")}`,
    targetType: "page",
    targetId: pageId,
    publicationRevisionId: revisionId,
    reason: "privacy",
    detail: null,
    reporterUserId: null,
    state: "open",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

describe("public trust persistence", () => {
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schemaName}"`);
    client = postgres(databaseUrl, { max: 1 });
    await client.unsafe(`set search_path to "${schemaName}", public`);
    db = drizzle(client);
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
    await seedCatalog();
  });

  afterAll(async () => {
    await client.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  });

  test("exports all five authoritative trust tables", () => {
    expect([publicContentReports, publicReportChallenges, publicReportSecurityEvents, publicVisibilityHolds, publicContentTriageEvents]).toHaveLength(5);
  });

  test("report binds to an exact revision and closed reason", async () => {
    await insertReport();
    await expect(insertReport({ publicationRevisionId: null })).rejects.toThrow();
    await expect(insertReport({ reason: "unlisted" })).rejects.toThrow();
    await expect(client`
      insert into public_content_reports
        (id, report_reference, target_type, target_id, publication_revision_id, reason,
         state, version, created_at, updated_at)
      values (${randomUUID()}, ${`report:v1:${Buffer.from(randomUUID()).toString("base64url")}`},
        'page', ${pageId}, ${revisionId}, 'privacy', 'held', 1, ${now.toISOString()}, ${now.toISOString()})
    `).rejects.toThrow(/begin open/i);
    await expect(insertReport({ targetId: randomUUID() })).rejects.toThrow(/target|revision/i);
    await expect(insertReport({ detail: "Cafe\u0301" })).rejects.toThrow();
    await expect(insertReport({ detail: "\ud83c\udfa8".repeat(1_001) })).rejects.toThrow();
    await expect(insertReport({ detail: "contains\ncontrol" })).rejects.toThrow();
  });

  test("report and triage history are append-only", async () => {
    const reportId = await insertReport();
    const eventId = randomUUID();
    const event = {
      id: eventId,
      reportId,
      holdId: null,
      action: "dismiss",
      actorUserId: userId,
      actorSessionId: "owner-session",
      reason: "reviewed",
      requestId: "triage-request",
      expectedReportVersion: 1,
      resultingReportVersion: 2,
      beforeState: "open",
      afterState: "dismissed",
      occurredAt: now,
    } as const;
    await expect(db.insert(publicContentTriageEvents).values(event)).rejects.toThrow(/resulting report state|version/i);
    await client`select * from trust_transition_public_content_report(${reportId}, 1, 'dismissed', ${new Date(now.getTime() + 1_000).toISOString()})`;
    await db.insert(publicContentTriageEvents).values(event);
    await expect(client`delete from public_content_reports where id = ${reportId}`).rejects.toThrow(/append-only/i);
    await expect(client`update public_content_reports set reason = 'other' where id = ${reportId}`).rejects.toThrow(/triage|append-only/i);
    await client`select set_config('pawket.trust_report_transition', ${reportId}, true)`;
    await expect(client`update public_content_reports set state = 'closed', version = 3 where id = ${reportId}`).rejects.toThrow(/approved triage function/i);
    await expect(client`delete from public_content_triage_events where id = ${eventId}`).rejects.toThrow(/append-only/i);
  });

  test("challenges and security telemetry enforce bounded private shapes", async () => {
    const challengeId = randomUUID();
    await db.insert(publicReportChallenges).values({
      id: challengeId,
      tokenHash: `sha256:v1:${"a".repeat(43)}`,
      networkKeyHmac: `hmac-sha256:v1:${"b".repeat(43)}`,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      consumedAt: null,
    });
    await expect(client`update public_report_challenges set network_key_hmac = ${`hmac-sha256:v1:${"z".repeat(43)}`} where id = ${challengeId}`).rejects.toThrow(/consumption is final/i);
    await expect(client`delete from public_report_challenges where id = ${challengeId}`).rejects.toThrow(/active.*cannot be deleted/i);
    await expect(db.insert(publicReportChallenges).values({
      id: randomUUID(), tokenHash: `sha256:v1:${"c".repeat(43)}`,
      networkKeyHmac: `hmac-sha256:v1:${"d".repeat(43)}`,
      issuedAt: now, expiresAt: new Date(now.getTime() + 600_001), consumedAt: null,
    })).rejects.toThrow();
    await db.insert(publicReportSecurityEvents).values({
      id: randomUUID(), requesterKind: "guest",
      networkKeyHmac: `hmac-sha256:v1:${"e".repeat(43)}`, actorUserId: null,
      targetHash: `sha256:v1:${"f".repeat(43)}`, revisionHash: `sha256:v1:${"g".repeat(43)}`,
      outcome: "accepted", outcomeCategory: "accepted", createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    await expect(db.insert(publicReportSecurityEvents).values({
      id: randomUUID(), requesterKind: "guest",
      networkKeyHmac: `hmac-sha256:v1:${"h".repeat(43)}`, actorUserId: null,
      targetHash: `sha256:v1:${"i".repeat(43)}`, revisionHash: `sha256:v1:${"j".repeat(43)}`,
      outcome: "accepted", outcomeCategory: "accepted", createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_001),
    })).rejects.toThrow();
    await expect(db.insert(publicReportSecurityEvents).values({
      id: randomUUID(), requesterKind: "guest",
      networkKeyHmac: `hmac-sha256:v1:${"k".repeat(43)}`, actorUserId: null,
      targetHash: `sha256:v1:${"l".repeat(43)}`, revisionHash: `sha256:v1:${"m".repeat(43)}`,
      outcome: "accepted", outcomeCategory: "duplicate", createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    })).rejects.toThrow();
  });

  test("private records have no raw network, user-agent, email, media, or storage columns", async () => {
    const rows = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = ${schemaName}
        and table_name in ('public_content_reports', 'public_report_security_events', 'public_report_challenges')
    `;
    const names = rows.map((row) => row.column_name);
    expect(names).not.toEqual(expect.arrayContaining([
      "ip", "ip_address", "raw_network", "user_agent", "email", "media_bytes",
      "storage_key", "object_key", "signed_url",
    ]));
    expect(names).toContain("network_key_hmac");
  });

  test("active holds cannot be deleted or retargeted and release only once", async () => {
    const reportId = await insertReport();
    const holdId = randomUUID();
    await expect(client`
      insert into public_visibility_holds
        (id, report_id, target_type, target_id, publication_revision_id, reason,
         actor_user_id, actor_session_id, request_id, version, created_at)
      values (${randomUUID()}, ${reportId}, 'page', ${randomUUID()}, ${revisionId}, 'privacy_review',
        ${userId}, 'owner-session', 'wrong-hide-request', 1, ${now.toISOString()})
    `).rejects.toThrow(/bind.*source report|exact target/i);
    await client`select * from trust_transition_public_content_report(${reportId}, 1, 'held', ${new Date(now.getTime() + 500).toISOString()})`;
    await db.insert(publicVisibilityHolds).values({
      id: holdId, reportId, targetType: "page", targetId: pageId,
      publicationRevisionId: revisionId, reason: "privacy_review",
      actorUserId: userId, actorSessionId: "owner-session", requestId: "hide-request",
      version: 1, createdAt: now, releasedAt: null, releasedByUserId: null,
      releasedBySessionId: null, releaseReason: null, releaseRequestId: null,
    });
    await expect(client`delete from public_visibility_holds where id = ${holdId}`).rejects.toThrow(/append-only/i);
    await expect(client`update public_visibility_holds set target_id = ${randomUUID()} where id = ${holdId}`).rejects.toThrow(/append-only|retarget/i);
    await expect(client`update public_visibility_holds set released_at = ${new Date(now.getTime() + 500).toISOString()}, version = 2 where id = ${holdId}`).rejects.toThrow();
    await client`update public_visibility_holds set released_at = ${new Date(now.getTime() + 1_000).toISOString()}, released_by_user_id = ${userId}, released_by_session_id = 'owner-session', release_reason = 'restored', release_request_id = 'restore-request', version = 2 where id = ${holdId}`;
    await expect(client`update public_visibility_holds set released_at = ${new Date(now.getTime() + 2_000).toISOString()} where id = ${holdId}`).rejects.toThrow(/final|once/i);
  });
});
