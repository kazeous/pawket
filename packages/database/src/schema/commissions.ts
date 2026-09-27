import { sql, type SQLWrapper } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { EncryptionEnvelope } from "@pawket/security";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { creatorPages } from "./creator-catalog";

export const COMMISSION_POLICY_BOOTSTRAP_ID = "00000000-0000-4000-8000-000000000006";
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const vnd = (name: string) => bigint(name, { mode: "number" });
const routeCheck = (column: SQLWrapper) => sql`${column} in ('fixed_immediate','fixed_approval','custom_quote')`;
const envelopeCheck = (column: SQLWrapper) => sql`coalesce(
  jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= 24000
  and ${column}->'version' = '1'::jsonb and ${column}->>'algorithm' = 'A256GCM'
  and jsonb_typeof(${column}->'keyId') = 'string' and ${column}->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and ${column}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and ${column}->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and ${column}->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and ${column} - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)`;

export type CommissionPublicTerms = Readonly<{
  amountVnd: number; turnaroundDays: number; revisionAllowance: number; reviewWindowDays: number;
  scope: string; deliverables: string; usageRights: string; artistTerms: string; policyRevisionId: string;
}>;
export type CommissionDraftDocument = Readonly<{
  title: string; description: string; discipline: string;
  route: "fixed_immediate" | "fixed_approval" | "custom_quote";
  briefInstructions: string; terms: CommissionPublicTerms | null; showcaseId: string | null;
}>;

export const commissionPolicyRevisions = pgTable("commission_policy_revisions", {
  id: uuid("id").primaryKey(),
  revisionNumber: integer("revision_number").notNull(),
  technicalVersion: text("technical_version").notNull().default("commission-v1"),
  minimumVnd: vnd("minimum_vnd").notNull().default(50_000),
  maximumVnd: vnd("maximum_vnd").notNull().default(50_000_000),
  document: text("document"),
  approvalKind: text("approval_kind").notNull().default("technical_only"),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, { onDelete: "restrict" }),
  actorSessionId: text("actor_session_id"),
  source: text("source").notNull(),
  checksum: text("checksum").notNull(),
  effectiveAt: time("effective_at").notNull(),
  createdAt: time("created_at").notNull(),
}, (t) => [
  uniqueIndex("commission_policy_number_uidx").on(t.revisionNumber),
  check("commission_policy_version_check", sql`${t.revisionNumber} > 0 and ${t.technicalVersion} = 'commission-v1'`),
  check("commission_policy_amount_check", sql`${t.minimumVnd} = 50000 and ${t.maximumVnd} = 50000000`),
  check("commission_policy_approval_check", sql`coalesce(
    (${t.approvalKind} = 'technical_only' and ${t.document} is null and ${t.actorUserId} is null and ${t.actorSessionId} is null)
    or (${t.approvalKind} = 'synthetic' and char_length(${t.document}) between 1 and 16000 and ${t.actorUserId} is null and ${t.actorSessionId} is null)
    or (${t.approvalKind} = 'owner_reviewed' and char_length(${t.document}) between 1 and 16000 and ${t.actorUserId} is not null and ${t.actorSessionId} is not null), false)`),
  check("commission_policy_checksum_check", sql`${t.checksum} ~ '^sha256:[a-f0-9]{64}$' and char_length(${t.source}) between 1 and 200`),
]);

export const commissionPolicyCurrent = pgTable("commission_policy_current", {
  singleton: boolean("singleton").primaryKey().default(true),
  revisionId: uuid("revision_id").notNull().references(() => commissionPolicyRevisions.id, { onDelete: "restrict" }),
  updatedAt: time("updated_at").notNull(),
}, (t) => [check("commission_policy_singleton_check", sql`${t.singleton} = true`)]);

export const creatorCommissionSettings = pgTable("creator_commission_settings", {
  creatorUserId: text("creator_user_id").primaryKey().references(() => identityUsers.id, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(false),
  capacityLimit: integer("capacity_limit").notNull().default(3),
  version: integer("version").notNull().default(1),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (t) => [
  check("creator_commission_capacity_check", sql`${t.capacityLimit} between 1 and 20 and ${t.version} > 0`),
  check("creator_commission_settings_time_check", sql`${t.updatedAt} >= ${t.createdAt}`),
]);

export const commissionPackages = pgTable("commission_packages", {
  id: uuid("id").primaryKey(),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  pageId: uuid("page_id").notNull().references(() => creatorPages.id, { onDelete: "restrict" }),
  draft: jsonb("draft").$type<CommissionDraftDocument>().notNull(),
  state: text("state").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  publishedRevisionId: uuid("published_revision_id").references((): AnyPgColumn => commissionPackageRevisions.id, { onDelete: "restrict" }),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (t) => [
  uniqueIndex("commission_packages_owner_uidx").on(t.id, t.creatorUserId),
  index("commission_packages_creator_idx").on(t.creatorUserId, t.createdAt, t.id),
  check("commission_packages_state_check", sql`${t.state} in ('draft','open','paused','archived') and ${t.version} > 0`),
  check("commission_packages_draft_check", sql`jsonb_typeof(${t.draft}) = 'object' and octet_length(${t.draft}::text) <= 65536`),
  check("commission_packages_publication_check", sql`(${t.state} not in ('open','paused') or ${t.publishedRevisionId} is not null) and (${t.state} <> 'draft' or ${t.publishedRevisionId} is null)`),
  check("commission_packages_time_check", sql`${t.updatedAt} >= ${t.createdAt}`),
]);

export const commissionPackageRevisions = pgTable("commission_package_revisions", {
  id: uuid("id").primaryKey(),
  packageId: uuid("package_id").notNull(),
  creatorUserId: text("creator_user_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  policyRevisionId: uuid("policy_revision_id").notNull().references(() => commissionPolicyRevisions.id, { onDelete: "restrict" }),
  route: text("route").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  discipline: text("discipline").notNull(),
  briefInstructions: text("brief_instructions").notNull(),
  terms: jsonb("terms").$type<CommissionPublicTerms>(),
  showcaseId: uuid("showcase_id"),
  actorSessionId: text("actor_session_id").notNull(),
  requestId: text("request_id").notNull(),
  publishedAt: time("published_at").notNull(),
}, (t) => [
  foreignKey({ name: "commission_package_revision_owner_fk", columns: [t.packageId, t.creatorUserId], foreignColumns: [commissionPackages.id, commissionPackages.creatorUserId] }).onDelete("restrict"),
  uniqueIndex("commission_package_revision_number_uidx").on(t.packageId, t.revisionNumber),
  uniqueIndex("commission_package_revision_binding_uidx").on(t.id, t.packageId, t.creatorUserId),
  check("commission_package_revision_route_check", routeCheck(t.route)),
  check("commission_package_revision_text_check", sql`char_length(${t.title}) between 1 and 100 and char_length(${t.description}) <= 2000 and char_length(${t.briefInstructions}) <= 2000 and ${t.revisionNumber} > 0`),
  check("commission_package_revision_terms_check", sql`(${t.route} = 'custom_quote' and ${t.terms} is null) or (${t.route} <> 'custom_quote' and ${t.terms} is not null and jsonb_typeof(${t.terms}) = 'object' and octet_length(${t.terms}::text) <= 48000)`),
]);

export const commissionOrders = pgTable("commission_orders", {
  id: uuid("id").primaryKey(),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  buyerUserId: text("buyer_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  packageId: uuid("package_id").notNull(),
  packageRevisionId: uuid("package_revision_id").notNull(),
  route: text("route").notNull(),
  state: text("state").notNull().default("requested"),
  version: integer("version").notNull().default(1),
  amountVnd: vnd("amount_vnd"),
  currentQuoteId: uuid("current_quote_id").references((): AnyPgColumn => commissionQuoteRevisions.id, { onDelete: "restrict" }),
  expiresAt: time("expires_at"),
  acceptedAt: time("accepted_at"),
  confirmedAt: time("confirmed_at"),
  dueAt: time("due_at"),
  closedAt: time("closed_at"),
  closeReason: text("close_reason"),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (t) => [
  foreignKey({ name: "commission_order_package_binding_fk", columns: [t.packageRevisionId, t.packageId, t.creatorUserId], foreignColumns: [commissionPackageRevisions.id, commissionPackageRevisions.packageId, commissionPackageRevisions.creatorUserId] }).onDelete("restrict"),
  uniqueIndex("commission_order_payment_binding_uidx").on(t.id, t.creatorUserId, t.amountVnd),
  uniqueIndex("commission_order_actor_binding_uidx").on(t.id, t.creatorUserId, t.buyerUserId),
  index("commission_orders_buyer_idx").on(t.buyerUserId, t.createdAt, t.id),
  index("commission_orders_creator_idx").on(t.creatorUserId, t.state, t.createdAt, t.id),
  index("commission_orders_expiry_idx").on(t.expiresAt, t.id).where(sql`${t.state} in ('requested','quoted','awaiting_payment')`),
  check("commission_orders_actor_check", sql`${t.creatorUserId} <> ${t.buyerUserId}`),
  check("commission_orders_route_check", routeCheck(t.route)),
  check("commission_orders_state_check", sql`${t.state} in ('requested','quoted','awaiting_payment','in_progress','closed') and ${t.version} > 0`),
  check("commission_orders_amount_check", sql`${t.amountVnd} is null or ${t.amountVnd} between 50000 and 50000000`),
  check("commission_orders_payment_state_check", sql`(${t.state} not in ('awaiting_payment','in_progress') or (${t.acceptedAt} is not null and ${t.amountVnd} is not null))
    and (${t.state} not in ('requested','quoted') or (${t.acceptedAt} is null and ${t.amountVnd} is null))
    and (${t.state} <> 'quoted' or (${t.route} = 'custom_quote' and ${t.currentQuoteId} is not null))`),
  check("commission_orders_deadline_check", sql`(${t.state} not in ('requested','quoted','awaiting_payment') or (${t.expiresAt} is not null and ${t.expiresAt} > ${t.createdAt}))
    and (${t.state} <> 'in_progress' or (${t.expiresAt} is not null and ${t.confirmedAt} < ${t.expiresAt}))`),
  check("commission_orders_completion_check", sql`coalesce((${t.state} = 'in_progress' and ${t.confirmedAt} is not null and ${t.dueAt} > ${t.confirmedAt})
    or (${t.state} <> 'in_progress' and ${t.confirmedAt} is null and ${t.dueAt} is null), false)`),
  check("commission_orders_closed_check", sql`(${t.state} = 'closed' and ${t.closedAt} is not null and ${t.closeReason} is not null
    and ${t.closeReason} in ('buyer_withdrawn','creator_declined','quote_withdrawn','quote_declined','request_expired','quote_expired','buyer_cancelled','creator_cancelled','payment_expired','security_invalidated','eligibility_invalidated'))
    or (${t.state} <> 'closed' and ${t.closedAt} is null and ${t.closeReason} is null)`),
  check("commission_orders_time_check", sql`${t.updatedAt} >= ${t.createdAt} and (${t.acceptedAt} is null or ${t.acceptedAt} between ${t.createdAt} and ${t.updatedAt})
    and (${t.confirmedAt} is null or ${t.confirmedAt} between ${t.acceptedAt} and ${t.updatedAt}) and (${t.closedAt} is null or ${t.closedAt} = ${t.updatedAt})`),
]);

export const commissionBriefs = pgTable("commission_briefs", {
  orderId: uuid("order_id").primaryKey().references(() => commissionOrders.id, { onDelete: "restrict" }),
  textEnvelope: jsonb("text_envelope").$type<EncryptionEnvelope<"commission_briefs", "text">>().notNull(),
  linksEnvelope: jsonb("links_envelope").$type<EncryptionEnvelope<"commission_briefs", "links">>().notNull(),
  buyerSessionId: text("buyer_session_id").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: time("created_at").notNull(),
}, (t) => [
  check("commission_briefs_text_check", envelopeCheck(t.textEnvelope)),
  check("commission_briefs_links_check", envelopeCheck(t.linksEnvelope)),
]);

// A new column instance is required on every table; Drizzle builders are mutable.
const privateTermsColumns = <R extends "commission_quote_revisions" | "commission_terms_snapshots">() => ({
  policyRevisionId: uuid("policy_revision_id").notNull().references(() => commissionPolicyRevisions.id, { onDelete: "restrict" }),
  amountVnd: vnd("amount_vnd").notNull(),
  turnaroundDays: integer("turnaround_days").notNull(),
  revisionAllowance: integer("revision_allowance").notNull(),
  reviewWindowDays: integer("review_window_days").notNull(),
  scopeEnvelope: jsonb("scope_envelope").$type<EncryptionEnvelope<R, "scope">>().notNull(),
  deliverablesEnvelope: jsonb("deliverables_envelope").$type<EncryptionEnvelope<R, "deliverables">>().notNull(),
  usageRightsEnvelope: jsonb("usage_rights_envelope").$type<EncryptionEnvelope<R, "usage_rights">>().notNull(),
  artistTermsEnvelope: jsonb("artist_terms_envelope").$type<EncryptionEnvelope<R, "artist_terms">>().notNull(),
});
const privateTermsChecks = (prefix: string, t: { amountVnd: SQLWrapper; turnaroundDays: SQLWrapper; revisionAllowance: SQLWrapper; reviewWindowDays: SQLWrapper; scopeEnvelope: SQLWrapper; deliverablesEnvelope: SQLWrapper; usageRightsEnvelope: SQLWrapper; artistTermsEnvelope: SQLWrapper }) => [
  check(`${prefix}_amount_check`, sql`${t.amountVnd} between 50000 and 50000000`),
  check(`${prefix}_terms_check`, sql`${t.turnaroundDays} between 1 and 90 and ${t.revisionAllowance} between 0 and 10 and ${t.reviewWindowDays} between 3 and 14`),
  check(`${prefix}_scope_check`, envelopeCheck(t.scopeEnvelope)),
  check(`${prefix}_deliverables_check`, envelopeCheck(t.deliverablesEnvelope)),
  check(`${prefix}_rights_check`, envelopeCheck(t.usageRightsEnvelope)),
  check(`${prefix}_artist_terms_check`, envelopeCheck(t.artistTermsEnvelope)),
];

export const commissionQuoteRevisions = pgTable("commission_quote_revisions", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references((): AnyPgColumn => commissionOrders.id, { onDelete: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  ...privateTermsColumns<"commission_quote_revisions">(),
  actorSessionId: text("actor_session_id").notNull(),
  requestId: text("request_id").notNull(),
  issuedAt: time("issued_at").notNull(),
  expiresAt: time("expires_at").notNull(),
}, (t) => [
  uniqueIndex("commission_quote_revision_number_uidx").on(t.orderId, t.revisionNumber),
  uniqueIndex("commission_quote_order_binding_uidx").on(t.id, t.orderId),
  check("commission_quote_time_check", sql`${t.revisionNumber} > 0 and ${t.expiresAt} >= ${t.issuedAt} + interval '1 hour' and ${t.expiresAt} <= ${t.issuedAt} + interval '14 days'`),
  ...privateTermsChecks("commission_quote", t),
]);

export const commissionTermsSnapshots = pgTable("commission_terms_snapshots", {
  orderId: uuid("order_id").primaryKey().references(() => commissionOrders.id, { onDelete: "restrict" }),
  packageRevisionId: uuid("package_revision_id").notNull().references(() => commissionPackageRevisions.id, { onDelete: "restrict" }),
  quoteRevisionId: uuid("quote_revision_id").references(() => commissionQuoteRevisions.id, { onDelete: "restrict" }),
  ...privateTermsColumns<"commission_terms_snapshots">(),
  buyerAcceptedAt: time("buyer_accepted_at").notNull(),
  creatorAcceptedAt: time("creator_accepted_at").notNull(),
  createdAt: time("created_at").notNull(),
}, (t) => [
  check("commission_snapshot_time_check", sql`${t.buyerAcceptedAt} <= ${t.createdAt} and ${t.creatorAcceptedAt} <= ${t.createdAt}`),
  ...privateTermsChecks("commission_snapshot", t),
]);

export const commissionAcceptances = pgTable("commission_acceptances", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, { onDelete: "restrict" }),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  actorSessionId: text("actor_session_id").notNull(),
  role: text("role").notNull(),
  packageRevisionId: uuid("package_revision_id").notNull().references(() => commissionPackageRevisions.id, { onDelete: "restrict" }),
  quoteRevisionId: uuid("quote_revision_id").references(() => commissionQuoteRevisions.id, { onDelete: "restrict" }),
  policyRevisionId: uuid("policy_revision_id").notNull().references(() => commissionPolicyRevisions.id, { onDelete: "restrict" }),
  requestId: text("request_id").notNull(),
  acceptedAt: time("accepted_at").notNull(),
}, (t) => [
  uniqueIndex("commission_acceptance_role_uidx").on(t.orderId, t.role),
  check("commission_acceptance_role_check", sql`${t.role} in ('buyer','creator')`),
]);

export const commissionReservations = pgTable("commission_reservations", {
  orderId: uuid("order_id").primaryKey().references(() => commissionOrders.id, { onDelete: "restrict" }),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("reserved"),
  reservedAt: time("reserved_at").notNull(),
  occupiedAt: time("occupied_at"),
  releasedAt: time("released_at"),
}, (t) => [
  index("commission_reservations_capacity_idx").on(t.creatorUserId, t.state),
  check("commission_reservations_state_check", sql`(${t.state} = 'reserved' and ${t.occupiedAt} is null and ${t.releasedAt} is null)
    or (${t.state} = 'occupied' and ${t.occupiedAt} is not null and ${t.occupiedAt} >= ${t.reservedAt} and ${t.releasedAt} is null)
    or (${t.state} = 'released' and ${t.occupiedAt} is null and ${t.releasedAt} is not null and ${t.releasedAt} >= ${t.reservedAt})`),
]);

export const commissionEvents = pgTable("commission_events", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, { onDelete: "restrict" }),
  orderVersion: integer("order_version").notNull(),
  type: text("type").notNull(),
  actorUserId: text("actor_user_id"),
  actorSessionId: text("actor_session_id"),
  reason: text("reason"),
  requestId: text("request_id").notNull(),
  occurredAt: time("occurred_at").notNull(),
}, (t) => [
  uniqueIndex("commission_events_version_uidx").on(t.orderId, t.orderVersion),
  check("commission_events_version_check", sql`${t.orderVersion} > 0`),
  check("commission_events_type_check", sql`${t.type} in ('requested','quoted','awaiting_payment','in_progress','closed')`),
]);
