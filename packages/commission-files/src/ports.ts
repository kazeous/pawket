import type { PawketDatabase, PawketTransaction } from "@pawket/database";

export type CommissionFileActor = Readonly<{ userId: string; sessionId: string }>;
export type CommissionFileSessionPort = Readonly<{
  getTipSessionAssurance(tx: PawketTransaction, actor: CommissionFileActor, at: Date): Promise<Readonly<{ sessionExpiresAt: Date }> | null>;
}>;
export type CommissionFileOrderFacts = Readonly<{ role: "buyer" | "creator"; state: string; confirmedAt: Date | null; closedAt: Date | null }>;
export type CommissionFileFulfillmentFacts = Readonly<{ role: "buyer" | "creator"; state: string; creatorUserId: string }>;
export type CommissionFileRetentionFacts = Readonly<{ state: string; confirmedAt: Date | null; closedAt: Date | null; completedAt: Date | null }>;
/** Implemented by Orders. Files never read order tables directly. */
export type CommissionFileOrderAccessPort = Readonly<{
  briefPackage(tx: PawketTransaction, command: Readonly<{ packageId: string; actorUserId: string }>): Promise<Readonly<{ creatorUserId: string }> | null>;
  orderAccess(tx: PawketTransaction, command: Readonly<{ orderId: string; actorUserId: string }>): Promise<CommissionFileOrderFacts | null>;
  lockFulfillmentOrder(tx: PawketTransaction, command: Readonly<{ orderId: string; actorUserId: string }>): Promise<CommissionFileFulfillmentFacts | null>;
  retentionFacts(db: PawketDatabase | PawketTransaction, orderIds: readonly string[]): Promise<ReadonlyMap<string, CommissionFileRetentionFacts>>;
}>;
/** Implemented by Trust in I8. I7 has no holds. */
export type CommissionFileEvidenceHoldPort = Readonly<{ hasEvidenceHold(db: PawketDatabase | PawketTransaction, orderId: string): Promise<boolean> }>;
export const noCommissionFileEvidenceHolds: CommissionFileEvidenceHoldPort = Object.freeze({ hasEvidenceHold: async () => false });
