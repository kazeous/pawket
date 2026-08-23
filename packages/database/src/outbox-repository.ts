import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { PawketDatabase } from "./client.js";
import { systemOutbox } from "./schema.js";

export type NewOutboxEvent = {
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
  availableAt?: Date;
};

export type OutboxEvent = NewOutboxEvent & {
  id: string;
  occurredAt: Date;
  availableAt: Date;
  attempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  leaseExpiresAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
};

type OutboxInsertTransaction = Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0];

type OutboxDatabaseRow = {
  id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  available_at: Date | string;
  attempts: number;
  locked_at: Date | string | null;
  locked_by: string | null;
  lease_expires_at: Date | string | null;
  published_at: Date | string | null;
  last_error: string | null;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asOptionalDate(value: Date | string | null): Date | null {
  return value === null ? null : asDate(value);
}

function mapOutboxRow(row: OutboxDatabaseRow): OutboxEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    occurredAt: asDate(row.occurred_at),
    availableAt: asDate(row.available_at),
    attempts: row.attempts,
    lockedAt: asOptionalDate(row.locked_at),
    lockedBy: row.locked_by,
    leaseExpiresAt: asOptionalDate(row.lease_expires_at),
    publishedAt: asOptionalDate(row.published_at),
    lastError: row.last_error,
  };
}

export async function insertOutboxEvent(
  tx: OutboxInsertTransaction,
  event: NewOutboxEvent,
): Promise<string> {
  const occurredAt = event.occurredAt ?? new Date();
  const [inserted] = await tx
    .insert(systemOutbox)
    .values({
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      occurredAt,
      availableAt: event.availableAt ?? occurredAt,
    })
    .returning({ id: systemOutbox.id });

  if (!inserted) {
    throw new Error("Failed to insert outbox event");
  }

  return inserted.id;
}

export async function claimOutboxBatch(
  db: PawketDatabase,
  input: { workerId: string; limit: number; leaseMs: number; now?: Date },
): Promise<OutboxEvent[]> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  const nowValue = now.toISOString();
  const leaseExpiresAtValue = leaseExpiresAt.toISOString();

  return db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxDatabaseRow>(sql`
      with candidates as (
        select id
        from system_outbox
        where published_at is null
          and available_at <= ${nowValue}::timestamptz
          and (
            (locked_at is null and lease_expires_at is null)
            or lease_expires_at <= ${nowValue}::timestamptz
          )
        order by occurred_at, id
        for update skip locked
        limit ${input.limit}
      )
      update system_outbox as event
      set locked_at = ${nowValue}::timestamptz,
          locked_by = ${input.workerId},
          lease_expires_at = ${leaseExpiresAtValue}::timestamptz,
          attempts = event.attempts + 1
      from candidates
      where event.id = candidates.id
      returning event.*
    `);

    return rows.map(mapOutboxRow);
  });
}

export async function markOutboxPublished(
  db: PawketDatabase,
  input: { eventId: string; workerId: string; publishedAt?: Date },
): Promise<boolean> {
  const updated = await db
    .update(systemOutbox)
    .set({
      publishedAt: input.publishedAt ?? new Date(),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(systemOutbox.id, input.eventId),
        eq(systemOutbox.lockedBy, input.workerId),
        isNull(systemOutbox.publishedAt),
      ),
    )
    .returning({ id: systemOutbox.id });

  return updated.length === 1;
}

export async function markOutboxFailed(
  db: PawketDatabase,
  input: { eventId: string; workerId: string; error: string; nextAttemptAt: Date },
): Promise<boolean> {
  const updated = await db
    .update(systemOutbox)
    .set({
      availableAt: input.nextAttemptAt,
      lastError: input.error.slice(0, 2_000),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(systemOutbox.id, input.eventId),
        eq(systemOutbox.lockedBy, input.workerId),
        isNull(systemOutbox.publishedAt),
      ),
    )
    .returning({ id: systemOutbox.id });

  return updated.length === 1;
}

export async function releaseExpiredOutboxLeases(
  db: PawketDatabase,
  now: Date = new Date(),
): Promise<number> {
  const released = await db
    .update(systemOutbox)
    .set({ lockedAt: null, lockedBy: null, leaseExpiresAt: null })
    .where(
      and(
        isNull(systemOutbox.publishedAt),
        isNotNull(systemOutbox.leaseExpiresAt),
        lte(systemOutbox.leaseExpiresAt, now),
      ),
    )
    .returning({ id: systemOutbox.id });

  return released.length;
}
