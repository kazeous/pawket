import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Exactly one shared budget per isolated provider environment, never per event/IP.
export const paymentsSepayProviderBudgets = pgTable("payments_sepay_provider_budgets", {
  environment: text("environment").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" }).notNull(),
  requestCount: integer("request_count").notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  check("sepay_budget_environment_check", sql`${table.environment} in ('test','live')`),
  check("sepay_budget_count_check", sql`${table.requestCount} between 0 and 30`),
  check("sepay_budget_time_check", sql`${table.updatedAt} >= ${table.windowStartedAt}`),
]);
