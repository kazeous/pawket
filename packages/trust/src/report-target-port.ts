import type { PawketTransaction } from "@pawket/database";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";

export type TrustReportTarget = Readonly<{ kind: "commission_package"; packageId: string; revisionId: string }>
  | Readonly<{ kind: "commission_brief"; orderId: string }>
  | Readonly<{ kind: "commission_message"; orderId: string; messageId: string }>
  | Readonly<{ kind: "commission_file"; orderId: string; fileId: string }>;
export type ResolvedReportTarget = Readonly<{ kind: TrustReportTarget["kind"]; targetId: string; orderId: string | null;
  contentOwnerUserId: string; packageRevisionId: string | null }>;
export type TrustReportTargetPort = Readonly<{
  /** Resolve and retain visibility/participant fences until the caller commits. Call before reporter restriction checks. */
  resolve(tx: PawketTransaction, target: TrustReportTarget, reporter: { userId: string } | null): Promise<ResolvedReportTarget | null>;
}>;

export function normalizeTrustReportTarget(value: unknown): TrustReportTarget | null {
  const row = readExactOwnDataRecord(value, [["kind", "packageId", "revisionId"], ["kind", "orderId"], ["kind", "orderId", "messageId"], ["kind", "orderId", "fileId"]]);
  if (!row) return null;
  if (row.kind === "commission_package" && validUuid(row.packageId) && validUuid(row.revisionId))
    return { kind: row.kind, packageId: row.packageId.toLowerCase(), revisionId: row.revisionId.toLowerCase() };
  if (!validUuid(row.orderId)) return null;
  const orderId = row.orderId.toLowerCase();
  if (row.kind === "commission_brief" && Object.keys(row).length === 2) return { kind: row.kind, orderId };
  if (row.kind === "commission_message" && validUuid(row.messageId)) return { kind: row.kind, orderId, messageId: row.messageId.toLowerCase() };
  if (row.kind === "commission_file" && validUuid(row.fileId)) return { kind: row.kind, orderId, fileId: row.fileId.toLowerCase() };
  return null;
}
