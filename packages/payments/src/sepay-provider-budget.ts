import { paymentsSepayProviderBudgets, type PawketDatabase } from "@pawket/database";
import { eq, sql } from "drizzle-orm";
import { SePayProviderError, SePayProviderNotDispatchedError, type SePayProviderPort } from "./sepay-provider.js";

/** Web and worker share both the request allowance and provider Retry-After. */
export function createSePayBudgetedProvider(input: { db: PawketDatabase; provider: SePayProviderPort; now?: () => Date }): SePayProviderPort {
  const now = input.now ?? (() => new Date()); const environment = input.provider.environment;
  const fence = (tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0]) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sepay-provider-budget:${environment}`}, 0))`);
  async function reserve(cost: number): Promise<void> {
    await input.db.transaction(async (tx) => {
      await fence(tx); const at = now();
      const [current] = await tx.select().from(paymentsSepayProviderBudgets).where(eq(paymentsSepayProviderBudgets.environment, environment)).limit(1).for("update");
      if (current?.blockedUntil && current.blockedUntil > at) throw new SePayProviderError("rate_limited", Math.ceil((current.blockedUntil.getTime() - at.getTime()) / 1000));
      const reset = !current || at.getTime() - current.windowStartedAt.getTime() >= 60_000;
      const windowStartedAt = reset ? at : current.windowStartedAt;
      const requestCount = (reset ? 0 : current.requestCount) + cost;
      if (requestCount > 30) throw new SePayProviderError("rate_limited", Math.max(1, Math.ceil((windowStartedAt.getTime() + 60_000 - at.getTime()) / 1000)));
      await tx.insert(paymentsSepayProviderBudgets).values({ environment, windowStartedAt, requestCount, blockedUntil: null, updatedAt: at })
        .onConflictDoUpdate({ target: paymentsSepayProviderBudgets.environment, set: { windowStartedAt, requestCount, blockedUntil: null, updatedAt: at } });
    });
  }
  async function run<T>(cost: number, operation: () => Promise<T>): Promise<T> {
    try { await reserve(cost); } catch (error) {
      // Reservation precedes dispatch, so retrying cannot reuse a spent grant.
      throw new SePayProviderNotDispatchedError(error instanceof SePayProviderError && error.code === "rate_limited" ? "rate_limited" : "unavailable",
        error instanceof SePayProviderError ? error.retryAfterSeconds ?? 60 : 60);
    }
    try { return await operation(); } catch (error) {
      if (error instanceof SePayProviderError && error.code === "rate_limited") await input.db.transaction(async (tx) => {
        await fence(tx); const at = now(); const until = new Date(at.getTime() + (error.retryAfterSeconds ?? 60) * 1000);
        const [current] = await tx.select().from(paymentsSepayProviderBudgets).where(eq(paymentsSepayProviderBudgets.environment, environment)).limit(1).for("update");
        await tx.update(paymentsSepayProviderBudgets).set({ blockedUntil: current?.blockedUntil && current.blockedUntil > until ? current.blockedUntil : until, updatedAt: at })
          .where(eq(paymentsSepayProviderBudgets.environment, environment));
      });
      throw error;
    }
  }
  return Object.freeze<SePayProviderPort>({ environment, capabilities: input.provider.capabilities,
    authorizationUrl: (command) => input.provider.authorizationUrl(command),
    exchange: (command) => run(1, () => input.provider.exchange(command)),
    refresh: (command) => run(1, () => input.provider.refresh(command)),
    // The documented transport is capped at five pages. Reserve its maximum work.
    discoverAccounts: (command) => run(5, () => input.provider.discoverAccounts(command)),
    readback: (command) => run(5, () => input.provider.readback(command)),
    revoke: (command) => run(1, () => input.provider.revoke?.(command) ?? Promise.resolve("unverified" as const)),
  });
}
