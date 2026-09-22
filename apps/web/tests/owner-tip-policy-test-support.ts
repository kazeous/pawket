import { randomUUID } from "node:crypto";
import { createPlatformTipPolicyService } from "@pawket/catalog";
import { type PawketDatabase } from "@pawket/database";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";

export const launchTipPolicy = { minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000] };
export const narrowerTipPolicy = { minimumVnd: 30_000, maximumVnd: 500_000, allowedPresetsVnd: [30_000, 100_000, 200_000] };
export function ownerPolicyService(db: PawketDatabase, key: Uint8Array, now: Date,
  overrides: Partial<Parameters<typeof createPlatformTipPolicyService>[0]> = {}) {
  return createPlatformTipPolicyService({ db, applicationRevision: "synthetic-owner-policy-behavior", commandFingerprintKey: key,
    authorizeOwner: async () => true, requireOwnerStepUp: async () => true, now: () => now, ...overrides });
}
export async function setTipPolicy(db: PawketDatabase, key: Uint8Array, now: Date, ownerUserId: string,
  amounts = launchTipPolicy, service = ownerPolicyService(db, key, now)) {
  const policy = await db.transaction((tx) => service.readPolicy(tx));
  if (!policy) throw new Error("Missing synthetic platform policy");
  return service.savePolicy({ actor: { userId: ownerUserId, sessionId: "synthetic-owner-session" }, expectedRevision: policy.revisionNumber,
    ...amounts, reason: "Synthetic policy behavior verification", idempotencyKey: randomUUID(), requestId: randomUUID() });
}
export async function expectPolicyWait(db: PawketDatabase, blockerPid: number) {
  await vi.waitFor(async () => {
    const [row] = await db.execute<{ blocked: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))) as blocked`);
    expect(row?.blocked).toBe(true);
  }, { timeout: 3000, interval: 20 });
}
