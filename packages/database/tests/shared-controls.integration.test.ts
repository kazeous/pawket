import { readdir, readFile } from "node:fs/promises";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hashOpaqueToken } from "@pawket/security";

import {
  adminAuditEvents,
  appendAdminAuditEvent,
  beginIdempotentCommand,
  calculateStoredReceiptBusinessDayWindow,
  completeIdempotentCommand,
  importBusinessCalendarVersion,
  importConfiguredBusinessCalendarVersion,
  insertOutboxEvent,
  runRetentionSweep,
  systemBusinessCalendarHolidays,
  systemBusinessCalendarVersions,
  systemCommandIdempotency,
  systemOutbox,
  systemRetentionRuns,
  type PawketDatabase,
} from "../src/index.js";
import * as schema from "../src/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const schemaName = `shared_controls_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../migrations/", import.meta.url);

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function waitForAdvisoryLockWait(
  observer: postgres.Sql,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [row] = await observer<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_locks locks
      join pg_stat_activity activity on activity.pid = locks.pid
      where activity.application_name = ${applicationName}
        and locks.locktype = 'advisory'
        and locks.granted = false
    `;
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on an advisory lock`);
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  const migrations = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migration of migrations) await executeMigration(migration);
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("shared control repositories", () => {
  test("admin audit is append-only and rejects unsafe JSON before storage", async () => {
    const eventId = await db.transaction((tx) =>
      appendAdminAuditEvent(tx, {
        actorUserId: "owner-1",
        actorSessionId: "session-1",
        subjectType: "creator_application",
        subjectId: "application-1",
        action: "application.approve",
        outcome: "succeeded",
        reasonCode: "meets_requirements",
        beforeState: { status: "under_review" },
        afterState: { status: "approved" },
        assurance: { method: "totp", fresh: true },
        applicationRevision: "revision-1",
        requestId: "request-1",
        occurredAt: new Date("2026-08-24T01:00:00.000Z"),
      }),
    );

    await expect(
      db.transaction((tx) =>
        appendAdminAuditEvent(tx, {
          actorUserId: "owner-1",
          subjectType: "creator_application",
          subjectId: "application-1",
          action: "application.reveal",
          outcome: "denied",
          assurance: { totp: "123456" },
          applicationRevision: "revision-1",
          requestId: "request-unsafe",
        }),
      ),
    ).rejects.toThrow("Unsafe audit data");

    await expect(
      client.unsafe(`update admin_audit_events set outcome = 'failed' where id = '${eventId}'`),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.unsafe(`delete from admin_audit_events where id = '${eventId}'`),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(db.select().from(adminAuditEvents)).resolves.toHaveLength(1);
  });

  test("idempotency distinguishes in-progress, replay, conflict, and expiry", async () => {
    const now = new Date("2026-08-24T02:00:00.000Z");
    const expiresAt = new Date("2026-08-25T02:00:00.000Z");
    const keyHash = hashOpaqueToken("request-key", "idempotency-key");
    const requestFingerprint = hashOpaqueToken("canonical-request-a", "command-request");
    const acquired = await db.transaction((tx) =>
      beginIdempotentCommand(tx, {
        actorUserId: "owner-1",
        commandScope: "creator.approve",
        keyHash,
        requestFingerprint,
        now,
        expiresAt,
      }),
    );
    expect(acquired.kind).toBe("acquired");
    await expect(
      db.transaction((tx) =>
        beginIdempotentCommand(tx, {
          actorUserId: "owner-1",
          commandScope: "creator.approve",
          keyHash,
          requestFingerprint,
          now,
          expiresAt,
        }),
      ),
    ).resolves.toEqual({ kind: "in_progress", recordId: acquired.recordId });
    await expect(
      db.transaction((tx) =>
        beginIdempotentCommand(tx, {
          actorUserId: "owner-1",
          commandScope: "creator.approve",
          keyHash,
          requestFingerprint: hashOpaqueToken("canonical-request-b", "command-request"),
          now,
          expiresAt,
        }),
      ),
    ).resolves.toEqual({ kind: "conflict", recordId: acquired.recordId });
    await expect(
      db.transaction((tx) =>
        completeIdempotentCommand(tx, {
          recordId: acquired.recordId,
          resultReference: "creator-application:application-1:approved",
          completedAt: new Date("2026-08-24T02:00:01.000Z"),
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      db.transaction((tx) =>
        beginIdempotentCommand(tx, {
          actorUserId: "owner-1",
          commandScope: "creator.approve",
          keyHash,
          requestFingerprint,
          now,
          expiresAt,
        }),
      ),
    ).resolves.toEqual({
      kind: "replay",
      recordId: acquired.recordId,
      resultReference: "creator-application:application-1:approved",
    });
    await db
      .update(systemCommandIdempotency)
      .set({ expiresAt: new Date("2026-08-24T02:00:02.000Z") })
      .where(eq(systemCommandIdempotency.id, acquired.recordId));
    await expect(
      db.transaction((tx) =>
        beginIdempotentCommand(tx, {
          actorUserId: "owner-1",
          commandScope: "creator.approve",
          keyHash,
          requestFingerprint,
          now: new Date("2026-08-24T02:00:03.000Z"),
          expiresAt: new Date("2026-08-24T02:00:04.000Z"),
        }),
      ),
    ).resolves.toEqual({ kind: "expired", recordId: acquired.recordId });
  });

  test("calendar import is versioned and day-five/day-seven use the stored receipt date", async () => {
    const calendar = {
      version: "vn-2026-v1",
      sourceLabel: "owner-approved-2026",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      importedAt: new Date("2026-08-24T00:00:00.000Z"),
      holidays: [{ date: "2026-09-02", name: "National Day" }],
    } as const;
    await expect(
      db.transaction((tx) => importBusinessCalendarVersion(tx, calendar)),
    ).resolves.toBe("inserted");
    await expect(
      db.transaction((tx) => importBusinessCalendarVersion(tx, calendar)),
    ).resolves.toBe("already_present");
    await expect(
      db.transaction((tx) =>
        importBusinessCalendarVersion(tx, { ...calendar, sourceLabel: "different-source" }),
      ),
    ).rejects.toThrow("Business calendar version conflicts");
    await expect(
      db.transaction((tx) =>
        calculateStoredReceiptBusinessDayWindow(tx, {
          receiptDate: "2026-08-28",
          calendarVersion: calendar.version,
        }),
      ),
    ).resolves.toEqual({
      receiptDate: "2026-08-28",
      calendarVersion: "vn-2026-v1",
      refundNotBefore: "2026-09-07",
      refundDue: "2026-09-09",
    });
    await expect(
      db
        .update(systemBusinessCalendarHolidays)
        .set({ name: "Changed" })
        .where(eq(systemBusinessCalendarHolidays.calendarVersion, calendar.version)),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(db.select().from(systemBusinessCalendarVersions)).resolves.toHaveLength(1);
  });

  test("configured calendar bootstrap is repeatable and rejects version drift", async () => {
    const calendar = {
      version: "vn-2026-env-v1",
      holidayDates: ["2026-09-02", "2026-09-03"],
      importedAt: new Date("2026-08-27T12:00:00.000Z"),
    } as const;
    await expect(
      db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, calendar)),
    ).resolves.toBe("inserted");
    await expect(
      db.transaction((tx) =>
        importConfiguredBusinessCalendarVersion(tx, {
          ...calendar,
          importedAt: new Date("2026-08-28T12:00:00.000Z"),
        }),
      ),
    ).resolves.toBe("already_present");

    const [storedVersion] = await db
      .select()
      .from(systemBusinessCalendarVersions)
      .where(eq(systemBusinessCalendarVersions.version, calendar.version));
    expect(storedVersion).toMatchObject({
      sourceLabel: "pawket-env:VN_BUSINESS_HOLIDAYS",
      publishedAt: calendar.importedAt,
      importedAt: calendar.importedAt,
    });
    await expect(
      db.transaction((tx) =>
        importConfiguredBusinessCalendarVersion(tx, {
          ...calendar,
          holidayDates: ["2026-09-02"],
        }),
      ),
    ).rejects.toThrow("Business calendar version conflicts");
  });

  test("outbox rejects sensitive payloads before a row or job can exist", async () => {
    await expect(
      db.transaction((tx) =>
        insertOutboxEvent(tx, {
          eventType: "creator.receiving-account.updated",
          eventVersion: 1,
          aggregateType: "creator_application",
          aggregateId: "application-1",
          payload: { bankAccountNumber: "123456789" },
        }),
      ),
    ).rejects.toThrow("Unsafe outbox data");
    const rows = await db.execute<{ count: string }>(sql`select count(*)::text as count from ${systemOutbox}`);
    expect(rows[0]?.count).toBe("0");
  });

  test("retention reports without mutation, honors pause, and enforces only eligible rows", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at, email_verification_provenance,
         two_factor_enabled, access_status, authorization_version, created_at, updated_at)
      values
        ('retention-eligible', 'Eligible', 'eligible@example.test', 'eligible@example.test', false, null, null, false, 'active', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
        ('retention-protected', 'Protected', 'protected@example.test', 'protected@example.test', false, null, null, false, 'active', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
        ('retention-boundary', 'Boundary', 'boundary@example.test', 'boundary@example.test', false, null, null, false, 'active', 1, '2026-08-18T12:00:00Z', '2026-08-18T12:00:00Z'),
        ('retention-business-eligible', 'Business Eligible', 'business-eligible@example.test', 'business-eligible@example.test', true, '2026-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('retention-business-protected', 'Business Protected', 'business-protected@example.test', 'business-protected@example.test', true, '2026-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('retention-business-boundary', 'Business Boundary', 'business-boundary@example.test', 'business-boundary@example.test', true, '2026-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into identity_role_grants
        (user_id, role, state, grant_source, version, granted_at, created_at, updated_at)
      values ('retention-protected', 'owner', 'active', 'bootstrap_cli', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      insert into identity_verifications
        (id, identifier_hash, token_hash, purpose, expires_at, attempt_count, created_at, updated_at)
      values ('retention-verification', 'identifier-retention', 'token-retention', 'password_reset', '2026-08-01T01:00:00Z', 0, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      insert into identity_sessions
        (id, expires_at, token_hash, created_at, updated_at, user_id, assurance_state, last_used_at, absolute_expires_at, idle_expires_at, authorization_version)
      values ('retention-session', '2026-07-01T01:00:00Z', 'session-token-retention', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'retention-protected', 'provisional', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', 1);
      insert into identity_security_throttles
        (scope, subject_hmac, action, attempt_count, window_started_at, risk_level, updated_at)
      values ('network', 'retention-network-hmac', 'sign_in', 1, '2026-07-01T00:00:00Z', 'normal', '2026-07-01T00:00:00Z');
      insert into payments_receiving_account_onboarding
        (id, onboarding_id, applicant_user_id, version, bank_bin, bank_name, account_number_envelope, account_holder_label_envelope, masked_suffix, account_fingerprint, proof_state, retired_at, created_at, updated_at)
      values
        ('10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'retention-business-eligible', 1, '970436', 'Test Bank', '{"version":1}'::jsonb, '{"version":1}'::jsonb, '•••• 0001', 'hmac-sha256:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'unverified', '2026-07-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'),
        ('10000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', 'retention-business-protected', 1, '970436', 'Test Bank', '{"version":1}'::jsonb, '{"version":1}'::jsonb, '•••• 0002', 'hmac-sha256:v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'unverified', '2026-07-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'),
        ('10000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000003', 'retention-business-boundary', 1, '970436', 'Test Bank', '{"version":1}'::jsonb, '{"version":1}'::jsonb, '•••• 0003', 'hmac-sha256:v1:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'unverified', '2026-07-26T12:00:00Z', '2026-01-01T00:00:00Z', '2026-07-26T12:00:00Z');
      insert into creator_applications (id, user_id, state, version, created_at, updated_at)
      values
        ('20000000-0000-4000-8000-000000000001', 'retention-business-eligible', 'withdrawn', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('20000000-0000-4000-8000-000000000002', 'retention-business-protected', 'withdrawn', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('20000000-0000-4000-8000-000000000003', 'retention-business-boundary', 'withdrawn', 1, '2026-01-01T00:00:00Z', '2026-02-26T12:00:00Z');
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, short_introduction, applicant_email, dob_envelope, portfolio_urls, primary_art_discipline, practice_description, content_intent, proposed_receiving_account_id, age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
      values
        ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1, 'Eligible artist', 'Private intro', 'business-eligible@example.test', '{"version":1}'::jsonb, '["https://example.test/private"]'::jsonb, 'illustration', 'Private practice', 'general_audience_only', '10000000-0000-4000-8000-000000000001', 21, '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1, 'Protected artist', 'Private intro', 'business-protected@example.test', '{"version":1}'::jsonb, '["https://example.test/private"]'::jsonb, 'illustration', 'Private practice', 'general_audience_only', '10000000-0000-4000-8000-000000000002', 21, '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 1, 'Boundary artist', 'Private intro', 'business-boundary@example.test', '{"version":1}'::jsonb, '["https://example.test/private"]'::jsonb, 'illustration', 'Private practice', 'general_audience_only', '10000000-0000-4000-8000-000000000003', 21, '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-02-26T12:00:00Z');
      insert into identity_creator_capabilities
        (id, user_id, state, version, approved_application_id, approved_revision_id, suspended_at, created_at, updated_at)
      values ('40000000-0000-4000-8000-000000000002', 'retention-business-protected', 'suspended', 1, '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);

    const report = await runRetentionSweep({
      db,
      now,
      mode: "report_only",
      policyVersion: "task8-test-v1",
      enforcementPaused: true,
      batchSize: 100,
    });
    expect(report.find((item) => item.dataset === "provisional_accounts")).toEqual(
      expect.objectContaining({ candidateCount: 2, protectedCount: 1, processedCount: 0 }),
    );
    expect(report.find((item) => item.dataset === "verifications")?.candidateCount).toBe(1);
    expect(report.find((item) => item.dataset === "receiving_accounts")).toEqual(
      expect.objectContaining({ candidateCount: 3, protectedCount: 1, processedCount: 0 }),
    );
    expect(report.find((item) => item.dataset === "application_content")).toEqual(
      expect.objectContaining({ candidateCount: 2, protectedCount: 1, processedCount: 0 }),
    );
    expect(await client`select id from identity_users where id = 'retention-eligible'`).toHaveLength(1);

    const paused = await runRetentionSweep({
      db,
      now,
      mode: "enforce",
      policyVersion: "task8-test-v1",
      enforcementPaused: true,
      batchSize: 100,
    });
    expect(paused.every((item) => item.outcome === "paused")).toBe(true);
    expect(await client`select id from identity_users where id = 'retention-eligible'`).toHaveLength(1);

    const enforced = await runRetentionSweep({
      db,
      now,
      mode: "enforce",
      policyVersion: "task8-test-v1",
      enforcementPaused: false,
      batchSize: 100,
    });
    expect(enforced.find((item) => item.dataset === "provisional_accounts")?.processedCount).toBe(1);
    expect(await client`select id from identity_users where id = 'retention-eligible'`).toHaveLength(0);
    expect(await client`select id from identity_users where id = 'retention-protected'`).toHaveLength(1);
    expect(await client`select id from identity_users where id = 'retention-boundary'`).toHaveLength(1);
    expect(await client`select id from identity_verifications where id = 'retention-verification'`).toHaveLength(0);
    expect(await client`select id from identity_sessions where id = 'retention-session'`).toHaveLength(0);
    const [eligibleAccount] = await client<{ minimized_at: Date | null; account_number_envelope: unknown }[]>`
      select minimized_at, account_number_envelope from payments_receiving_account_onboarding
      where id = '10000000-0000-4000-8000-000000000001'`;
    const [protectedAccount] = await client<{ minimized_at: Date | null; account_number_envelope: unknown }[]>`
      select minimized_at, account_number_envelope from payments_receiving_account_onboarding
      where id = '10000000-0000-4000-8000-000000000002'`;
    const [eligibleRevision] = await client<{ minimized_at: Date | null; artist_display_name: string | null }[]>`
      select minimized_at, artist_display_name from creator_application_revisions
      where id = '30000000-0000-4000-8000-000000000001'`;
    const [protectedRevision] = await client<{ minimized_at: Date | null; artist_display_name: string | null }[]>`
      select minimized_at, artist_display_name from creator_application_revisions
      where id = '30000000-0000-4000-8000-000000000002'`;
    expect(new Date(String(eligibleAccount?.minimized_at)).toISOString()).toBe(now.toISOString());
    expect(eligibleAccount).toMatchObject({ account_number_envelope: null });
    expect(protectedAccount).toMatchObject({ minimized_at: null, account_number_envelope: { version: 1 } });
    expect(new Date(String(eligibleRevision?.minimized_at)).toISOString()).toBe(now.toISOString());
    expect(eligibleRevision).toMatchObject({ artist_display_name: null });
    expect(protectedRevision).toMatchObject({ minimized_at: null, artist_display_name: "Protected artist" });
    expect(await db.select().from(systemRetentionRuns)).toHaveLength(18);
    await expect(
      client`update system_retention_runs set outcome = 'failed'`,
    ).rejects.toThrow("immutable control record");
    await expect(client`delete from system_retention_runs`).rejects.toThrow(
      "immutable control record",
    );
  });

  test("retention protects active verification challenges and every active hold", async () => {
    // Break caught: count and enforcement queries omitting either direct-row holds,
    // owning-user holds, or a live reissued email-verification challenge.
    const now = new Date("2025-02-01T12:00:00.000Z");
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, two_factor_enabled, access_status,
         authorization_version, created_at, updated_at)
      values
        ('task9-provisional-held', 'Held', 'held@example.test', 'held@example.test', false, null, null, false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-provisional-challenge', 'Challenge', 'challenge@example.test', 'challenge@example.test', false, null, null, false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-provisional-released', 'Released', 'released@example.test', 'released@example.test', false, null, null, false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-session-owner', 'Session Owner', 'session-owner@example.test', 'session-owner@example.test', true, '2024-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-session-released-owner', 'Released Session Owner', 'released-session-owner@example.test', 'released-session-owner@example.test', true, '2024-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-business-direct', 'Direct Business', 'direct-business@example.test', 'direct-business@example.test', true, '2024-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-business-owner', 'Owner Business', 'owner-business@example.test', 'owner-business@example.test', true, '2024-01-01T00:00:00Z', 'password_email_challenge', false, 'active', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
      insert into identity_verifications
        (id, identifier_hash, token_hash, purpose, user_id, expires_at, consumed_at,
         attempt_count, created_at, updated_at)
      values
        ('task9-live-email-verification', 'task9-live-identifier', 'task9-live-token', 'email_verification', 'task9-provisional-challenge', '2025-02-02T12:00:00Z', null, 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
        ('task9-verification-direct', 'task9-direct-identifier', 'task9-direct-token', 'password_reset', null, '2024-01-02T00:00:00Z', null, 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-verification-owner', 'task9-owner-identifier', 'task9-owner-token', 'password_reset', 'task9-session-owner', '2024-01-02T00:00:00Z', null, 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('task9-verification-released', 'task9-released-identifier', 'task9-released-token', 'password_reset', null, '2024-01-02T00:00:00Z', null, 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
      insert into identity_sessions
        (id, expires_at, token_hash, created_at, updated_at, user_id, assurance_state,
         last_used_at, absolute_expires_at, idle_expires_at, authorization_version)
      values
        ('task9-session-direct', '2024-01-02T00:00:00Z', 'task9-session-direct-token', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'task9-session-owner', 'provisional', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z', 1),
        ('task9-session-owner-held', '2024-01-02T00:00:00Z', 'task9-session-owner-token', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'task9-session-owner', 'provisional', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z', 1),
        ('task9-session-released', '2024-01-02T00:00:00Z', 'task9-session-released-token', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'task9-session-released-owner', 'provisional', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z', 1);
      insert into identity_security_throttles
        (id, scope, subject_hmac, action, attempt_count, window_started_at, risk_level, updated_at)
      values
        ('50000000-0000-4000-8000-000000000001', 'network', 'task9-throttle-direct-hmac', 'sign_in', 1, '2024-01-01T00:00:00Z', 'normal', '2024-01-01T00:00:00Z'),
        ('50000000-0000-4000-8000-000000000002', 'network', 'task9-throttle-released-hmac', 'sign_in', 1, '2024-01-01T00:00:00Z', 'normal', '2024-01-01T00:00:00Z');
      insert into payments_receiving_account_onboarding
        (id, onboarding_id, applicant_user_id, version, bank_bin, bank_name,
         account_number_envelope, account_holder_label_envelope, masked_suffix,
         account_fingerprint, proof_state, created_at, updated_at)
      values
        ('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', 'task9-business-direct', 1, '970436', 'Test Bank', '{"version":1}'::jsonb, '{"version":1}'::jsonb, '•••• 1001', 'hmac-sha256:v1:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'unverified', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002', 'task9-business-owner', 1, '970436', 'Test Bank', '{"version":1}'::jsonb, '{"version":1}'::jsonb, '•••• 1002', 'hmac-sha256:v1:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'unverified', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
      insert into creator_applications (id, user_id, state, version, created_at, updated_at)
      values
        ('53000000-0000-4000-8000-000000000001', 'task9-business-direct', 'withdrawn', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('53000000-0000-4000-8000-000000000002', 'task9-business-owner', 'withdrawn', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, short_introduction,
         applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
         practice_description, content_intent, proposed_receiving_account_id,
         age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
      values
        ('54000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', 1, 'Direct artist', 'Introduction', 'direct-business@example.test', '{"version":1}'::jsonb, '["https://example.test/direct"]'::jsonb, 'illustration', 'Practice', 'general_audience_only', '51000000-0000-4000-8000-000000000001', 21, '2024-01-01', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
        ('54000000-0000-4000-8000-000000000002', '53000000-0000-4000-8000-000000000002', 1, 'Owner artist', 'Introduction', 'owner-business@example.test', '{"version":1}'::jsonb, '["https://example.test/owner"]'::jsonb, 'illustration', 'Practice', 'general_audience_only', '51000000-0000-4000-8000-000000000002', 21, '2024-01-01', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id, starts_at, released_at, created_at)
      values
        ('provisional_accounts', 'user', 'task9-provisional-held', 'incident', 'task9-ref-provisional-active', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('provisional_accounts', 'user', 'task9-provisional-released', 'incident', 'task9-ref-provisional-released', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-01T00:00:00Z'),
        ('verifications', 'verification', 'task9-verification-direct', 'legal', 'task9-ref-verification-direct', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('verifications', 'user', 'task9-session-owner', 'incident', 'task9-ref-verification-owner', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('verifications', 'verification', 'task9-verification-released', 'incident', 'task9-ref-verification-released', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-01T00:00:00Z'),
        ('sessions', 'session', 'task9-session-direct', 'incident', 'task9-ref-session-direct', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('sessions', 'user', 'task9-session-owner', 'legal', 'task9-ref-session-owner', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('sessions', 'session', 'task9-session-released', 'incident', 'task9-ref-session-released', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-01T00:00:00Z'),
        ('security_throttles', 'security_throttle', '50000000-0000-4000-8000-000000000001', 'incident', 'task9-ref-throttle-active', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('security_throttles', 'security_throttle', '50000000-0000-4000-8000-000000000002', 'incident', 'task9-ref-throttle-released', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-01T00:00:00Z'),
        ('receiving_accounts', 'receiving_account', '51000000-0000-4000-8000-000000000001', 'legal', 'task9-ref-account-direct', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('receiving_accounts', 'user', 'task9-business-owner', 'incident', 'task9-ref-account-owner', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('application_content', 'creator_application', '53000000-0000-4000-8000-000000000001', 'legal', 'task9-ref-application-direct', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z'),
        ('application_content', 'user', 'task9-business-owner', 'incident', 'task9-ref-application-owner', '2025-01-01T00:00:00Z', null, '2025-01-01T00:00:00Z');
    `);

    await expect(client.unsafe(`
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id, starts_at, created_at)
      values ('provisional_accounts', 'user', 'task9-provisional-held', 'legal',
        'task9-ref-duplicate-active', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z')
    `)).rejects.toThrow();
    await expect(client.unsafe(`
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id, starts_at, created_at)
      values ('unknown', 'user', 'task9-invalid', 'legal', 'task9-ref-invalid',
        '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
    `)).rejects.toThrow();
    await expect(client.unsafe(`
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id, starts_at, released_at, created_at)
      values ('sessions', 'session', 'task9-invalid-time', 'incident', 'task9-ref-invalid-time',
        '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z')
    `)).rejects.toThrow();

    const report = await runRetentionSweep({
      db,
      now,
      mode: "report_only",
      policyVersion: "task9-test-v1",
      enforcementPaused: true,
      batchSize: 100,
    });
    expect(report).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset: "provisional_accounts", candidateCount: 3, protectedCount: 2, processedCount: 0 }),
      expect.objectContaining({ dataset: "verifications", candidateCount: 3, protectedCount: 2, processedCount: 0 }),
      expect.objectContaining({ dataset: "sessions", candidateCount: 3, protectedCount: 2, processedCount: 0 }),
      expect.objectContaining({ dataset: "security_throttles", candidateCount: 2, protectedCount: 1, processedCount: 0 }),
      expect.objectContaining({ dataset: "receiving_accounts", candidateCount: 2, protectedCount: 2, processedCount: 0 }),
      expect.objectContaining({ dataset: "application_content", candidateCount: 2, protectedCount: 2, processedCount: 0 }),
    ]));
    expect(await client`select id from identity_users where id = 'task9-provisional-released'`).toHaveLength(1);
    expect(await client`select id from identity_verifications where id = 'task9-verification-released'`).toHaveLength(1);

    const enforced = await runRetentionSweep({
      db,
      now,
      mode: "enforce",
      policyVersion: "task9-test-v1",
      enforcementPaused: false,
      batchSize: 100,
    });
    expect(enforced).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset: "provisional_accounts", processedCount: 1 }),
      expect.objectContaining({ dataset: "verifications", processedCount: 1 }),
      expect.objectContaining({ dataset: "sessions", processedCount: 1 }),
      expect.objectContaining({ dataset: "security_throttles", processedCount: 1 }),
      expect.objectContaining({ dataset: "receiving_accounts", processedCount: 0 }),
      expect.objectContaining({ dataset: "application_content", processedCount: 0 }),
    ]));
    expect(await client`select id from identity_users where id in ('task9-provisional-held', 'task9-provisional-challenge') order by id`).toHaveLength(2);
    expect(await client`select id from identity_users where id = 'task9-provisional-released'`).toHaveLength(0);
    expect(await client`select id from identity_verifications where id in ('task9-verification-direct', 'task9-verification-owner') order by id`).toHaveLength(2);
    expect(await client`select id from identity_verifications where id = 'task9-verification-released'`).toHaveLength(0);
    expect(await client`select id from identity_sessions where id in ('task9-session-direct', 'task9-session-owner-held') order by id`).toHaveLength(2);
    expect(await client`select id from identity_sessions where id = 'task9-session-released'`).toHaveLength(0);
    expect(await client`select id from identity_security_throttles where id = '50000000-0000-4000-8000-000000000001'`).toHaveLength(1);
    expect(await client`select id from identity_security_throttles where id = '50000000-0000-4000-8000-000000000002'`).toHaveLength(0);
    expect(await client`select id from payments_receiving_account_onboarding where minimized_at is null and id in ('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002')`).toHaveLength(2);
    expect(await client`select id from creator_application_revisions where minimized_at is null and id in ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002')`).toHaveLength(2);
  });

  test("retention holds reject every incompatible dataset and subject pair", async () => {
    // Break caught: independently valid enum values forming a hold no retention
    // query can ever observe.
    const subjectTypes = [
      "user",
      "verification",
      "session",
      "security_throttle",
      "receiving_account",
      "creator_application",
    ] as const;
    const allowed = {
      provisional_accounts: ["user"],
      verifications: ["user", "verification"],
      sessions: ["user", "session"],
      security_throttles: ["security_throttle"],
      receiving_accounts: ["user", "receiving_account"],
      application_content: ["user", "creator_application"],
    } as const;

    for (const [dataset, compatibleTypes] of Object.entries(allowed)) {
      for (const subjectType of subjectTypes) {
        const insertion = client.unsafe(`
          insert into system_retention_holds
            (dataset, subject_type, subject_id, reason_category, reference_id,
             starts_at, released_at, created_at)
          values ('${dataset}', '${subjectType}',
            'task9-compatibility-${dataset}-${subjectType}', 'incident',
            'task9-ref-compatibility-${dataset}-${subjectType}',
            '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z',
            '2025-01-01T00:00:00Z')
        `);
        if ((compatibleTypes as readonly string[]).includes(subjectType)) {
          await expect(insertion).resolves.toBeDefined();
        } else {
          await expect(insertion).rejects.toThrow();
        }
      }
    }
  });

  test("retention holds are append-only and may be released exactly once", async () => {
    // Break caught: hold evidence being rewritten, deleted, reactivated, or
    // released more than once after creation.
    const [hold] = await client<{ id: string }[]>`
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id,
         starts_at, created_at)
      values ('sessions', 'user', 'task9-lifecycle-user', 'incident',
        'task9-ref-lifecycle', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
      returning id
    `;
    expect(hold?.id).toMatch(/^[0-9a-f-]{36}$/);

    const immutableRewrites = [
      `id = '71000000-0000-4000-8000-000000000001'`,
      `dataset = 'verifications'`,
      `subject_type = 'session'`,
      `subject_id = 'task9-lifecycle-rewritten'`,
      `reason_category = 'legal'`,
      `reference_id = 'task9-ref-lifecycle-rewritten'`,
      `starts_at = '2025-01-01T01:00:00Z'`,
      `created_at = '2025-01-01T01:00:00Z'`,
    ];
    for (const rewrite of immutableRewrites) {
      await expect(
        client.unsafe(`update system_retention_holds set ${rewrite} where id = '${hold?.id}'`),
      ).rejects.toThrow("retention hold records are append-only");
    }

    await expect(client.unsafe(`
      update system_retention_holds
      set released_at = '2025-01-02T00:00:00Z'
      where id = '${hold?.id}'
    `)).resolves.toBeDefined();
    await expect(client.unsafe(`
      update system_retention_holds
      set released_at = '2025-01-03T00:00:00Z'
      where id = '${hold?.id}'
    `)).rejects.toThrow("retention hold release is final");
    await expect(client.unsafe(`
      update system_retention_holds set released_at = null where id = '${hold?.id}'
    `)).rejects.toThrow("retention hold release is final");
    await expect(client.unsafe(`
      delete from system_retention_holds where id = '${hold?.id}'
    `)).rejects.toThrow("retention hold records are append-only");
  });

  test("an uncommitted hold insertion linearizes before and blocks enforcement", async () => {
    // Break caught: enforcement counting and deleting before a pre-existing
    // uncommitted hold becomes visible.
    const now = new Date("2021-02-01T12:00:00.000Z");
    const applicationName = `task9_hold_insert_sweep_${process.pid}`;
    const holdClient = postgres(databaseUrl, { max: 1 });
    const observer = postgres(databaseUrl, { max: 1 });
    let holdTransactionOpen = false;
    let sweepPromise: ReturnType<typeof runRetentionSweep> | undefined;
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, two_factor_enabled, access_status,
         authorization_version, created_at, updated_at)
      values ('task9-concurrent-held', 'Concurrent Held', 'concurrent-held@example.test',
        'concurrent-held@example.test', false, null, null, false, 'active', 1,
        '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
    `);
    await client.unsafe(`set application_name = '${applicationName}'`);
    try {
      await holdClient.unsafe(`set search_path to "${schemaName}", public`);
      await holdClient.unsafe("begin");
      holdTransactionOpen = true;
      await holdClient.unsafe(`
        insert into system_retention_holds
          (dataset, subject_type, subject_id, reason_category, reference_id,
           starts_at, created_at)
        values ('provisional_accounts', 'user', 'task9-concurrent-held',
          'incident', 'task9-ref-concurrent-held', '2021-01-01T00:00:00Z',
          '2021-01-01T00:00:00Z')
      `);

      let sweepCompleted = false;
      sweepPromise = runRetentionSweep({
        db,
        now,
        mode: "enforce",
        policyVersion: "task9-concurrency-v1",
        enforcementPaused: false,
        batchSize: 100,
      }).then((result) => {
        sweepCompleted = true;
        return result;
      });
      await waitForAdvisoryLockWait(observer, applicationName);
      expect(sweepCompleted).toBe(false);

      await holdClient.unsafe("commit");
      holdTransactionOpen = false;
      const result = await sweepPromise;
      expect(result.find((item) => item.dataset === "provisional_accounts")).toEqual(
        expect.objectContaining({ candidateCount: 1, protectedCount: 1, processedCount: 0 }),
      );
      expect(await client`select id from identity_users where id = 'task9-concurrent-held'`).toHaveLength(1);
    } finally {
      if (holdTransactionOpen) await holdClient.unsafe("rollback");
      if (sweepPromise) await sweepPromise.catch(() => undefined);
      await holdClient.end();
      await observer.end();
    }
  });

  test("an uncommitted hold release linearizes before and blocks enforcement", async () => {
    // Break caught: release becoming invisible to a sweep that races past its
    // uncommitted lifecycle transition.
    const now = new Date("2019-02-01T12:00:00.000Z");
    const applicationName = `task9_hold_release_sweep_${process.pid}`;
    const releaseClient = postgres(databaseUrl, { max: 1 });
    const observer = postgres(databaseUrl, { max: 1 });
    let releaseTransactionOpen = false;
    let sweepPromise: ReturnType<typeof runRetentionSweep> | undefined;
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, two_factor_enabled, access_status,
         authorization_version, created_at, updated_at)
      values ('task9-concurrent-released', 'Concurrent Released',
        'concurrent-released@example.test', 'concurrent-released@example.test',
        false, null, null, false, 'active', 1,
        '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z');
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id,
         starts_at, created_at)
      values ('provisional_accounts', 'user', 'task9-concurrent-released',
        'incident', 'task9-ref-concurrent-released', '2019-01-01T00:00:00Z',
        '2019-01-01T00:00:00Z')
    `);
    await client.unsafe(`set application_name = '${applicationName}'`);
    try {
      await releaseClient.unsafe(`set search_path to "${schemaName}", public`);
      await releaseClient.unsafe("begin");
      releaseTransactionOpen = true;
      await releaseClient.unsafe(`
        update system_retention_holds
        set released_at = '2019-01-02T00:00:00Z'
        where dataset = 'provisional_accounts'
          and subject_type = 'user'
          and subject_id = 'task9-concurrent-released'
          and released_at is null
      `);

      let sweepCompleted = false;
      sweepPromise = runRetentionSweep({
        db,
        now,
        mode: "enforce",
        policyVersion: "task9-concurrency-v1",
        enforcementPaused: false,
        batchSize: 100,
      }).then((result) => {
        sweepCompleted = true;
        return result;
      });
      await waitForAdvisoryLockWait(observer, applicationName);
      expect(sweepCompleted).toBe(false);

      await releaseClient.unsafe("commit");
      releaseTransactionOpen = false;
      const result = await sweepPromise;
      expect(result.find((item) => item.dataset === "provisional_accounts")).toEqual(
        expect.objectContaining({ candidateCount: 1, protectedCount: 0, processedCount: 1 }),
      );
      expect(await client`select id from identity_users where id = 'task9-concurrent-released'`).toHaveLength(0);
    } finally {
      if (releaseTransactionOpen) await releaseClient.unsafe("rollback");
      if (sweepPromise) await sweepPromise.catch(() => undefined);
      await releaseClient.end();
      await observer.end();
    }
  });

  test("retention protects accounts referenced by a current application or active deposit challenge", async () => {
    // Break caught: an old final application making an account eligible even
    // after that same account is reused by a reapplication or live challenge.
    const now = new Date("2024-02-01T12:00:00.000Z");
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, two_factor_enabled, access_status,
         authorization_version, created_at, updated_at)
      values
        ('task9-reapplication-owner', 'Reapplication Owner', 'reapplication@example.test',
         'reapplication@example.test', true, '2022-01-01T00:00:00Z',
         'password_email_challenge', false, 'active', 1,
         '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('task9-active-challenge-owner', 'Challenge Account Owner', 'active-challenge@example.test',
         'active-challenge@example.test', true, '2022-01-01T00:00:00Z',
         'password_email_challenge', false, 'active', 1,
         '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('task9-challenge-issuer', 'Challenge Issuer', 'challenge-issuer@example.test',
         'challenge-issuer@example.test', true, '2022-01-01T00:00:00Z',
         'password_email_challenge', false, 'active', 1,
         '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
      insert into payments_receiving_account_onboarding
        (id, onboarding_id, applicant_user_id, version, bank_bin, bank_name,
         account_number_envelope, account_holder_label_envelope, masked_suffix,
         account_fingerprint, proof_state, created_at, updated_at)
      values
        ('65000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
         'task9-reapplication-owner', 1, '970436', 'Test Bank', '{"version":1}'::jsonb,
         '{"version":1}'::jsonb, '•••• 3001',
         'hmac-sha256:v1:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
         'unverified', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('65000000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000002',
         'task9-active-challenge-owner', 1, '970436', 'Test Bank', '{"version":1}'::jsonb,
         '{"version":1}'::jsonb, '•••• 3002',
         'hmac-sha256:v1:HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
         'challenge_issued', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
      insert into creator_applications
        (id, user_id, state, version, current_revision_id, created_at, updated_at)
      values
        ('67000000-0000-4000-8000-000000000001', 'task9-reapplication-owner',
         'withdrawn', 1, null, '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('67000000-0000-4000-8000-000000000002', 'task9-active-challenge-owner',
         'withdrawn', 1, null, '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('67000000-0000-4000-8000-000000000003', 'task9-reapplication-owner',
         'draft', 1, null, '2024-01-31T00:00:00Z', '2024-01-31T00:00:00Z');
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, short_introduction,
         applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
         practice_description, content_intent, proposed_receiving_account_id,
         age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
      values
        ('68000000-0000-4000-8000-000000000001', '67000000-0000-4000-8000-000000000001',
         1, 'Reapplication artist', 'Introduction', 'reapplication@example.test',
         '{"version":1}'::jsonb, '["https://example.test/reapplication"]'::jsonb,
         'illustration', 'Practice', 'general_audience_only',
         '65000000-0000-4000-8000-000000000001', 21, '2022-01-01', '2022-01-01T00:00:00Z',
         '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('68000000-0000-4000-8000-000000000002', '67000000-0000-4000-8000-000000000002',
         1, 'Challenge artist', 'Introduction', 'active-challenge@example.test',
         '{"version":1}'::jsonb, '["https://example.test/challenge"]'::jsonb,
         'illustration', 'Practice', 'general_audience_only',
         '65000000-0000-4000-8000-000000000002', 21, '2022-01-01', '2022-01-01T00:00:00Z',
         '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('68000000-0000-4000-8000-000000000003', '67000000-0000-4000-8000-000000000003',
         1, null, null, null, null, null, null, null, null,
         '65000000-0000-4000-8000-000000000001', null, null, null,
         '2024-01-31T00:00:00Z', '2024-01-31T00:00:00Z');
      update creator_applications
      set current_revision_id = '68000000-0000-4000-8000-000000000003'
      where id = '67000000-0000-4000-8000-000000000003';
      insert into payments_verification_deposit_challenges
        (id, application_id, revision_id, account_version_id, amount_vnd,
         reference_hash, state, issued_by_owner_user_id, step_up_proof_id,
         issued_at, expires_at, created_at, updated_at)
      values
        ('69000000-0000-4000-8000-000000000001', '67000000-0000-4000-8000-000000000002',
         '68000000-0000-4000-8000-000000000002', '65000000-0000-4000-8000-000000000002',
         1000, 'sha256:v1:IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII', 'issued',
         'task9-challenge-issuer', '6a000000-0000-4000-8000-000000000001',
         '2024-01-31T12:00:00Z', '2024-02-03T12:00:00Z',
         '2024-01-31T12:00:00Z', '2024-01-31T12:00:00Z');
    `);

    const report = await runRetentionSweep({
      db,
      now,
      mode: "report_only",
      policyVersion: "task9-active-reference-v1",
      enforcementPaused: false,
      batchSize: 100,
    });
    const receivingReport = report.find((item) => item.dataset === "receiving_accounts");
    expect(receivingReport?.candidateCount).toBeGreaterThanOrEqual(2);
    expect(receivingReport?.protectedCount).toBeGreaterThanOrEqual(2);

    const enforced = await runRetentionSweep({
      db,
      now,
      mode: "enforce",
      policyVersion: "task9-active-reference-v1",
      enforcementPaused: false,
      batchSize: 100,
    });
    expect(enforced.find((item) => item.dataset === "receiving_accounts")?.processedCount).toBe(0);
    expect(await client`
      select id from payments_receiving_account_onboarding
      where id in (
        '65000000-0000-4000-8000-000000000001',
        '65000000-0000-4000-8000-000000000002'
      ) and minimized_at is null
      order by id
    `).toHaveLength(2);
  });

  test("an application transaction holding an account row linearizes before minimization", async () => {
    // Break caught: retention minimizing an account between reference validation
    // and committing the new application revision that depends on it.
    const now = new Date("2020-02-01T12:00:00.000Z");
    const applicationClient = postgres(databaseUrl, { max: 1 });
    let transactionOpen = false;
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, two_factor_enabled, access_status,
         authorization_version, created_at, updated_at)
      values ('task9-account-race-owner', 'Account Race Owner', 'account-race@example.test',
        'account-race@example.test', true, '2018-01-01T00:00:00Z',
        'password_email_challenge', false, 'active', 1,
        '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z');
      insert into payments_receiving_account_onboarding
        (id, onboarding_id, applicant_user_id, version, bank_bin, bank_name,
         account_number_envelope, account_holder_label_envelope, masked_suffix,
         account_fingerprint, proof_state, created_at, updated_at)
      values ('6b000000-0000-4000-8000-000000000001', '6c000000-0000-4000-8000-000000000001',
        'task9-account-race-owner', 1, '970436', 'Test Bank', '{"version":1}'::jsonb,
        '{"version":1}'::jsonb, '•••• 4001',
        'hmac-sha256:v1:JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
        'unverified', '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z');
      insert into creator_applications
        (id, user_id, state, version, created_at, updated_at)
      values ('6d000000-0000-4000-8000-000000000001', 'task9-account-race-owner',
        'withdrawn', 1, '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z');
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, short_introduction,
         applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
         practice_description, content_intent, proposed_receiving_account_id,
         age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
      values ('6e000000-0000-4000-8000-000000000001', '6d000000-0000-4000-8000-000000000001',
        1, 'Race artist', 'Introduction', 'account-race@example.test',
        '{"version":1}'::jsonb, '["https://example.test/race"]'::jsonb,
        'illustration', 'Practice', 'general_audience_only',
        '6b000000-0000-4000-8000-000000000001', 21, '2018-01-01', '2018-01-01T00:00:00Z',
        '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z');
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id,
         starts_at, created_at)
      values ('application_content', 'creator_application',
        '6d000000-0000-4000-8000-000000000001', 'legal',
        'task9-ref-account-race-application', '2020-01-01T00:00:00Z',
        '2020-01-01T00:00:00Z');
    `);

    try {
      await applicationClient.unsafe(`set search_path to "${schemaName}", public`);
      await applicationClient.unsafe("begin");
      transactionOpen = true;
      await applicationClient.unsafe(`
        select id from payments_receiving_account_onboarding
        where id = '6b000000-0000-4000-8000-000000000001'
          and retired_at is null and minimized_at is null
          and account_number_envelope is not null
          and account_holder_label_envelope is not null
        for update
      `);
      await applicationClient.unsafe(`
        insert into creator_applications
          (id, user_id, state, version, created_at, updated_at)
        values ('6d000000-0000-4000-8000-000000000002', 'task9-account-race-owner',
          'draft', 1, '2020-01-31T00:00:00Z', '2020-01-31T00:00:00Z');
        insert into creator_application_revisions
          (id, application_id, revision_number, proposed_receiving_account_id,
           created_at, updated_at)
        values ('6e000000-0000-4000-8000-000000000002', '6d000000-0000-4000-8000-000000000002',
          1, '6b000000-0000-4000-8000-000000000001',
          '2020-01-31T00:00:00Z', '2020-01-31T00:00:00Z');
        update creator_applications
        set current_revision_id = '6e000000-0000-4000-8000-000000000002'
        where id = '6d000000-0000-4000-8000-000000000002'
      `);

      const raced = await runRetentionSweep({
        db,
        now,
        mode: "enforce",
        policyVersion: "task9-account-race-v1",
        enforcementPaused: false,
        batchSize: 100,
      });
      expect(raced.find((item) => item.dataset === "receiving_accounts")?.processedCount).toBe(0);
      expect(await client`
        select id from payments_receiving_account_onboarding
        where id = '6b000000-0000-4000-8000-000000000001' and minimized_at is null
      `).toHaveLength(1);

      await applicationClient.unsafe("commit");
      transactionOpen = false;
      const afterCommit = await runRetentionSweep({
        db,
        now,
        mode: "enforce",
        policyVersion: "task9-account-race-v1",
        enforcementPaused: false,
        batchSize: 100,
      });
      expect(afterCommit.find((item) => item.dataset === "receiving_accounts")).toEqual(
        expect.objectContaining({ candidateCount: 1, protectedCount: 1, processedCount: 0 }),
      );
      expect(await client`
        select id from payments_receiving_account_onboarding
        where id = '6b000000-0000-4000-8000-000000000001' and minimized_at is null
      `).toHaveLength(1);
    } finally {
      if (transactionOpen) await applicationClient.unsafe("rollback");
      await applicationClient.end();
      await client`
        update creator_applications
        set updated_at = '2024-01-01T00:00:00Z'
        where id = '6d000000-0000-4000-8000-000000000001'
      `;
    }
  });

  test("retention minimizes the current account referenced by an old final application", async () => {
    // Break caught: eligibility and the binding trigger requiring retired_at even
    // though final application timing is the approved retention clock.
    const now = new Date("2023-02-01T12:00:00.000Z");
    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, two_factor_enabled, access_status,
         authorization_version, created_at, updated_at)
      values ('task9-current-account-owner', 'Current Owner', 'current-owner@example.test',
        'current-owner@example.test', true, '2022-01-01T00:00:00Z',
        'password_email_challenge', false, 'active', 1,
        '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
      insert into payments_receiving_account_onboarding
        (id, onboarding_id, applicant_user_id, version, bank_bin, bank_name,
         account_number_envelope, account_holder_label_envelope, masked_suffix,
         account_fingerprint, proof_state, created_at, updated_at)
      values ('61000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001',
        'task9-current-account-owner', 1, '970436', 'Test Bank', '{"version":1}'::jsonb,
        '{"version":1}'::jsonb, '•••• 2001',
        'hmac-sha256:v1:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        'unverified', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
      insert into creator_applications (id, user_id, state, version, created_at, updated_at)
      values ('63000000-0000-4000-8000-000000000001', 'task9-current-account-owner',
        'withdrawn', 1, '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, short_introduction,
         applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
         practice_description, content_intent, proposed_receiving_account_id,
         age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
      values ('64000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001',
        1, 'Current artist', 'Introduction', 'current-owner@example.test',
        '{"version":1}'::jsonb, '["https://example.test/current"]'::jsonb,
        'illustration', 'Practice', 'general_audience_only',
        '61000000-0000-4000-8000-000000000001', 21, '2022-01-01',
        '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id,
         starts_at, released_at, created_at)
      values
        ('receiving_accounts', 'receiving_account', '61000000-0000-4000-8000-000000000001',
         'incident', 'task9-ref-current-account-released', '2022-01-01T00:00:00Z',
         '2022-01-02T00:00:00Z', '2022-01-01T00:00:00Z'),
        ('application_content', 'creator_application', '63000000-0000-4000-8000-000000000001',
         'incident', 'task9-ref-current-application-released', '2022-01-01T00:00:00Z',
         '2022-01-02T00:00:00Z', '2022-01-01T00:00:00Z');
    `);

    const enforced = await runRetentionSweep({
      db,
      now,
      mode: "enforce",
      policyVersion: "task9-test-v1",
      enforcementPaused: false,
      batchSize: 100,
    });
    expect(enforced.find((item) => item.dataset === "receiving_accounts")).toEqual(
      expect.objectContaining({ candidateCount: 1, protectedCount: 0, processedCount: 1, outcome: "completed" }),
    );
    const [account] = await client<{
      retired_at: Date | null;
      minimized_at: Date | null;
      account_number_envelope: unknown;
      account_holder_label_envelope: unknown;
    }[]>`
      select retired_at, minimized_at, account_number_envelope, account_holder_label_envelope
      from payments_receiving_account_onboarding
      where id = '61000000-0000-4000-8000-000000000001'
    `;
    expect(account).toMatchObject({
      retired_at: null,
      account_number_envelope: null,
      account_holder_label_envelope: null,
    });
    expect(new Date(String(account?.minimized_at)).toISOString()).toBe(now.toISOString());
  });
});
