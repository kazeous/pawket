import { and, asc, eq, inArray } from "drizzle-orm";
import { commissionFileAttachments, commissionFiles, type PawketTransaction } from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";

import { COMMISSION_FILE_CONTEXT_TYPES, COMMISSION_FILE_POLICY, commissionFileMaxBytes, commissionFileUuid, type CommissionFileType } from "./file-policy.js";

/** Structural CommissionRefundFilesPort. The caller holds the creator fence and rolls back an invalid result. */
export function createCommissionEvidenceAttachmentPort(input: Readonly<{ keyring: EncryptionKeyring; mode: "disabled" | "enabled" }>) {
  return {
    async attachResolutionEvidence(tx: PawketTransaction, command: Readonly<{ orderId: string; ownerUserId: string;
      target: { kind: "refund_send" | "late_claim"; id: string }; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled"> {
      const ids = [...command.fileIds];
      if (input.mode !== "enabled") return "disabled";
      if (!commissionFileUuid(command.orderId) || !commissionFileUuid(command.target.id) || !["refund_send", "late_claim"].includes(command.target.kind)
        || ids.length > COMMISSION_FILE_POLICY.maxEvidenceFiles || new Set(ids).size !== ids.length || !ids.every(commissionFileUuid)) return "invalid";
      if (ids.length === 0) return "attached";
      const rows = await tx.select().from(commissionFiles).where(inArray(commissionFiles.id, ids)).orderBy(asc(commissionFiles.id)).for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.length !== ids.length || rows.some((row) => row.state !== "clean" || row.orderId !== null || row.uploadOrderId !== command.orderId
        || row.context !== "resolution_evidence" || row.ownerUserId !== command.ownerUserId || row.declaredBytes > commissionFileMaxBytes("resolution_evidence")
        || !COMMISSION_FILE_CONTEXT_TYPES.resolution_evidence.includes(row.detectedType as CommissionFileType))) return "invalid";
      for (const [position, fileId] of ids.entries()) {
        const row = byId.get(fileId)!;
        const [updated] = await tx.update(commissionFiles).set({ state: "attached", orderId: command.orderId, attachedAt: command.at, version: row.version + 1,
          updatedAt: command.at > row.updatedAt ? command.at : row.updatedAt }).where(and(eq(commissionFiles.id, fileId), eq(commissionFiles.version, row.version))).returning({ id: commissionFiles.id });
        if (!updated) return "invalid";
        await tx.insert(commissionFileAttachments).values({ fileId, orderId: command.orderId, targetKind: command.target.kind, targetId: command.target.id, position, attachedAt: command.at });
      }
      return "attached";
    },
  };
}
