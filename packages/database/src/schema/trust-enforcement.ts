import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";

type TrustPolicyKind = "community_rules" | "enforcement_appeals";
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const trustEnforcementPauses = pgTable("trust_enforcement_pauses", {
  id: uuid("id").primaryKey(), startedAt: time("started_at").notNull(), endedAt: time("ended_at"), version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("trust_enforcement_pauses_open_uidx").on(sql`(true)`).where(sql`${t.endedAt} is null`),
  check("trust_enforcement_pauses_time_check", sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  check("trust_enforcement_pauses_version_check", sql`${t.version} > 0`),
]);

export const trustPolicyRevisions = pgTable("trust_policy_revisions", {
  id: uuid("id").primaryKey(), kind: text("kind").$type<TrustPolicyKind>().notNull(), revisionNumber: integer("revision_number").notNull(),
  document: text("document").notNull(), approvalKind: text("approval_kind").$type<"synthetic" | "owner_reviewed">().notNull(),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id"), checksum: text("checksum").notNull(), source: text("source").notNull(),
  effectiveAt: time("effective_at").notNull(), createdAt: time("created_at").notNull(),
}, (t) => [
  uniqueIndex("trust_policy_revisions_kind_number_uidx").on(t.kind, t.revisionNumber),
  check("trust_policy_revisions_kind_check", sql`${t.kind} in ('community_rules', 'enforcement_appeals')`),
  check("trust_policy_revisions_number_check", sql`${t.revisionNumber} > 0`),
  check("trust_policy_revisions_document_check", sql`char_length(${t.document}) between 1 and 16000
    and ${t.document} = normalize(${t.document}, NFC) and replace(${t.document}, chr(10), '') !~ '[[:cntrl:]]'`),
  check("trust_policy_revisions_approval_check", sql`(${t.approvalKind} = 'synthetic' and ${t.actorUserId} is null and ${t.actorSessionId} is null)
    or (${t.approvalKind} = 'owner_reviewed' and ${t.actorUserId} is not null and ${t.actorSessionId} is not null)`),
  check("trust_policy_revisions_checksum_check", sql`${t.checksum} ~ '^sha256:[a-f0-9]{64}$'`),
  check("trust_policy_revisions_source_check", sql`char_length(${t.source}) between 1 and 200`),
]);

export const trustPolicyCurrent = pgTable("trust_policy_current", {
  kind: text("kind").$type<TrustPolicyKind>().primaryKey(),
  revisionId: uuid("revision_id").notNull().references(() => trustPolicyRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  updatedAt: time("updated_at").notNull(),
}, (t) => [check("trust_policy_current_kind_check", sql`${t.kind} in ('community_rules', 'enforcement_appeals')`)]);
