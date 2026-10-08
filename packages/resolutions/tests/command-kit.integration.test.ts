import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PawketTransaction } from "@pawket/database";
import { commandIds, createResolutionIntegrationFixture, schema } from "./integration-fixture.js";
import { createResolutionCommandKit } from "../src/command-kit.js";
import { resolutionFail } from "../src/contracts.js";

const fixture = createResolutionIntegrationFixture("commands");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
type Context = ReturnType<typeof fixture.commandContext>;
function kit(p: Context, options: Partial<Parameters<typeof createResolutionCommandKit>[0]> = {}) {
  return createResolutionCommandKit({ ...fixture, session: p.session, now: p.now, ...options });
}
const marker = async (p: Context, tx: PawketTransaction) => {
  await tx.insert(schema.commissionResolutionPauses).values({ id: randomUUID(), startedAt: p.now() });
};
describe("resolution command transaction boundaries", () => {
  test("actor accessors are refused without evaluating them", async () => {
    const p = fixture.commandContext(); const instance = kit(p); const getter = vi.fn(() => p.buyer.userId);
    const actor = { get userId() { return getter(); }, sessionId: p.buyer.sessionId };
    await expect(instance.mutate({ actor, ...commandIds() }, "test_actor", [], async () => p.creator.userId,
      async () => ({ resultReference: p.orderId, at: p.now() }))).rejects.toMatchObject({ code: "not_authorized" });
    expect(getter).not.toHaveBeenCalled();
  });
  test("an invalid commit guard fails closed", async () => {
    const p = fixture.commandContext(); const instance = kit(p);
    await expect(instance.mutate({ actor: p.buyer, ...commandIds() }, "test_invalid_guard", [], async () => p.creator.userId,
      async () => ({ resultReference: p.orderId, at: p.now(), guardUntil: new Date(NaN) }))).rejects.toMatchObject({ code: "invalid_request" });
  });
  test("idempotent replay authorizes again and does not apply twice; changed payload conflicts", async () => {
    const p = fixture.commandContext(); const instance = kit(p); const command = { actor: p.buyer, ...commandIds() };
    let authorized = true;
    const creatorOf = vi.fn(async () => { if (!authorized) resolutionFail("not_authorized"); return p.creator.userId; });
    const apply = vi.fn(async () => ({ resultReference: p.orderId, at: p.now() }));
    expect(await instance.mutate(command, "test_replay", [p.orderId], creatorOf, apply)).toBe(p.orderId);
    expect(await instance.mutate(command, "test_replay", [p.orderId], creatorOf, apply)).toBe(p.orderId);
    expect(apply).toHaveBeenCalledTimes(1); expect(creatorOf).toHaveBeenCalledTimes(2);
    await expect(instance.mutate(command, "test_replay", [randomUUID()], creatorOf, apply)).rejects.toMatchObject({ code: "idempotency_conflict" });
    authorized = false;
    await expect(instance.mutate(command, "test_replay", [p.orderId], creatorOf, apply)).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("the creator advisory lock is held before apply", async () => {
    const p = fixture.commandContext(); const instance = kit(p);
    await instance.mutate({ actor: p.buyer, ...commandIds() }, "test_lock", [p.orderId], async () => p.creator.userId, async (tx) => {
      const rows = await tx.execute<{ held: boolean }>(sql`select exists(select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted) as held`);
      expect(rows[0]?.held).toBe(true);
      return { resultReference: p.orderId, at: p.now() };
    });
  });
  test("commit-time session expiry rolls back apply and idempotency", async () => {
    const p = fixture.commandContext(); const startedAt = p.now();
    const instance = kit(p, { session: { getTipSessionAssurance: async () => ({ sessionExpiresAt: new Date(startedAt.getTime() + 1) }) } });
    await expect(instance.mutate({ actor: p.buyer, ...commandIds() }, "test_expiry", [p.orderId], async () => p.creator.userId, async (tx) => {
      await marker(p, tx); p.advance(1);
      return { resultReference: p.orderId, at: startedAt };
    })).rejects.toMatchObject({ code: "not_authorized" });
    expect(await fixture.db.select().from(schema.commissionResolutionPauses)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.systemCommandIdempotency).where(eq(schema.systemCommandIdempotency.commandScope, "resolutions.commission.test_expiry"))).toHaveLength(0);
  });
  test("commit-time deadline passage rolls back the command", async () => {
    const p = fixture.commandContext(); const instance = kit(p); const at = p.now();
    await expect(instance.mutate({ actor: p.buyer, ...commandIds() }, "test_deadline", [p.orderId], async () => p.creator.userId, async () => {
      p.advance(1); return { resultReference: p.orderId, at, guardUntil: new Date(at.getTime() + 1) };
    })).rejects.toMatchObject({ code: "deadline_passed" });
  });
  test("owner step-up consumption rolls back with apply and is bound to the transaction", async () => {
    const p = fixture.commandContext(); let consumedTx: unknown;
    const consumeStepUpProof = vi.fn<NonNullable<Parameters<typeof createResolutionCommandKit>[0]["consumeStepUpProof"]>>(async (tx, proof) => {
      consumedTx = tx; expect(proof.userId).toBe(p.creator.userId); expect(proof.actionClass).toBe("owner.commission_ruling");
      await marker(p, tx); return true;
    });
    const instance = kit(p, { consumeStepUpProof });
    await expect(instance.ownerMutate({ owner: p.creator, stepUpProofId: randomUUID(), ...commandIds() }, "test_owner", [p.orderId],
      async () => p.creator.userId, "owner.commission_ruling", async (tx) => {
        expect(tx).toBe(consumedTx); resolutionFail("invalid_transition");
      })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(consumeStepUpProof).toHaveBeenCalledTimes(1);
    expect(await fixture.db.select().from(schema.commissionResolutionPauses)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.systemCommandIdempotency).where(eq(schema.systemCommandIdempotency.commandScope, "resolutions.commission.test_owner"))).toHaveLength(0);
  });
  test("an owner replay returns the recorded result without consuming an already-used proof", async () => {
    const p = fixture.commandContext(); let consumedTx: unknown;
    const consumeStepUpProof = vi.fn<NonNullable<Parameters<typeof createResolutionCommandKit>[0]["consumeStepUpProof"]>>()
      .mockImplementationOnce(async (tx) => { consumedTx = tx; return true; })
      .mockResolvedValue(false);
    const authorizeCommand = vi.fn(async () => undefined);
    const instance = kit(p, { consumeStepUpProof, authorizeCommand });
    const command = { owner: p.creator, stepUpProofId: randomUUID(), ...commandIds() };
    const creatorOf = vi.fn(async () => p.creator.userId);
    const apply = vi.fn(async (tx: PawketTransaction) => {
      expect(tx).toBe(consumedTx); expect(consumeStepUpProof).toHaveBeenCalledTimes(1);
      return { resultReference: p.orderId, at: p.now() };
    });
    expect(await instance.ownerMutate(command, "test_owner_replay", [p.orderId], creatorOf, "owner.commission_ruling", apply)).toBe(p.orderId);
    expect(await instance.ownerMutate(command, "test_owner_replay", [p.orderId], creatorOf, "owner.commission_ruling", apply)).toBe(p.orderId);
    expect(consumeStepUpProof).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(1);
    expect(creatorOf).toHaveBeenCalledTimes(2); expect(authorizeCommand).toHaveBeenCalledTimes(2);
    const records = await fixture.db.select().from(schema.systemCommandIdempotency)
      .where(eq(schema.systemCommandIdempotency.commandScope, "resolutions.commission.test_owner_replay"));
    expect(records).toHaveLength(1); expect(records[0]?.status).toBe("completed"); expect(records[0]?.resultReference).toBe(p.orderId);
  });
  test("a fresh owner command with a rejected proof writes nothing", async () => {
    const p = fixture.commandContext(); const instance = kit(p, { consumeStepUpProof: async () => false });
    const apply = vi.fn(async (tx: PawketTransaction) => {
      await marker(p, tx); return { resultReference: p.orderId, at: p.now() };
    });
    await expect(instance.ownerMutate({ owner: p.creator, stepUpProofId: randomUUID(), ...commandIds() }, "test_proof", [p.orderId],
      async () => p.creator.userId, "owner.commission_ruling", apply)).rejects.toMatchObject({ code: "owner_step_up_required" });
    expect(apply).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.commissionResolutionPauses)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.systemCommandIdempotency).where(eq(schema.systemCommandIdempotency.commandScope, "resolutions.commission.test_proof"))).toHaveLength(0);
  });
  test.each(["proof", "action"])("invalid owner %s input rejects without throwing synchronously", async (invalid) => {
    const p = fixture.commandContext(); const instance = kit(p);
    const command = { owner: p.creator, stepUpProofId: invalid === "proof" ? "" : randomUUID(), ...commandIds() };
    const apply = vi.fn(async () => ({ resultReference: p.orderId, at: p.now() }));
    let pending: Promise<string> | undefined;
    expect(() => {
      pending = instance.ownerMutate(command, "test_owner_invalid", [p.orderId], async () => p.creator.userId,
        invalid === "action" ? "" : "owner.commission_ruling", apply);
    }).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: "invalid_request" });
    expect(apply).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.systemCommandIdempotency).where(eq(schema.systemCommandIdempotency.commandScope, "resolutions.commission.test_owner_invalid"))).toHaveLength(0);
  });
  test("encrypted text is bound to record identity and field", async () => {
    const p = fixture.commandContext(); const instance = kit(p); const id = randomUUID();
    const envelope = instance.encrypt("commission_proposals", id, "note", "Synthetic private text");
    expect(instance.decrypt("commission_proposals", id, "note", envelope)).toBe("Synthetic private text");
    expect(() => instance.decrypt("commission_proposals", randomUUID(), "note", envelope)).toThrow("dependency_unavailable");
    expect(() => instance.decrypt("commission_disputes", id, "note", envelope)).toThrow("dependency_unavailable");
    expect(() => instance.decrypt("commission_proposals", id, "text", envelope)).toThrow("dependency_unavailable");
  });
});
