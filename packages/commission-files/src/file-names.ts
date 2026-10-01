import type { commissionFiles } from "@pawket/database";
import { decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";

import { commissionFileFail, normalizeCommissionFileName } from "./file-policy.js";

const binding = (fileId: string) => ({ recordType: "commission_files", recordId: fileId, fieldName: "filename" } as const);
export function encryptCommissionFileName(keyring: EncryptionKeyring, fileId: string, name: string) {
  return encryptSensitiveField({ keyring, plaintext: normalizeCommissionFileName(name), binding: binding(fileId) });
}
export function decryptCommissionFileName(keyring: EncryptionKeyring, row: Pick<typeof commissionFiles.$inferSelect, "id" | "filenameEnvelope">): string {
  try { return normalizeCommissionFileName(decryptSensitiveField({ keyring, envelope: row.filenameEnvelope, binding: binding(row.id) })); }
  catch { return commissionFileFail("dependency_unavailable"); }
}
