import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const systemOutbox = pgTable(
  "system_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
    lockedBy: text("locked_by"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
  },
  (table) => [
    index("system_outbox_pending_idx")
      .on(table.availableAt, table.occurredAt)
      .where(sql`${table.publishedAt} is null`),
    index("system_outbox_lease_idx")
      .on(table.lockedAt)
      .where(sql`${table.publishedAt} is null`),
  ],
);
