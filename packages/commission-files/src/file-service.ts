import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  beginIdempotentCommand, commissionFileAttachments, commissionFiles, completeIdempotentCommand, insertOutboxEvent,
  type CommissionFileState, type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";

import { decryptCommissionFileName, encryptCommissionFileName } from "./file-names.js";
import {
  COMMISSION_FILE_CONTENT_TYPES, COMMISSION_FILE_POLICY, CommissionFileError, commissionFileContentDisposition, commissionFileFail, commissionFileObjectKey,
  commissionFileMaxBytes, commissionFileUuid, isInlinePreviewAllowed, normalizeCommissionFileName, type CommissionFileType,
} from "./file-policy.js";
import type { CommissionEvidenceUploadPort, CommissionFileActor, CommissionFileOrderAccessPort, CommissionFileSessionPort } from "./ports.js";
import { CommissionFileStorageError, type CommissionFileStoragePort } from "./storage-port.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
type FileRow = typeof commissionFiles.$inferSelect;
export type CommissionFileView = Readonly<{
  fileId: string; state: CommissionFileState; name: string | null; declaredBytes: number; detectedType: CommissionFileType | null;
  sha256: string | null; rejectionReason: string | null; uploadExpiresAt: string; previewable: boolean;
}>;
type Input = Readonly<{
  db: PawketDatabase; storage: Pick<CommissionFileStoragePort, "presignUpload" | "presignDownload">; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  mode: "disabled" | "enabled"; fulfillmentMode: "disabled" | "enabled"; sessions: CommissionFileSessionPort;
  orders: Pick<CommissionFileOrderAccessPort, "briefPackage" | "orderAccess" | "lockFulfillmentOrder">;
  evidenceUploads?: CommissionEvidenceUploadPort;
  now?: () => Date; idFactory?: () => string;
}>;

function view(keyring: EncryptionKeyring, row: FileRow): CommissionFileView {
  const type = row.detectedType as CommissionFileType | null;
  return { fileId: row.id, state: row.state as CommissionFileState, name: row.filenameEnvelope === null ? null : decryptCommissionFileName(keyring, row), declaredBytes: row.declaredBytes, detectedType: type,
    sha256: row.sha256, rejectionReason: row.rejectionReason, uploadExpiresAt: row.uploadExpiresAt.toISOString(),
    previewable: (row.state === "clean" || row.state === "attached") && !!type && isInlinePreviewAllowed(type, row.declaredBytes) };
}

export function createCommissionFileService(input: Input) {
  if (input.lookupHmacKey.byteLength < 32) throw new Error("Commission file service requires a 32-byte lookup key");
  const key = new Uint8Array(input.lookupHmacKey); const now = input.now ?? (() => new Date()); const newId = input.idFactory ?? randomUUID;
  const later = (at: Date, previous: Date) => at > previous ? at : previous;

  function actorValid(actor: CommissionFileActor): void {
    if (!actor || typeof actor.userId !== "string" || !IDENTIFIER.test(actor.userId) || typeof actor.sessionId !== "string" || !IDENTIFIER.test(actor.sessionId)) commissionFileFail("not_authorized");
  }
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof CommissionFileError) throw error;
      if (error instanceof CommissionFileStorageError) return commissionFileFail("storage_unavailable");
      return commissionFileFail("dependency_unavailable");
    }
  }
  async function session(tx: PawketTransaction, actor: CommissionFileActor): Promise<Date> {
    const at = now(); const proof = await input.sessions.getTipSessionAssurance(tx, actor, at);
    if (!proof || !(proof.sessionExpiresAt instanceof Date) || !(proof.sessionExpiresAt > at)) commissionFileFail("not_authorized");
    return proof.sessionExpiresAt;
  }
  async function owned(tx: PawketTransaction, fileId: string, actor: CommissionFileActor): Promise<FileRow> {
    if (!commissionFileUuid(fileId)) commissionFileFail("not_available");
    const [row] = await tx.select().from(commissionFiles).where(and(eq(commissionFiles.id, fileId), eq(commissionFiles.ownerUserId, actor.userId))).limit(1).for("update");
    if (!row) commissionFileFail("not_available");
    return row;
  }

  return {
    async createUpload(command: Readonly<{ actor: CommissionFileActor; fileName: unknown; declaredBytes: unknown; idempotencyKey: string; requestId: string }> &
      (Readonly<{ context: "brief"; packageId: string }> | Readonly<{ context: "thread" | "submission" | "resolution_evidence"; orderId: string }>)) {
      actorValid(command.actor);
      if (!(command.context === "brief" ? commissionFileUuid(command.packageId) :
        (command.context === "thread" || command.context === "submission" || command.context === "resolution_evidence") && commissionFileUuid(command.orderId)) ||
        typeof command.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(command.idempotencyKey) ||
        typeof command.requestId !== "string" || !IDENTIFIER.test(command.requestId) || !Number.isSafeInteger(command.declaredBytes) || (command.declaredBytes as number) < 1) commissionFileFail("invalid_request");
      const declaredBytes = command.declaredBytes as number;
      if (command.context === "brief" && declaredBytes > commissionFileMaxBytes(command.context)) commissionFileFail("file_too_large");
      const name = normalizeCommissionFileName(command.fileName);
      if (input.mode !== "enabled") commissionFileFail("files_disabled");
      if (command.context !== "brief" && input.fulfillmentMode !== "enabled") commissionFileFail("fulfillment_disabled");
      return boundary(() => input.db.transaction(async (tx) => {
        const startedAt = now(); await session(tx, command.actor);
        const started = await beginIdempotentCommand(tx, { actorUserId: command.actor.userId, commandScope: "commission-files.upload",
          keyHash: createLookupHmac({ key, context: "commission-file-command-key", value: command.idempotencyKey }),
          requestFingerprint: createLookupHmac({ key, context: "commission-file-command", value: JSON.stringify(command.context === "brief"
            ? [command.packageId, name, declaredBytes] : [command.context, command.orderId, name, declaredBytes]) }),
          now: startedAt, expiresAt: new Date(startedAt.getTime() + COMMISSION_FILE_POLICY.uploadGrantMs) });
        if (started.kind === "replay") {
          if (command.context === "resolution_evidence") {
            const order = await input.orders.lockFulfillmentOrder(tx, { orderId: command.orderId, actorUserId: command.actor.userId });
            if (!order) commissionFileFail("not_available");
            if (!await input.evidenceUploads?.canUpload(tx, { orderId: command.orderId, actorUserId: command.actor.userId })) commissionFileFail("invalid_state");
          }
          const row = await owned(tx, started.resultReference, command.actor);
          const remaining = Math.floor((row.uploadExpiresAt.getTime() - now().getTime()) / 1000);
          if (row.state !== "awaiting_upload" || remaining < 1) commissionFileFail("upload_expired");
          const grant = await input.storage.presignUpload({ key: row.objectKey, contentLength: row.declaredBytes, expiresInSeconds: Math.min(900, remaining) });
          return { fileId: row.id, url: grant.url, requiredHeaders: { ...grant.requiredHeaders }, expiresAt: row.uploadExpiresAt.toISOString() };
        }
        if (started.kind !== "acquired") commissionFileFail("idempotency_conflict");
        if (declaredBytes > commissionFileMaxBytes(command.context)) commissionFileFail("file_too_large");
        if (command.context !== "brief") {
          const order = await input.orders.lockFulfillmentOrder(tx, { orderId: command.orderId, actorUserId: command.actor.userId });
          if (!order) commissionFileFail("not_available");
          if (command.context === "resolution_evidence") {
            if (!await input.evidenceUploads?.canUpload(tx, { orderId: command.orderId, actorUserId: command.actor.userId })) commissionFileFail("invalid_state");
          } else if (command.context === "thread" ? !["in_progress", "delivered"].includes(order.state) : order.role !== "creator" || order.state !== "in_progress") commissionFileFail("invalid_state");
        }
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commission-files:owner:${command.actor.userId}`}, 0))`);
        if (command.context === "brief" && !await input.orders.briefPackage(tx, { packageId: command.packageId, actorUserId: command.actor.userId })) commissionFileFail("not_available");
        const at = now();
        const live = or(eq(commissionFiles.state, "scanning"), and(eq(commissionFiles.state, "awaiting_upload"), gt(commissionFiles.uploadExpiresAt, at)));
        const [pending] = await tx.select({ total: count() }).from(commissionFiles).where(and(eq(commissionFiles.ownerUserId, command.actor.userId), live));
        if ((pending?.total ?? 0) >= COMMISSION_FILE_POLICY.maxPendingPerActor) commissionFileFail("pending_limit");
        if (command.context === "brief") {
          const [unsent] = await tx.select({ total: count() }).from(commissionFiles).where(and(eq(commissionFiles.ownerUserId, command.actor.userId),
            eq(commissionFiles.context, "brief"), or(live, eq(commissionFiles.state, "clean"))));
          if ((unsent?.total ?? 0) >= COMMISSION_FILE_POLICY.maxUnsentReferences) commissionFileFail("unsent_limit");
        } else {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commission-files:order:${command.orderId}`}, 0))`);
          const usage = await tx.execute(sql`select commission_order_file_bytes(${command.orderId}::uuid) as bytes`);
          if (Number(usage[0]!.bytes) + declaredBytes > COMMISSION_FILE_POLICY.orderQuotaBytes) commissionFileFail("order_quota_exceeded");
        }
        const fileId = newId(); if (!commissionFileUuid(fileId)) commissionFileFail("dependency_unavailable");
        const objectKey = commissionFileObjectKey(fileId); const uploadExpiresAt = new Date(at.getTime() + COMMISSION_FILE_POLICY.uploadGrantMs);
        await tx.insert(commissionFiles).values({ id: fileId, ownerUserId: command.actor.userId, context: command.context,
          packageId: command.context === "brief" ? command.packageId : null, uploadOrderId: command.context === "brief" ? null : command.orderId, declaredBytes,
          filenameEnvelope: encryptCommissionFileName(input.keyring, fileId, name), objectKey, uploadExpiresAt, requestId: command.requestId, createdAt: at, updatedAt: at });
        const grant = await input.storage.presignUpload({ key: objectKey, contentLength: declaredBytes, expiresInSeconds: 900 });
        if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: fileId, completedAt: now() })) commissionFileFail("idempotency_conflict");
        return { fileId, url: grant.url, requiredHeaders: { ...grant.requiredHeaders }, expiresAt: uploadExpiresAt.toISOString() };
      }));
    },

    async completeUpload(command: Readonly<{ actor: CommissionFileActor; fileId: string; requestId: string }>): Promise<CommissionFileView> {
      actorValid(command.actor);
      if (!commissionFileUuid(command.fileId) || typeof command.requestId !== "string" || !IDENTIFIER.test(command.requestId)) commissionFileFail("invalid_request");
      if (input.mode !== "enabled") commissionFileFail("files_disabled");
      return boundary(() => input.db.transaction(async (tx) => {
        await session(tx, command.actor); const row = await owned(tx, command.fileId, command.actor); const at = now();
        if (row.state === "expired") commissionFileFail("upload_expired");
        if (row.state !== "awaiting_upload") return view(input.keyring, row);
        if (at >= row.uploadExpiresAt) commissionFileFail("upload_expired");
        const [updated] = await tx.update(commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + COMMISSION_FILE_POLICY.scanDeadlineMs),
          version: row.version + 1, updatedAt: later(at, row.updatedAt) }).where(and(eq(commissionFiles.id, row.id), eq(commissionFiles.version, row.version))).returning();
        if (!updated) commissionFileFail("invalid_state");
        await insertOutboxEvent(tx, { eventType: "commission.file_uploaded.v1", eventVersion: 1, aggregateType: "commission_file", aggregateId: row.id,
          payload: { fileId: row.id, correlationId: command.requestId }, occurredAt: at });
        return view(input.keyring, updated);
      }));
    },

    async discard(command: Readonly<{ actor: CommissionFileActor; fileId: string }>): Promise<CommissionFileView> {
      actorValid(command.actor);
      return boundary(() => input.db.transaction(async (tx) => {
        await session(tx, command.actor); const row = await owned(tx, command.fileId, command.actor); const at = now();
        if (row.state === "discarded") return view(input.keyring, row);
        if (row.state !== "awaiting_upload" && row.state !== "scanning" && row.state !== "clean") commissionFileFail("invalid_state");
        const [updated] = await tx.update(commissionFiles).set({ state: "discarded", endedAt: at, nextScanAt: null, scanLeaseExpiresAt: null, version: row.version + 1, updatedAt: later(at, row.updatedAt) })
          .where(and(eq(commissionFiles.id, row.id), eq(commissionFiles.version, row.version))).returning();
        if (!updated) commissionFileFail("invalid_state");
        return view(input.keyring, updated);
      }));
    },

    async getFile(command: Readonly<{ actor: CommissionFileActor; fileId: string }>): Promise<CommissionFileView> {
      actorValid(command.actor);
      return boundary(() => input.db.transaction(async (tx) => { await session(tx, command.actor); return view(input.keyring, await owned(tx, command.fileId, command.actor)); }));
    },

    async downloadGrant(command: Readonly<{ actor: CommissionFileActor; orderId: string; fileId: string; disposition: "attachment" | "inline" }>): Promise<Readonly<{ url: string }>> {
      actorValid(command.actor);
      if (!commissionFileUuid(command.orderId) || !commissionFileUuid(command.fileId) || (command.disposition !== "attachment" && command.disposition !== "inline")) commissionFileFail("not_available");
      if (input.mode !== "enabled") commissionFileFail("files_disabled");
      return boundary(() => input.db.transaction(async (tx) => {
        const sessionExpiresAt = await session(tx, command.actor);
        const access = await input.orders.orderAccess(tx, { orderId: command.orderId, actorUserId: command.actor.userId });
        if (!access) commissionFileFail("not_available");
        const [row] = await tx.select({ file: commissionFiles }).from(commissionFileAttachments)
          .innerJoin(commissionFiles, eq(commissionFiles.id, commissionFileAttachments.fileId))
          .where(and(eq(commissionFileAttachments.fileId, command.fileId), eq(commissionFileAttachments.orderId, command.orderId), inArray(commissionFiles.state, ["attached"]))).limit(1);
        if (!row || row.file.cleanPurgedAt || !row.file.cleanVersionId || !row.file.detectedType) commissionFileFail("not_available");
        // Brief references: the creator loses access once the request closes before payment (spec §12).
        if (access.role === "creator" && access.state === "closed" && access.confirmedAt === null && row.file.context === "brief") commissionFileFail("not_available");
        if (access.role === "buyer" && access.state === "closed" && access.confirmedAt !== null && row.file.ownerUserId !== command.actor.userId
          && (row.file.context === "thread" || row.file.context === "submission")) commissionFileFail("not_available");
        const type = row.file.detectedType as CommissionFileType;
        if (command.disposition === "inline" && !isInlinePreviewAllowed(type, row.file.declaredBytes)) commissionFileFail("preview_not_allowed");
        const grant = await input.storage.presignDownload({ key: row.file.objectKey, versionId: row.file.cleanVersionId, contentType: COMMISSION_FILE_CONTENT_TYPES[type],
          contentDisposition: commissionFileContentDisposition(decryptCommissionFileName(input.keyring, row.file), command.disposition), expiresInSeconds: COMMISSION_FILE_POLICY.downloadGrantSeconds });
        if (!(sessionExpiresAt > now())) commissionFileFail("not_authorized");
        return { url: grant.url };
      }));
    },
  };
}
export type CommissionFileService = ReturnType<typeof createCommissionFileService>;
