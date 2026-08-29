import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires this extensionless TypeScript schema import.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { identityUsers } from "./identity-core";

const disciplines = "'illustration','drawing','painting','comics','animation','three_d','graphic_design','photography','crafts','other'";
const handleCheck = (value: { readonly name: string }) => sql`char_length(${value}) between 3 and 30 and ${value} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`;

export const creatorPages = pgTable("creator_pages", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  draftVersion: integer("draft_version").notNull().default(1),
  publishedRevisionId: uuid("published_revision_id"),
  renameAvailableAt: timestamp("rename_available_at", { withTimezone: true, mode: "date" }),
  initializedFromRevisionId: uuid("initialized_from_revision_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  uniqueIndex("creator_pages_user_uidx").on(table.userId),
  uniqueIndex("creator_pages_published_revision_uidx").on(table.publishedRevisionId).where(sql`${table.publishedRevisionId} is not null`),
  check("creator_pages_draft_version_check", sql`${table.draftVersion} > 0`),
]);

export const creatorHandleClaims = pgTable("creator_handle_claims", {
  id: uuid("id").primaryKey(),
  pageId: uuid("page_id").notNull().references(() => creatorPages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  normalizedHandle: text("normalized_handle").notNull(),
  kind: text("kind").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).notNull(),
  replacedAt: timestamp("replaced_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("creator_handle_claims_page_idx").on(table.pageId),
  uniqueIndex("creator_handle_claims_one_canonical_page_uidx").on(table.pageId).where(sql`${table.kind} = 'canonical'`),
  uniqueIndex("creator_handle_claims_normalized_handle_uidx").on(sql`lower(${table.normalizedHandle})`),
  check("creator_handle_claims_kind_check", sql`${table.kind} in ('canonical','alias')`),
  check("creator_handle_claims_normalized_handle_check", handleCheck(table.normalizedHandle)),
  check("creator_handle_claims_replaced_check", sql`(${table.kind} = 'canonical' and ${table.replacedAt} is null) or (${table.kind} = 'alias' and ${table.replacedAt} is not null)`),
]);

export const creatorPageDrafts = pgTable("creator_page_drafts", {
  pageId: uuid("page_id").primaryKey().references(() => creatorPages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  displayName: text("display_name").notNull(),
  shortIntroduction: text("short_introduction").notNull(),
  primaryDiscipline: text("primary_discipline").notNull(),
  secondaryDisciplines: text("secondary_disciplines").array().notNull().default(sql`'{}'::text[]`),
  avatarAssetId: uuid("avatar_asset_id"),
  coverAssetId: uuid("cover_asset_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  check("creator_page_drafts_display_name_check", sql`char_length(${table.displayName}) between 1 and 80`),
  check("creator_page_drafts_short_introduction_check", sql`char_length(${table.shortIntroduction}) between 1 and 500`),
  check("creator_page_drafts_primary_discipline_check", sql`${table.primaryDiscipline} in (${sql.raw(disciplines)})`),
  check("creator_page_drafts_secondary_disciplines_check", sql`cardinality(${table.secondaryDisciplines}) between 0 and 2 and ${table.secondaryDisciplines} <@ ARRAY[${sql.raw(disciplines)}]::text[] and array_position(${table.secondaryDisciplines}, ${table.primaryDiscipline}) is null`),
]);

export const creatorShowcaseDrafts = pgTable("creator_showcase_drafts", {
  id: uuid("id").primaryKey(),
  pageId: uuid("page_id").notNull().references(() => creatorPages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  discipline: text("discipline").notNull(),
  contentLabel: text("content_label").notNull().default("general_audience"),
  externalUrl: text("external_url"),
  removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  index("creator_showcase_drafts_page_idx").on(table.pageId, table.position),
  uniqueIndex("creator_showcase_drafts_active_position_uidx").on(table.pageId, table.position).where(sql`${table.removedAt} is null`),
  check("creator_showcase_drafts_position_check", sql`${table.position} between 0 and 11`),
  check("creator_showcase_drafts_title_check", sql`char_length(${table.title}) between 1 and 100`),
  check("creator_showcase_drafts_description_check", sql`char_length(${table.description}) between 0 and 1000`),
  check("creator_showcase_drafts_discipline_check", sql`${table.discipline} in (${sql.raw(disciplines)})`),
  check("creator_showcase_drafts_content_label_check", sql`${table.contentLabel} = 'general_audience'`),
]);

export const creatorShowcaseDraftMedia = pgTable("creator_showcase_draft_media", {
  id: uuid("id").primaryKey(),
  showcaseId: uuid("showcase_id").notNull().references(() => creatorShowcaseDrafts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  assetId: uuid("asset_id").notNull(),
  position: integer("position").notNull(),
  alternativeText: text("alternative_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  uniqueIndex("creator_showcase_draft_media_position_uidx").on(table.showcaseId, table.position),
  check("creator_showcase_draft_media_position_check", sql`${table.position} between 0 and 3`),
  check("creator_showcase_draft_media_alternative_text_check", sql`char_length(${table.alternativeText}) between 1 and 300`),
]);

export const creatorPublicationRevisions = pgTable("creator_publication_revisions", {
  id: uuid("id").primaryKey(),
  pageId: uuid("page_id").notNull().references(() => creatorPages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  canonicalHandle: text("canonical_handle").notNull(),
  displayName: text("display_name").notNull(),
  shortIntroduction: text("short_introduction").notNull(),
  primaryDiscipline: text("primary_discipline").notNull(),
  secondaryDisciplines: text("secondary_disciplines").array().notNull(),
  avatarAssetId: uuid("avatar_asset_id"),
  avatarThumbDerivativeId: uuid("avatar_thumb_derivative_id"),
  avatarDisplayDerivativeId: uuid("avatar_display_derivative_id"),
  coverAssetId: uuid("cover_asset_id"),
  coverDisplayDerivativeId: uuid("cover_display_derivative_id"),
  taxonomyVersion: text("taxonomy_version").notNull().default("v1"),
  policyVersion: text("policy_version").notNull().default("general_audience.v1"),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id").notNull(),
  expectedDraftVersion: integer("expected_draft_version").notNull(),
  requestId: text("request_id").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  uniqueIndex("creator_publication_revisions_number_uidx").on(table.pageId, table.revisionNumber),
  uniqueIndex("creator_publication_revisions_id_page_uidx").on(table.id, table.pageId),
  index("creator_publication_revisions_page_idx").on(table.pageId, table.publishedAt),
  check("creator_publication_revisions_number_check", sql`${table.revisionNumber} > 0`),
  check("creator_publication_revisions_canonical_handle_check", handleCheck(table.canonicalHandle)),
  check("creator_publication_revisions_display_name_check", sql`char_length(${table.displayName}) between 1 and 80`),
  check("creator_publication_revisions_short_introduction_check", sql`char_length(${table.shortIntroduction}) between 1 and 500`),
  check("creator_publication_revisions_primary_discipline_check", sql`${table.primaryDiscipline} in (${sql.raw(disciplines)})`),
  check("creator_publication_revisions_secondary_disciplines_check", sql`cardinality(${table.secondaryDisciplines}) between 0 and 2 and ${table.secondaryDisciplines} <@ ARRAY[${sql.raw(disciplines)}]::text[] and array_position(${table.secondaryDisciplines}, ${table.primaryDiscipline}) is null`),
  check("creator_publication_revisions_policy_check", sql`${table.taxonomyVersion} = 'v1' and ${table.policyVersion} = 'general_audience.v1'`),
  check("creator_publication_revisions_expected_draft_version_check", sql`${table.expectedDraftVersion} > 0`),
]);

export const creatorPublicationShowcases = pgTable("creator_publication_showcases", {
  id: uuid("id").primaryKey(),
  revisionId: uuid("revision_id").notNull().references(() => creatorPublicationRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  sourceShowcaseId: uuid("source_showcase_id").notNull(),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  discipline: text("discipline").notNull(),
  contentLabel: text("content_label").notNull(),
  externalUrl: text("external_url"),
}, (table) => [
  uniqueIndex("creator_publication_showcases_position_uidx").on(table.revisionId, table.position),
  check("creator_publication_showcases_position_check", sql`${table.position} between 0 and 11`),
  check("creator_publication_showcases_title_check", sql`char_length(${table.title}) between 1 and 100`),
  check("creator_publication_showcases_description_check", sql`char_length(${table.description}) between 0 and 1000`),
  check("creator_publication_showcases_discipline_check", sql`${table.discipline} in (${sql.raw(disciplines)})`),
  check("creator_publication_showcases_content_label_check", sql`${table.contentLabel} = 'general_audience'`),
]);

export const creatorPublicationMedia = pgTable("creator_publication_media", {
  id: uuid("id").primaryKey(),
  publicationShowcaseId: uuid("publication_showcase_id").notNull().references(() => creatorPublicationShowcases.id, { onDelete: "restrict", onUpdate: "restrict" }),
  assetId: uuid("asset_id").notNull(),
  position: integer("position").notNull(),
  alternativeText: text("alternative_text").notNull(),
  thumbDerivativeId: uuid("thumb_derivative_id").notNull(),
  displayDerivativeId: uuid("display_derivative_id").notNull(),
  largeDerivativeId: uuid("large_derivative_id").notNull(),
}, (table) => [
  uniqueIndex("creator_publication_media_position_uidx").on(table.publicationShowcaseId, table.position),
  check("creator_publication_media_position_check", sql`${table.position} between 0 and 3`),
  check("creator_publication_media_alternative_text_check", sql`char_length(${table.alternativeText}) between 1 and 300`),
]);

export const creatorPublicationEvents = pgTable("creator_publication_events", {
  id: uuid("id").primaryKey(),
  pageId: uuid("page_id").notNull().references(() => creatorPages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionId: uuid("revision_id"),
  type: text("type").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id").notNull(),
  expectedDraftVersion: integer("expected_draft_version").notNull(),
  requestId: text("request_id").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  index("creator_publication_events_page_idx").on(table.pageId, table.occurredAt),
  check("creator_publication_events_type_check", sql`${table.type} in ('published','unpublished')`),
  check("creator_publication_events_expected_draft_version_check", sql`${table.expectedDraftVersion} > 0`),
]);

export const creatorDiscoveryProjections = pgTable("creator_discovery_projections", {
  pageId: uuid("page_id").primaryKey().references(() => creatorPages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionId: uuid("revision_id").notNull(),
  canonicalHandle: text("canonical_handle").notNull(),
  displayName: text("display_name").notNull(),
  shortIntroduction: text("short_introduction").notNull(),
  disciplines: text("disciplines").array().notNull(),
  avatarThumbDerivativeId: uuid("avatar_thumb_derivative_id"),
  revisionAt: timestamp("revision_at", { withTimezone: true, mode: "date" }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
}, (table) => [
  uniqueIndex("creator_discovery_projections_canonical_handle_uidx").on(sql`lower(${table.canonicalHandle})`),
  index("creator_discovery_projections_enabled_handle_idx").on(table.canonicalHandle, table.pageId).where(sql`${table.enabled}`),
  check("creator_discovery_projections_canonical_handle_check", handleCheck(table.canonicalHandle)),
  check("creator_discovery_projections_disciplines_check", sql`cardinality(${table.disciplines}) between 1 and 3 and ${table.disciplines} <@ ARRAY[${sql.raw(disciplines)}]::text[]`),
]);
