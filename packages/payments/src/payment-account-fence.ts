import { paymentsReceivingAccountOnboarding, type PawketTransaction } from "@pawket/database";
import { and, eq, isNull, sql } from "drizzle-orm";

/** Retry the entire transaction; acquiring another fingerprint while holding the
 * lineage lock would invert the financial lock order. */
export class PaymentAccountChangedError extends Error {
  constructor() { super("payment_account_changed"); this.name = "PaymentAccountChangedError"; }
}

export async function lockPaymentAccountFingerprints(tx: PawketTransaction, fingerprints: readonly string[]): Promise<void> {
  for (const fingerprint of [...new Set(fingerprints)].sort()) {
    if (!/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u.test(fingerprint)) throw new PaymentAccountChangedError();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payments:account-fingerprint:${fingerprint}`}, 0))`);
  }
}

/** The fingerprint fence covers an absent cutover row and every creator sharing
 * a physical account. The lineage fence also covers a first proposal with no row. */
export async function lockPaymentAccountLineage(tx: PawketTransaction, creatorUserId: string, proposedFingerprints: readonly string[] = []) {
  const current = () => tx.select().from(paymentsReceivingAccountOnboarding).where(and(
    eq(paymentsReceivingAccountOnboarding.applicantUserId, creatorUserId),
    isNull(paymentsReceivingAccountOnboarding.retiredAt),
  )).limit(1);
  const [candidate] = await current();
  await lockPaymentAccountFingerprints(tx, [...proposedFingerprints, ...(candidate ? [candidate.accountFingerprint] : [])]);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payments-account:${creatorUserId}`}, 0))`);
  const [locked] = await current().for("update");
  if (candidate?.id !== locked?.id || candidate?.version !== locked?.version || candidate?.accountFingerprint !== locked?.accountFingerprint) {
    throw new PaymentAccountChangedError();
  }
  return locked ?? null;
}

export async function retryPaymentAccountChange<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); } catch (error) {
      if (!(error instanceof PaymentAccountChangedError) || attempt >= 2) throw error;
    }
  }
}
