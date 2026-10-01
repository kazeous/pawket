import { and, asc, eq, inArray } from "drizzle-orm";
import { commissionFileAttachments, commissionFiles, type PawketTransaction } from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";

import { decryptCommissionFileName } from "./file-names.js";
import { COMMISSION_FILE_POLICY, commissionFileUuid, isInlinePreviewAllowed, type CommissionFileType } from "./file-policy.js";

export type CommissionReferenceFileView = Readonly<{
  fileId: string; name: string | null; sizeBytes: number; detectedType: string; sha256: string; previewable: boolean; availability: "available" | "withdrawn" | "deleted";
}>;

/** Structural implementation of Orders' CommissionFilesPort. Returns outcomes instead of throwing so Orders keeps its own error contract. */
export function createCommissionFileAttachmentPort(input: Readonly<{ keyring: EncryptionKeyring; mode: "disabled" | "enabled" }>) {
  return {
    async attachBriefFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; buyerUserId: string; packageId: string; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled"> {
      const ids = [...command.fileIds];
      if (ids.length === 0) return "attached";
      if (input.mode !== "enabled") return "disabled";
      if (ids.length > COMMISSION_FILE_POLICY.maxBriefFiles || new Set(ids).size !== ids.length || !ids.every(commissionFileUuid)) return "invalid";
      const rows = await tx.select().from(commissionFiles).where(inArray(commissionFiles.id, ids)).for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.length !== ids.length || rows.some((row) => row.ownerUserId !== command.buyerUserId || row.context !== "brief" || row.packageId !== command.packageId ||
        row.state !== "clean" || row.orderId !== null)) return "invalid";
      for (const [position, fileId] of ids.entries()) {
        const row = byId.get(fileId)!;
        const [updated] = await tx.update(commissionFiles).set({ state: "attached", orderId: command.orderId, attachedAt: command.at, version: row.version + 1,
          updatedAt: command.at > row.updatedAt ? command.at : row.updatedAt }).where(and(eq(commissionFiles.id, fileId), eq(commissionFiles.version, row.version))).returning({ id: commissionFiles.id });
        if (!updated) return "invalid";
        await tx.insert(commissionFileAttachments).values({ fileId, orderId: command.orderId, targetKind: "brief", targetId: command.orderId, position, attachedAt: command.at });
      }
      return "attached";
    },
    async describeBriefFiles(tx: PawketTransaction, command: Readonly<{ orderId: string; viewer: "buyer" | "creator"; withdrawn: boolean }>): Promise<readonly CommissionReferenceFileView[]> {
      const rows = await tx.select({ file: commissionFiles }).from(commissionFileAttachments).innerJoin(commissionFiles, eq(commissionFiles.id, commissionFileAttachments.fileId))
        .where(and(eq(commissionFileAttachments.orderId, command.orderId), eq(commissionFileAttachments.targetKind, "brief"))).orderBy(asc(commissionFileAttachments.position));
      return rows.map(({ file }) => {
        const availability = command.viewer === "creator" && command.withdrawn ? "withdrawn" : file.state === "deleted" || file.cleanPurgedAt ? "deleted" : "available";
        return { fileId: file.id, name: availability === "withdrawn" ? null : decryptCommissionFileName(input.keyring, file), sizeBytes: file.declaredBytes,
          detectedType: file.detectedType!, sha256: file.sha256!, availability,
          previewable: availability === "available" && isInlinePreviewAllowed(file.detectedType as CommissionFileType, file.declaredBytes) };
      });
    },
  };
}
