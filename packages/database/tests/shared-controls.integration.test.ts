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
  insertOutboxEvent,
  systemBusinessCalendarHolidays,
  systemBusinessCalendarVersions,
  systemCommandIdempotency,
  systemOutbox,
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
});
