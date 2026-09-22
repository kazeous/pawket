import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";

export const PLATFORM_TIP_POLICY_BOOTSTRAP_ID = "00000000-0000-4000-8000-000000000001";
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const platformTipPolicyRevisions = pgTable("platform_tip_policy_revisions", {
  id: uuid("id").primaryKey(),
  revisionNumber: integer("revision_number").notNull(),
  previousRevisionId: uuid("previous_revision_id"),
  minimumVnd: bigint("minimum_vnd", { mode: "number" }).notNull(),
  maximumVnd: bigint("maximum_vnd", { mode: "number" }).notNull(),
  allowedPresetsVnd: integer("allowed_presets_vnd").array().notNull(),
  origin: text("origin").$type<"system_bootstrap" | "owner">().notNull(),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id"),
  requestId: text("request_id"),
  reason: text("reason").notNull(),
  effectiveAt: time("effective_at").notNull(),
}, (table) => [
  uniqueIndex("platform_tip_policy_number_uidx").on(table.revisionNumber),
  foreignKey({ name: "platform_tip_policy_previous_fk", columns: [table.previousRevisionId], foreignColumns: [table.id] }).onDelete("restrict").onUpdate("restrict"),
  check("platform_tip_policy_bounds_check", sql`${table.minimumVnd} >= 10000 and ${table.maximumVnd} <= 5000000 and ${table.maximumVnd} >= ${table.minimumVnd}`),
  check("platform_tip_policy_presets_check", sql`platform_tip_policy_presets_valid(${table.allowedPresetsVnd}, ${table.minimumVnd}, ${table.maximumVnd})`),
  check("platform_tip_policy_origin_check", sql`(${table.origin} = 'system_bootstrap' and ${table.revisionNumber} = 1 and ${table.previousRevisionId} is null and ${table.actorUserId} is null and ${table.actorSessionId} is null and ${table.requestId} is null)
    or (${table.origin} = 'owner' and ${table.revisionNumber} > 1 and ${table.previousRevisionId} is not null and ${table.actorUserId} is not null and ${table.actorSessionId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and ${table.requestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')`),
  check("platform_tip_policy_owner_evidence_check", sql`${table.origin} <> 'owner' or (${table.actorSessionId} is not null and ${table.requestId} is not null)`),
  check("platform_tip_policy_reason_check", sql`char_length(${table.reason}) between 3 and 500 and ${table.reason} = btrim(${table.reason}) and ${table.reason} !~ '[[:cntrl:]]'`),
]);

export const platformTipPolicyCurrent = pgTable("platform_tip_policy_current", {
  singleton: boolean("singleton").primaryKey().default(true),
  revisionId: uuid("revision_id").notNull().references(() => platformTipPolicyRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  updatedAt: time("updated_at").notNull(),
}, (table) => [check("platform_tip_policy_singleton_check", sql`${table.singleton} = true`)]);
