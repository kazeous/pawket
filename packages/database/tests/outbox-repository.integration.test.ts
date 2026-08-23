import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  claimOutboxBatch,
  createDatabase,
  insertOutboxEvent,
  markOutboxFailed,
  markOutboxPublished,
  releaseExpiredOutboxLeases,
  systemOutbox,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const connection = createDatabase(databaseUrl);
const { db } = connection;

async function insertEvent(overrides: Partial<Parameters<typeof insertOutboxEvent>[1]> = {}) {
  return db.transaction((tx) =>
    insertOutboxEvent(tx, {
      eventType: "commission.created",
      eventVersion: 1,
      aggregateType: "commission",
      aggregateId: "commission-123",
      payload: { artistId: "artist-456", amount: 125_000 },
      ...overrides,
    }),
  );
}

describe("transactional outbox repository", () => {
  beforeAll(async () => {
    await db.execute(sql`
      create table if not exists test_outbox_business_records (
        id text primary key,
        value text not null
      )
    `);
  });

  afterEach(async () => {
    await db.execute(sql`delete from system_outbox`);
    await db.execute(sql`delete from test_outbox_business_records`);
  });

  afterAll(async () => {
    await db.execute(sql`drop table if exists test_outbox_business_records`);
    await connection.close();
  });

  test("inserted event preserves type, version, aggregate, payload, and timestamps", async () => {
    const occurredAt = new Date("2026-08-23T08:10:11.123Z");
    const availableAt = new Date("2026-08-23T08:15:00.456Z");
    const payload = { artistId: "artist-456", nested: { amount: 125_000 } };

    const eventId = await insertEvent({
      eventType: "commission.accepted",
      eventVersion: 2,
      aggregateType: "commission",
      aggregateId: "commission-789",
      payload,
      occurredAt,
      availableAt,
    });

    const rows = await db.select().from(systemOutbox).where(eq(systemOutbox.id, eventId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: eventId,
        eventType: "commission.accepted",
        eventVersion: 2,
        aggregateType: "commission",
        aggregateId: "commission-789",
        payload,
        occurredAt,
        availableAt,
      }),
    );
  });

  test("future available_at event cannot be claimed", async () => {
    const now = new Date("2026-08-23T09:00:00.000Z");
    await insertEvent({ availableAt: new Date("2026-08-23T09:00:00.001Z") });

    const claimed = await claimOutboxBatch(db, {
      workerId: "worker-a",
      limit: 10,
      leaseMs: 30_000,
      now,
    });

    expect(claimed).toEqual([]);
  });

  test("two concurrent claimers never receive the same event", async () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        insertEvent({
          aggregateId: `commission-${index}`,
          occurredAt: new Date(now.getTime() - 1_000 + index),
          availableAt: now,
        }),
      ),
    );

    const [workerA, workerB] = await Promise.all([
      claimOutboxBatch(db, { workerId: "worker-a", limit: 6, leaseMs: 30_000, now }),
      claimOutboxBatch(db, { workerId: "worker-b", limit: 6, leaseMs: 30_000, now }),
    ]);
    const workerAIds = new Set(workerA.map((event) => event.id));
    const workerBIds = new Set(workerB.map((event) => event.id));

    expect(workerA).toHaveLength(6);
    expect(workerB).toHaveLength(6);
    expect([...workerAIds].filter((eventId) => workerBIds.has(eventId))).toEqual([]);
  });

  test("marking published requires the current worker lease", async () => {
    const now = new Date("2026-08-23T11:00:00.000Z");
    const eventId = await insertEvent({ occurredAt: now, availableAt: now });
    await claimOutboxBatch(db, { workerId: "worker-a", limit: 1, leaseMs: 30_000, now });

    expect(
      await markOutboxPublished(db, {
        eventId,
        workerId: "worker-b",
        publishedAt: new Date("2026-08-23T11:00:01.000Z"),
      }),
    ).toBe(false);
    expect(
      await markOutboxPublished(db, {
        eventId,
        workerId: "worker-a",
        publishedAt: new Date("2026-08-23T11:00:02.000Z"),
      }),
    ).toBe(true);

    const rows = await db
      .select({
        publishedAt: systemOutbox.publishedAt,
        lockedAt: systemOutbox.lockedAt,
        lockedBy: systemOutbox.lockedBy,
        leaseExpiresAt: systemOutbox.leaseExpiresAt,
      })
      .from(systemOutbox)
      .where(eq(systemOutbox.id, eventId));
    expect(rows[0]).toEqual({
      publishedAt: new Date("2026-08-23T11:00:02.000Z"),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    });
  });

  test("failure is lease-guarded, bounded, rescheduled, and increments attempts once", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const nextAttemptAt = new Date("2026-08-23T12:05:00.000Z");
    const eventId = await insertEvent({ occurredAt: now, availableAt: now });
    await claimOutboxBatch(db, { workerId: "worker-a", limit: 1, leaseMs: 30_000, now });

    expect(
      await markOutboxFailed(db, {
        eventId,
        workerId: "worker-b",
        error: "wrong worker",
        nextAttemptAt,
      }),
    ).toBe(false);
    expect(
      await markOutboxFailed(db, {
        eventId,
        workerId: "worker-a",
        error: "x".repeat(2_500),
        nextAttemptAt,
      }),
    ).toBe(true);

    const rows = await db
      .select({
        attempts: systemOutbox.attempts,
        lastError: systemOutbox.lastError,
        availableAt: systemOutbox.availableAt,
        lockedAt: systemOutbox.lockedAt,
        lockedBy: systemOutbox.lockedBy,
        leaseExpiresAt: systemOutbox.leaseExpiresAt,
      })
      .from(systemOutbox)
      .where(eq(systemOutbox.id, eventId));
    expect(rows[0]).toEqual({
      attempts: 1,
      lastError: "x".repeat(2_000),
      availableAt: nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    });
    expect(
      await claimOutboxBatch(db, {
        workerId: "worker-c",
        limit: 1,
        leaseMs: 30_000,
        now: new Date(nextAttemptAt.getTime() - 1),
      }),
    ).toEqual([]);
    expect(
      await claimOutboxBatch(db, {
        workerId: "worker-c",
        limit: 1,
        leaseMs: 30_000,
        now: nextAttemptAt,
      }),
    ).toHaveLength(1);
  });

  test("release keeps active leases and clears them at exact expiry", async () => {
    const now = new Date("2026-08-23T13:00:00.000Z");
    await insertEvent({ occurredAt: now, availableAt: now });
    await claimOutboxBatch(db, { workerId: "worker-a", limit: 1, leaseMs: 30_000, now });

    expect(await releaseExpiredOutboxLeases(db, new Date(now.getTime() + 1))).toBe(0);
    expect(await releaseExpiredOutboxLeases(db, new Date(now.getTime() + 30_000))).toBe(1);
  });

  test("claim-time recovery honors in-lease, exact-expiry, and just-after-expiry boundaries", async () => {
    const now = new Date("2026-08-23T13:30:00.000Z");
    const eventIds = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        insertEvent({
          aggregateId: `lease-boundary-${index}`,
          occurredAt: new Date(now.getTime() + index),
          availableAt: now,
        }),
      ),
    );
    await claimOutboxBatch(db, { workerId: "worker-a", limit: 3, leaseMs: 30_000, now });

    expect(
      await claimOutboxBatch(db, {
        workerId: "worker-b",
        limit: 3,
        leaseMs: 30_000,
        now: new Date(now.getTime() + 29_999),
      }),
    ).toEqual([]);

    const atExactExpiry = await claimOutboxBatch(db, {
      workerId: "worker-b",
      limit: 1,
      leaseMs: 30_000,
      now: new Date(now.getTime() + 30_000),
    });
    const justAfterExpiry = await claimOutboxBatch(db, {
      workerId: "worker-c",
      limit: 3,
      leaseMs: 30_000,
      now: new Date(now.getTime() + 30_001),
    });

    expect(atExactExpiry).toHaveLength(1);
    expect(justAfterExpiry).toHaveLength(2);
    expect(atExactExpiry[0]?.lockedAt).toEqual(new Date(now.getTime() + 30_000));
    expect(atExactExpiry[0]?.leaseExpiresAt).toEqual(new Date(now.getTime() + 60_000));
    expect(new Set([...atExactExpiry, ...justAfterExpiry].map((event) => event.id))).toEqual(
      new Set(eventIds),
    );
    expect([...atExactExpiry, ...justAfterExpiry].every((event) => event.attempts === 2)).toBe(
      true,
    );
  });

  test("caller transaction rollback removes both business and outbox rows", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into test_outbox_business_records (id, value)
          values ('business-1', 'created')
        `);
        await insertOutboxEvent(tx, {
          eventType: "business.created",
          eventVersion: 1,
          aggregateType: "business",
          aggregateId: "business-1",
          payload: { value: "created" },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const businessRows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from test_outbox_business_records`,
    );
    const outboxRows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from system_outbox`,
    );
    expect(businessRows[0]?.count).toBe("0");
    expect(outboxRows[0]?.count).toBe("0");
  });
});
