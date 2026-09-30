import { and, inArray, isNull, lte } from "drizzle-orm";
import { identityOidcPendingCommands, identityOidcTransactions, type PawketDatabase } from "@pawket/database";

/** Erase only expired transient secrets; retain identity/session/audit references. */
export async function expireOidcTransientData(db: PawketDatabase, now: Date, limit = 100): Promise<number> {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid OIDC cleanup input");
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: identityOidcTransactions.id }).from(identityOidcTransactions)
      .where(and(lte(identityOidcTransactions.expiresAt, now), inArray(identityOidcTransactions.status, ["pending", "exchanging"])))
      .orderBy(identityOidcTransactions.expiresAt).limit(limit).for("update", { skipLocked: true });
    if (rows.length) await tx.update(identityOidcTransactions).set({ status: "failed", completedAt: now, verifierEnvelope: null })
      .where(inArray(identityOidcTransactions.id, rows.map((row) => row.id)));
    const commands = await tx.select({ id: identityOidcPendingCommands.id }).from(identityOidcPendingCommands)
      .where(and(lte(identityOidcPendingCommands.expiresAt, now), isNull(identityOidcPendingCommands.consumedAt)))
      .orderBy(identityOidcPendingCommands.expiresAt).limit(limit).for("update", { skipLocked: true });
    if (commands.length) await tx.update(identityOidcPendingCommands).set({ consumedAt: now, payloadEnvelope: null })
      .where(inArray(identityOidcPendingCommands.id, commands.map((row) => row.id)));
    return rows.length + commands.length;
  });
}
