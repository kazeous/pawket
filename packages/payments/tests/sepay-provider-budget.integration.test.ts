import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSePayBudgetedProvider } from "../src/sepay-provider-budget.js";
import { SePayProviderError, SePayProviderNotDispatchedError } from "../src/sepay-provider.js";
import { createSePayIntegrationFixture, schema } from "./sepay-integration-fixture.js";

const fixture = createSePayIntegrationFixture("budget");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
beforeEach(async () => { await fixture.db.delete(schema.paymentsSepayProviderBudgets); });

describe("shared bounded SePay provider allowance", () => {
  test("concurrent web/worker instances share one environment budget before dispatch", async () => {
    const creator = await fixture.creator();
    const providers = [0, 1].map(() => createSePayBudgetedProvider({ db: fixture.db, provider: creator.provider, now: creator.now }));
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => providers[index % 2]!.discoverAccounts({ accessToken: "synthetic" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(6);
    expect(creator.provider.discoverAccounts).toHaveBeenCalledTimes(6);
    for (const result of results) if (result.status === "rejected") {
      expect(result.reason).toBeInstanceOf(SePayProviderNotDispatchedError);
      expect(result.reason).toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    }
    const live = createSePayBudgetedProvider({ db: fixture.db, provider: { ...creator.provider, environment: "live" }, now: creator.now });
    expect((await live.discoverAccounts({ accessToken: "synthetic-live" })).kind).toBe("complete");
    creator.advance(60_000);
    expect((await providers[0]!.discoverAccounts({ accessToken: "synthetic" })).kind).toBe("complete");
    expect((await fixture.db.select().from(schema.paymentsSepayProviderBudgets).where(eq(schema.paymentsSepayProviderBudgets.environment, "test")))[0]?.requestCount).toBe(5);
  });

  test("provider Retry-After is durable across instances and never shortened by a new minute", async () => {
    const creator = await fixture.creator();
    const first = createSePayBudgetedProvider({ db: fixture.db, provider: creator.provider, now: creator.now });
    const remote = new SePayProviderError("rate_limited", 300);
    creator.provider.discoverAccounts.mockRejectedValueOnce(remote);
    await expect(first.discoverAccounts({ accessToken: "synthetic" })).rejects.toBe(remote);
    creator.advance(60_000);
    const second = createSePayBudgetedProvider({ db: fixture.db, provider: creator.provider, now: creator.now });
    await expect(second.refresh({ refreshToken: "synthetic" })).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 240 });
    expect(creator.provider.refresh).not.toHaveBeenCalled();
    creator.advance(240_000);
    await second.refresh({ refreshToken: "synthetic" });
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);
  });
});
