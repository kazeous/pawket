import { tips, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { and, eq } from "drizzle-orm";
import { normalizeTipGuestContent, type TipGuestContent } from "./guest-content.js";

export function createTipLifecyclePort(input: { keyring: EncryptionKeyring }) {
  return {
    async completeTip(tx: PawketTransaction, command: { tipId: string; creatorUserId: string; amountVnd: number; at: Date }): Promise<boolean> {
      const updated = await tx.update(tips).set({ state: "completed", closedAt: command.at, updatedAt: command.at }).where(and(
        eq(tips.id, command.tipId), eq(tips.creatorUserId, command.creatorUserId), eq(tips.amountVnd, command.amountVnd), eq(tips.state, "awaiting_payment"),
      )).returning({ id: tips.id });
      return updated.length === 1;
    },
    async getConfirmedGuestContent(tx: PawketTransaction, command: { tipId: string; creatorUserId: string }): Promise<TipGuestContent | null> {
      const [tip] = await tx.select({ id: tips.id, envelope: tips.guestContentEnvelope }).from(tips).where(and(eq(tips.id, command.tipId), eq(tips.creatorUserId, command.creatorUserId), eq(tips.state, "completed"))).limit(1);
      if (!tip) return null;
      try {
        const value: unknown = JSON.parse(decryptSensitiveField({ keyring: input.keyring, envelope: tip.envelope, binding: { recordType: "tips", recordId: tip.id, fieldName: "guest_content" } }));
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "message,name") return null;
        const record = value as Record<string, unknown>;
        const content = normalizeTipGuestContent(record);
        return content.name === record.name && content.message === record.message ? content : null;
      } catch { return null; }
    },
  };
}
