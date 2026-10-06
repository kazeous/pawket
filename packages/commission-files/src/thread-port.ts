import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { commissionFileAttachments, commissionFiles, commissionMessages, commissionThreadEntries, commissionThreads, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";

import { decryptCommissionFileName } from "./file-names.js";
import { COMMISSION_FILE_CONTEXT_TYPES, COMMISSION_FILE_POLICY, commissionFileFail, commissionFileMaxBytes, commissionFileUuid,
  isInlinePreviewAllowed, type CommissionFileType } from "./file-policy.js";

export type CommissionAttachmentTarget = Readonly<{ kind: "message" | "submission"; id: string }>;
export type CommissionAttachedFileView = Readonly<{
  fileId: string; name: string | null; sizeBytes: number; detectedType: CommissionFileType; sha256: string;
  previewable: boolean; availability: "available" | "deleted";
}>;
export type CommissionThreadEntry = Readonly<{ sequence: number; kind: "message" | "submission"; entryId: string; createdAt: Date }>;
type MessageView = Readonly<{ authorUserId: string; text: string | null; createdAt: Date }>;

/** Structural port consumed by Orders, without importing that package. All writes share the caller's transaction. */
export function createCommissionThreadPort(input: Readonly<{ keyring: EncryptionKeyring; mode: "disabled" | "enabled" }>) {
  return {
    async appendEntry(tx: PawketTransaction, command: Readonly<{ orderId: string; kind: "message" | "submission"; entryId: string; at: Date }>): Promise<number> {
      await tx.insert(commissionThreads).values({ orderId: command.orderId, createdAt: command.at, updatedAt: command.at }).onConflictDoNothing();
      const [thread] = await tx.select().from(commissionThreads).where(eq(commissionThreads.orderId, command.orderId)).for("update");
      if (!thread) commissionFileFail("dependency_unavailable");
      const sequence = thread.nextSequence;
      await tx.insert(commissionThreadEntries).values({ orderId: command.orderId, sequence, kind: command.kind, entryId: command.entryId, createdAt: command.at });
      await tx.update(commissionThreads).set({ nextSequence: sql`${commissionThreads.nextSequence} + 1`,
        updatedAt: command.at > thread.updatedAt ? command.at : thread.updatedAt }).where(eq(commissionThreads.orderId, command.orderId));
      return sequence;
    },
    async attachOrderFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; ownerUserId: string; context: "thread" | "submission";
      target: CommissionAttachmentTarget; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled"> {
      if (input.mode !== "enabled") return "disabled";
      const ids = [...command.fileIds]; const limit = command.target.kind === "message" ? COMMISSION_FILE_POLICY.maxMessageFiles : COMMISSION_FILE_POLICY.maxSubmissionFiles;
      if (command.context !== (command.target.kind === "message" ? "thread" : "submission") || ids.length > limit ||
        new Set(ids).size !== ids.length || !ids.every(commissionFileUuid)) return "invalid";
      if (ids.length === 0) return "attached";
      const rows = await tx.select().from(commissionFiles).where(inArray(commissionFiles.id, ids)).orderBy(asc(commissionFiles.id)).for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.length !== ids.length || rows.some((row) => row.state !== "clean" || row.orderId !== null || row.uploadOrderId !== command.orderId ||
        row.context !== command.context || row.ownerUserId !== command.ownerUserId || row.declaredBytes > commissionFileMaxBytes(command.context) ||
        !COMMISSION_FILE_CONTEXT_TYPES[command.context].includes(row.detectedType as CommissionFileType))) return "invalid";
      for (const [position, fileId] of ids.entries()) {
        const row = byId.get(fileId)!;
        const [updated] = await tx.update(commissionFiles).set({ state: "attached", orderId: command.orderId, attachedAt: command.at, version: row.version + 1,
          updatedAt: command.at > row.updatedAt ? command.at : row.updatedAt }).where(and(eq(commissionFiles.id, fileId), eq(commissionFiles.version, row.version))).returning({ id: commissionFiles.id });
        if (!updated) return "invalid";
        await tx.insert(commissionFileAttachments).values({ fileId, orderId: command.orderId, targetKind: command.target.kind, targetId: command.target.id, position, attachedAt: command.at });
      }
      return "attached";
    },
    async describeAttachedFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; targets: readonly CommissionAttachmentTarget[] }>): Promise<ReadonlyMap<string, readonly CommissionAttachedFileView[]>> {
      const result = new Map<string, CommissionAttachedFileView[]>(command.targets.map((target) => [target.kind + ":" + target.id, []]));
      if (command.targets.length === 0) return result;
      const rows = await tx.select({ file: commissionFiles, kind: commissionFileAttachments.targetKind, targetId: commissionFileAttachments.targetId })
        .from(commissionFileAttachments).innerJoin(commissionFiles, eq(commissionFiles.id, commissionFileAttachments.fileId))
        .where(and(eq(commissionFileAttachments.orderId, command.orderId), or(...command.targets.map((target) =>
          and(eq(commissionFileAttachments.targetKind, target.kind), eq(commissionFileAttachments.targetId, target.id)))))).orderBy(asc(commissionFileAttachments.position));
      for (const { file, kind, targetId } of rows) {
        const detectedType = file.detectedType as CommissionFileType; const availability = file.state === "deleted" || file.cleanPurgedAt ? "deleted" : "available";
        result.get(kind + ":" + targetId)!.push({ fileId: file.id, name: decryptCommissionFileName(input.keyring, file), sizeBytes: file.declaredBytes,
          detectedType, sha256: file.sha256!, availability, previewable: availability === "available" && isInlinePreviewAllowed(detectedType, file.declaredBytes) });
      }
      return result;
    },
    async listEntries(tx: PawketTransaction, command: Readonly<{ orderId: string; beforeSequence?: number; limit: number }>): Promise<readonly CommissionThreadEntry[]> {
      const rows = await tx.select().from(commissionThreadEntries).where(and(eq(commissionThreadEntries.orderId, command.orderId),
        command.beforeSequence === undefined ? undefined : lt(commissionThreadEntries.sequence, command.beforeSequence)))
        .orderBy(desc(commissionThreadEntries.sequence)).limit(command.limit + 1);
      return rows.map((row) => ({ sequence: row.sequence, kind: row.kind as CommissionThreadEntry["kind"], entryId: row.entryId, createdAt: row.createdAt }));
    },
    async describeMessages(tx: PawketTransaction, command: Readonly<{ orderId: string; messageIds: readonly string[] }>): Promise<ReadonlyMap<string, MessageView>> {
      const result = new Map<string, MessageView>();
      if (command.messageIds.length === 0) return result;
      const rows = await tx.select().from(commissionMessages).where(and(eq(commissionMessages.orderId, command.orderId), inArray(commissionMessages.id, [...command.messageIds])));
      for (const row of rows) {
        let text: string | null = null;
        if (row.textEnvelope !== null) {
          try { text = decryptSensitiveField({ keyring: input.keyring, envelope: row.textEnvelope, binding: { recordType: "commission_messages", recordId: row.id, fieldName: "text" } }); }
          catch { commissionFileFail("dependency_unavailable"); }
        }
        result.set(row.id, { authorUserId: row.authorUserId, text, createdAt: row.createdAt });
      }
      return result;
    },
  };
}
export type CommissionThreadPort = ReturnType<typeof createCommissionThreadPort>;
