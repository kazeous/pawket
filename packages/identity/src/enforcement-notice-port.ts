import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { identityEmailAddresses, type PawketTransaction } from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";
import { queueSecurityEmailHandoff, recordSecurityEmailAttentionRequired } from "./security-email-handoff.js";

export type EnforcementNoticePort = Readonly<{
  queue(tx: PawketTransaction, command: { userId: string; penaltyId: string; token: string; kind: "suspension" | "removal"; endsAt: Date | null; at: Date }): Promise<void>;
}>;

export function createEnforcementNoticePort(input: { keyring: EncryptionKeyring }): EnforcementNoticePort {
  return {
    async queue(tx, command) {
      const [address] = await tx.select({ email: identityEmailAddresses.displayEmail }).from(identityEmailAddresses)
        .where(and(eq(identityEmailAddresses.userId, command.userId), eq(identityEmailAddresses.status, "primary"), isNotNull(identityEmailAddresses.verifiedAt))).limit(1);
      const common = { id: randomUUID(), userId: command.userId, purpose: "enforcement_notice" as const,
        templateData: { kind: command.kind, endsAt: command.endsAt?.toISOString() ?? "" }, now: command.at };
      if (!address) {
        await recordSecurityEmailAttentionRequired(tx, { ...common, failureCode: "no_verified_destination" });
        return;
      }
      await queueSecurityEmailHandoff(tx, { ...common, destination: address.email, secret: command.token, keyring: input.keyring });
    },
  };
}
