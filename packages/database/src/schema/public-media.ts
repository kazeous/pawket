import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit resolves schema imports without emitted suffixes.
// @ts-ignore
import { identityUsers } from "./identity-core";

const purposeValues = "'avatar','cover','showcase'";
const sourceFormatValues = "'jpeg','png','webp'";
const assetStateValues = "'awaiting_upload','pending','processing','ready','failed','deleted'";
const variantValues = "'master','thumb','display','large'";

export const publicMediaAssets = pgTable(
  "public_media_assets",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    purpose: text("purpose").notNull(),
    declaredSourceFormat: text("declared_source_format").notNull(),
    state: text("state").notNull().default("awaiting_upload"),
    sourceAllocationBytes: bigint("source_allocation_bytes", { mode: "number" }).notNull(),
    sourceObjectKey: text("source_object_key").notNull(),
    sourceObjectVersionId: text("source_object_version_id"),
    sourceObjectEtag: text("source_object_etag"),
    normalizedMasterObjectKey: text("normalized_master_object_key"),
    normalizedMasterObjectVersionId: text("normalized_master_object_version_id"),
    actualSourceBytes: bigint("actual_source_bytes", { mode: "number" }),
    sourceDeletedAt: timestamp("source_deleted_at", { withTimezone: true, mode: "date" }),
    width: integer("width"),
    height: integer("height"),
    failureCode: text("failure_code"),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
    deletionReviewedAt: timestamp("deletion_reviewed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("public_media_assets_id_owner_purpose_format_uidx").on(
      table.id,
      table.ownerUserId,
      table.purpose,
      table.declaredSourceFormat,
    ),
    index("public_media_assets_owner_state_idx").on(table.ownerUserId, table.state, table.createdAt),
    index("public_media_assets_quota_idx").on(
      table.ownerUserId,
      table.state,
      table.sourceDeletedAt,
      table.sourceAllocationBytes,
    ),
    index("public_media_assets_cleanup_idx").on(table.state, table.sourceDeletedAt, table.updatedAt),
    check("public_media_assets_purpose_check", sql`${table.purpose} in (${sql.raw(purposeValues)})`),
    check(
      "public_media_assets_source_format_check",
      sql`${table.declaredSourceFormat} in (${sql.raw(sourceFormatValues)})`,
    ),
    check("public_media_assets_state_check", sql`${table.state} in (${sql.raw(assetStateValues)})`),
    check(
      "public_media_assets_allocation_check",
      sql`${table.sourceAllocationBytes} between 0 and 10485760`,
    ),
    check(
      "public_media_assets_actual_bytes_check",
      sql`${table.actualSourceBytes} is null or (${table.actualSourceBytes} between 1 and 10485760 and ${table.actualSourceBytes} <= ${table.sourceAllocationBytes})`,
    ),
    check(
      "public_media_assets_dimensions_check",
      sql`(${table.width} is null and ${table.height} is null)
        or (${table.width} between 1 and 4096 and ${table.height} between 1 and 4096 and ${table.width} * ${table.height} <= 40000000)`,
    ),
    check(
      "public_media_assets_master_identity_check",
      sql`(${table.normalizedMasterObjectKey} is null and ${table.normalizedMasterObjectVersionId} is null)
        or (${table.normalizedMasterObjectKey} is not null and ${table.normalizedMasterObjectVersionId} is not null)`,
    ),
    check(
      "public_media_assets_master_key_check",
      sql`${table.normalizedMasterObjectKey} is null or ${table.normalizedMasterObjectKey} ~ '^derivatives/[0-9a-f-]{36}/master/[A-Za-z0-9_-]+[.]webp$'`,
    ),
    check(
      "public_media_assets_master_version_check",
      sql`${table.normalizedMasterObjectVersionId} is null or public_media_opaque_storage_marker_is_valid(${table.normalizedMasterObjectVersionId})`,
    ),
    check(
      "public_media_assets_source_version_check",
      sql`(${table.sourceObjectVersionId} is null and ${table.sourceObjectEtag} is null)
        or (${table.sourceObjectVersionId} is not null and ${table.sourceObjectEtag} is not null)`,
    ),
    check(
      "public_media_assets_source_identity_check",
      sql`(${table.sourceObjectVersionId} is null and ${table.sourceObjectEtag} is null)
        or (public_media_opaque_storage_marker_is_valid(${table.sourceObjectVersionId}) and public_media_opaque_storage_marker_is_valid(${table.sourceObjectEtag}))`,
    ),
    check(
      "public_media_assets_source_pinning_check",
      sql`(${table.state} in ('pending','processing','ready','deleted') and ${table.sourceObjectVersionId} is not null and ${table.sourceObjectEtag} is not null and ${table.actualSourceBytes} is not null)
        or (${table.state} in ('awaiting_upload','failed') and ${table.sourceObjectVersionId} is null and ${table.sourceObjectEtag} is null and ${table.actualSourceBytes} is null)
        or (${table.state} = 'failed' and ${table.sourceObjectVersionId} is not null and ${table.sourceObjectEtag} is not null and ${table.actualSourceBytes} is not null)`,
    ),
    check(
      "public_media_assets_failure_check",
      sql`(${table.failureCode} is null and ${table.state} not in ('failed'))
        or (${table.failureCode} is not null and ${table.state} = 'failed')`,
    ),
    check(
      "public_media_assets_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in ('failed_validation','unsupported_format','malformed_image','dimensions_exceeded','output_too_large','storage_error','processing_error','derivative_key_conflict')`,
    ),
    check(
      "public_media_assets_ready_time_check",
      sql`(${table.readyAt} is null and ${table.state} not in ('ready','deleted'))
        or (${table.readyAt} is not null and ${table.state} in ('ready','deleted') and ${table.readyAt} >= ${table.createdAt})`,
    ),
    check(
      "public_media_assets_source_cleanup_check",
      sql`${table.sourceDeletedAt} is null or ${table.state} in ('ready','failed','deleted')`,
    ),
    check(
      "public_media_assets_deletion_review_check",
      sql`(${table.deletionReviewedAt} is null and ${table.state} <> 'deleted')
        or (${table.deletionReviewedAt} is not null and ${table.state} = 'deleted')`,
    ),
    check("public_media_assets_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const publicMediaUploadIntents = pgTable(
  "public_media_upload_intents",
  {
    id: uuid("id").primaryKey(),
    assetId: uuid("asset_id").notNull().references(() => publicMediaAssets.id, { onDelete: "restrict", onUpdate: "restrict" }),
    ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
    purpose: text("purpose").notNull(),
    declaredSourceFormat: text("declared_source_format").notNull(),
    maxSourceBytes: bigint("max_source_bytes", { mode: "number" }).notNull(),
    maxSourcePixels: bigint("max_source_pixels", { mode: "number" }).notNull(),
    objectKey: text("object_key").notNull(),
    state: text("state").notNull().default("issued"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("public_media_upload_intents_asset_uidx").on(table.assetId),
    index("public_media_upload_intents_owner_expiry_idx").on(table.ownerUserId, table.expiresAt),
    index("public_media_upload_intents_expiry_idx").on(table.state, table.expiresAt),
    check("public_media_upload_intents_purpose_check", sql`${table.purpose} in (${sql.raw(purposeValues)})`),
    check(
      "public_media_upload_intents_source_format_check",
      sql`${table.declaredSourceFormat} in (${sql.raw(sourceFormatValues)})`,
    ),
    check(
      "public_media_upload_intents_limits_check",
      sql`${table.maxSourceBytes} between 1 and 10485760 and ${table.maxSourcePixels} between 1 and 40000000`,
    ),
    check(
      "public_media_upload_intents_state_check",
      sql`${table.state} in ('issued','completed','expired')`,
    ),
    check(
      "public_media_upload_intents_expiry_check",
      sql`${table.expiresAt} = ${table.createdAt} + interval '15 minutes'`,
    ),
    check(
      "public_media_upload_intents_completion_check",
      sql`(${table.state} = 'completed' and ${table.completedAt} is not null)
        or (${table.state} <> 'completed' and ${table.completedAt} is null)`,
    ),
    check(
      "public_media_upload_intents_completion_window_check",
      sql`${table.completedAt} is null or (${table.completedAt} >= ${table.createdAt} and ${table.completedAt} <= ${table.expiresAt})`,
    ),
    check("public_media_upload_intents_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const publicMediaDerivatives = pgTable(
  "public_media_derivatives",
  {
    id: uuid("id").primaryKey(),
    assetId: uuid("asset_id").notNull().references(() => publicMediaAssets.id, { onDelete: "restrict", onUpdate: "restrict" }),
    variant: text("variant").notNull(),
    format: text("format").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    objectKey: text("object_key").notNull(),
    objectVersionId: text("object_version_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("public_media_derivatives_asset_variant_uidx").on(table.assetId, table.variant),
    index("public_media_derivatives_cleanup_idx").on(table.assetId, table.verifiedAt),
    check("public_media_derivatives_variant_check", sql`${table.variant} in (${sql.raw(variantValues)})`),
    check("public_media_derivatives_format_check", sql`${table.format} = 'webp'`),
    check(
      "public_media_derivatives_dimensions_check",
      sql`${table.width} between 1 and 4096 and ${table.height} between 1 and 4096 and ${table.width} * ${table.height} <= 40000000`,
    ),
    check(
      "public_media_derivatives_variant_dimensions_check",
      sql`(${table.variant} = 'master' and ${table.width} <= 4096 and ${table.height} <= 4096)
        or (${table.variant} = 'thumb' and ${table.width} <= 384 and ${table.height} <= 384)
        or (${table.variant} = 'display' and ${table.width} <= 1280 and ${table.height} <= 1280)
        or (${table.variant} = 'large' and ${table.width} <= 2400 and ${table.height} <= 2400)`,
    ),
    check(
      "public_media_derivatives_bytes_check",
      sql`(${table.variant} = 'master' and ${table.byteSize} between 1 and 10485760)
        or (${table.variant} = 'thumb' and ${table.byteSize} between 1 and 524288)
        or (${table.variant} = 'display' and ${table.byteSize} between 1 and 3145728)
        or (${table.variant} = 'large' and ${table.byteSize} between 1 and 6291456)`,
    ),
    check(
      "public_media_derivatives_hash_check",
      sql`${table.contentHash} ~ '^sha256:v1:[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      "public_media_derivatives_object_version_check",
      sql`public_media_opaque_storage_marker_is_valid(${table.objectVersionId})`,
    ),
    check("public_media_derivatives_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const publicMediaProcessingAttempts = pgTable(
  "public_media_processing_attempts",
  {
    id: uuid("id").primaryKey(),
    assetId: uuid("asset_id").notNull().references(() => publicMediaAssets.id, { onDelete: "restrict", onUpdate: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    outcomeCode: text("outcome_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("public_media_processing_attempts_asset_number_uidx").on(
      table.assetId,
      table.attemptNumber,
    ),
    index("public_media_processing_attempts_worker_idx").on(table.workerId, table.startedAt),
    index("public_media_processing_attempts_retry_idx").on(table.nextRetryAt, table.finishedAt),
    check("public_media_processing_attempts_number_check", sql`${table.attemptNumber} between 1 and 8`),
    check("public_media_processing_attempts_worker_check", sql`char_length(${table.workerId}) between 1 and 128`),
    check(
      "public_media_processing_attempts_outcome_check",
      sql`${table.outcomeCode} is null or ${table.outcomeCode} in ('started','succeeded','retryable','retryable_error','failed_validation','unsupported_format','malformed_image','dimensions_exceeded','output_too_large','storage_unavailable','storage_error','processing_error','derivative_key_conflict','failed')`,
    ),
    check(
      "public_media_processing_attempts_completion_check",
      sql`(${table.finishedAt} is null and (${table.outcomeCode} is null or ${table.outcomeCode} = 'started'))
        or (${table.finishedAt} is not null and ${table.outcomeCode} is not null and ${table.outcomeCode} <> 'started')`,
    ),
    check(
      "public_media_processing_attempts_retry_check",
      sql`(${table.nextRetryAt} is null or ${table.outcomeCode} in ('retryable','retryable_error'))`,
    ),
    check(
      "public_media_processing_attempts_time_check",
      sql`${table.updatedAt} >= ${table.createdAt} and (${table.finishedAt} is null or ${table.finishedAt} >= ${table.startedAt})`,
    ),
  ],
);
