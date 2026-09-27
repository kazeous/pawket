import { createHash } from "node:crypto";
import { commissionPolicyCurrent, commissionPolicyRevisions, type PawketTransaction } from "@pawket/database";
import { eq } from "drizzle-orm";
import { commissionFail } from "./contracts.js";
import { COMMISSION_POLICY, commissionTime } from "./policy.js";

type Facts = Pick<typeof commissionPolicyRevisions.$inferSelect, "technicalVersion" | "minimumVnd" | "maximumVnd" | "approvalKind" | "document">;
export function commissionPolicyChecksum(policy: Facts): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ technicalVersion: policy.technicalVersion, minimumVnd: policy.minimumVnd,
    maximumVnd: policy.maximumVnd, approvalKind: policy.approvalKind, document: policy.document })).digest("hex")}`;
}
export type CommissionPolicySnapshot = Readonly<{
  revisionId: string; revisionNumber: number; document: string | null; checksum: string; acceptsOrders: boolean;
}>;
export function createCommissionPolicyReadPort(input: { environment: "local" | "test" | "staging" | "production" }) {
  return {
    async readCurrent(tx: PawketTransaction, at: Date): Promise<CommissionPolicySnapshot | null> {
      commissionTime(at);
      const [head] = await tx.select().from(commissionPolicyCurrent).where(eq(commissionPolicyCurrent.singleton, true)).limit(1).for("share");
      if (!head) return null;
      const [policy] = await tx.select().from(commissionPolicyRevisions).where(eq(commissionPolicyRevisions.id, head.revisionId)).limit(1);
      if (!policy || policy.technicalVersion !== COMMISSION_POLICY.version || policy.minimumVnd !== COMMISSION_POLICY.minimumVnd ||
        policy.maximumVnd !== COMMISSION_POLICY.maximumVnd || policy.effectiveAt > at || policy.createdAt > at || policy.checksum !== commissionPolicyChecksum(policy)) return null;
      const reviewed = policy.approvalKind === "owner_reviewed" && !!policy.actorUserId && !!policy.actorSessionId;
      const synthetic = (input.environment === "local" || input.environment === "test") && policy.approvalKind === "synthetic";
      return Object.freeze({ revisionId: policy.id, revisionNumber: policy.revisionNumber, document: policy.document, checksum: policy.checksum,
        acceptsOrders: !!policy.document && (reviewed || synthetic) });
    },
  };
}
export type CommissionPolicyReadPort = ReturnType<typeof createCommissionPolicyReadPort>;
export function requireCommissionPolicy(policy: CommissionPolicySnapshot | null, expectedRevisionId: string): CommissionPolicySnapshot {
  if (!policy || !policy.acceptsOrders || policy.revisionId !== expectedRevisionId) commissionFail("policy_changed");
  return policy;
}
