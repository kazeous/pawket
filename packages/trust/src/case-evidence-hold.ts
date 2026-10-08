import { and, eq, gt, or } from "drizzle-orm";
import { trustCases, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { validUuid } from "./report-policy.js";
import { caseFail, caseTime } from "./case-port.js";

export const TRUST_CASE_EVIDENCE_TAIL_MS = 2_592_000_000;
export function createCaseEvidenceHoldPort(input: { now?(): Date } = {}) {
  const now = input.now ?? (() => new Date());
  return {
    async hasEvidenceHold(db: PawketDatabase | PawketTransaction, orderId: string): Promise<boolean> {
      if (!validUuid(orderId)) caseFail("invalid_request");
      const cutoff = new Date(caseTime(now()).getTime() - TRUST_CASE_EVIDENCE_TAIL_MS);
      const [row] = await db.select({ id: trustCases.id }).from(trustCases).where(and(eq(trustCases.orderId, orderId),
        or(eq(trustCases.state, "open"), and(eq(trustCases.state, "resolved"), gt(trustCases.resolvedAt, cutoff))))).limit(1);
      return !!row;
    },
  };
}
