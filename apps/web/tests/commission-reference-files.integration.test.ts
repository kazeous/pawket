import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionFileAttachmentPort } from "@pawket/commission-files";
import { commissionCommandFingerprint, createCommissionFileAccessPort, createCommissionOrderService, lockCommissionCreator, normalizeCommissionBrief } from "@pawket/orders";
import { encryptSensitiveField } from "@pawket/security";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const fixture = createCommissionOrderTestFixture("i7refs");
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);

async function cleanFile(input: { keyring: Parameters<typeof encryptSensitiveField>[0]["keyring"]; ownerUserId: string; packageId: string; name?: string; state?: "clean" | "scanning" }) {
  const id = randomUUID(); const at = new Date("2026-09-26T03:00:00Z");
  await fixture.db.insert(schema.commissionFiles).values({ id, ownerUserId: input.ownerUserId, context: "brief", packageId: input.packageId, declaredBytes: 16,
    filenameEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: input.name ?? "ref.png", binding: { recordType: "commission_files", recordId: id, fieldName: "filename" } }),
    objectKey: `commission/${id}`, uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
  await fixture.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
  if (input.state !== "scanning") await fixture.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png",
    quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
  return id;
}
async function setupWithFiles(mode: "enabled" | "disabled" = "enabled") {
  const s = await fixture.setup("custom_quote");
  const files = createCommissionFileAttachmentPort({ keyring: s.input.keyring, mode });
  return { ...s, files, service: createCommissionOrderService({ ...s.input, files }) };
}
const ordersOf = async (buyerUserId: string) => fixture.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.buyerUserId, buyerUserId));

describe("fulfillment file access port", () => {
  test("returns party facts, refuses strangers and the owner, and handles unavailable orders", async () => {
    const p = await fixture.paidOrder(); const port = createCommissionFileAccessPort({ catalog: p.s.catalog });
    for (const [actor, role] of [[p.buyer, "buyer"], [p.creator, "creator"]] as const) {
      expect(await fixture.db.transaction((tx) => port.lockFulfillmentOrder(tx, { orderId: p.orderId, actorUserId: actor.userId })))
        .toEqual({ role, state: "in_progress", creatorUserId: p.creator.userId });
    }
    const stranger = await p.s.buyer(); const owner = await p.s.buyer(); const at = new Date("2026-09-26T04:00:01Z");
    await fixture.db.insert(schema.identityRoleGrants).values({ id: randomUUID(), userId: owner.userId, role: "owner", grantSource: "bootstrap_cli", grantedAt: at, createdAt: at, updatedAt: at });
    for (const actor of [stranger, owner]) expect(await fixture.db.transaction((tx) => port.lockFulfillmentOrder(tx, { orderId: p.orderId, actorUserId: actor.userId }))).toBeNull();
    for (const orderId of [randomUUID(), "invalid"]) expect(await fixture.db.transaction((tx) => port.lockFulfillmentOrder(tx, { orderId, actorUserId: p.buyer.userId }))).toBeNull();
    expect((await port.retentionFacts(fixture.db, [p.orderId])).get(p.orderId)).toMatchObject({ completedAt: null });
    expect((await port.retentionFacts(fixture.db, [])).size).toBe(0);
  });
  test("reads state after the creator fence and exposes completedAt for retention", async () => {
    const p = await fixture.paidOrder(); const port = createCommissionFileAccessPort({ catalog: p.s.catalog });
    const at = new Date("2026-09-26T04:00:02Z"); const completedAt = new Date(at.getTime() + 1_000);
    let locked!: () => void; let waiting!: () => void;
    const creatorLocked = new Promise<void>((resolve) => { locked = resolve; });
    const readerWaiting = new Promise<void>((resolve) => { waiting = resolve; });
    const writer = fixture.db.transaction(async (tx) => {
      await lockCommissionCreator(tx, p.creator.userId); locked(); await readerWaiting;
      // Same normal-trigger delivery graph as commission-threads-schema.integration.test.ts.
      const submissionId = randomUUID();
      await tx.insert(schema.commissionThreads).values({ orderId: p.orderId, createdAt: at, updatedAt: at });
      await tx.update(schema.commissionThreads).set({ nextSequence: 2 }).where(eq(schema.commissionThreads.orderId, p.orderId));
      await tx.insert(schema.commissionSubmissions).values({ id: submissionId, orderId: p.orderId, kind: "final", actorSessionId: p.creator.sessionId, requestId: randomUUID(), submittedAt: at });
      await tx.insert(schema.commissionThreadEntries).values({ orderId: p.orderId, sequence: 1, kind: "submission", entryId: submissionId, createdAt: at });
      await tx.update(schema.commissionOrders).set({ state: "delivered", deliveredAt: at, reviewEndsAt: new Date(at.getTime() + 7 * 86_400_000), version: 3, updatedAt: at }).where(eq(schema.commissionOrders.id, p.orderId));
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: 3, type: "delivered", requestId: randomUUID(), occurredAt: at });
    });
    await creatorLocked;
    const reader = fixture.db.transaction(async (tx) => {
      const execute = tx.execute.bind(tx); const select = vi.spyOn(tx, "select");
      const fence = vi.spyOn(tx, "execute").mockImplementation((query) => { waiting(); return execute(query); });
      try { const result = await port.lockFulfillmentOrder(tx, { orderId: p.orderId, actorUserId: p.buyer.userId });
        expect(fence).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledTimes(2); return result;
      } finally { fence.mockRestore(); select.mockRestore(); }
    });
    const [, facts] = await Promise.all([writer, reader.finally(waiting)]);
    expect(facts).toMatchObject({ state: "delivered" });
    await fixture.db.transaction(async (tx) => {
      await tx.update(schema.commissionOrders).set({ state: "completed", completedAt, completionKind: "buyer_accepted", version: 4, updatedAt: completedAt }).where(eq(schema.commissionOrders.id, p.orderId));
      await tx.update(schema.commissionReservations).set({ state: "completed", releasedAt: completedAt }).where(eq(schema.commissionReservations.orderId, p.orderId));
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: 4, type: "completed", requestId: randomUUID(), occurredAt: completedAt });
    });
    expect((await port.retentionFacts(fixture.db, [p.orderId])).get(p.orderId)).toMatchObject({ state: "completed", completedAt });
  });
});

describe("brief reference files", () => {
  test("attaches clean references and shows them to both parties", async () => {
    const s = await setupWithFiles();
    const a = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId, name: "a.png" });
    const b = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId, name: "b.png" });
    const orderId = await s.service.request({ ...s.request(), referenceFileIds: [b, a] });
    const buyerView = await s.service.getOrder({ actor: s.buyerActor, orderId });
    expect(buyerView.referenceFiles.map((file) => [file.name, file.availability])).toEqual([["b.png", "available"], ["a.png", "available"]]);
    const creatorView = await s.service.getOrder({ actor: s.creator.actor, orderId });
    expect(creatorView.referenceFiles.map((file) => file.name)).toEqual(["b.png", "a.png"]);
  });
  test("withdraws names from the creator after the request closes", async () => {
    const s = await setupWithFiles();
    const a = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId });
    const orderId = await s.service.request({ ...s.request(), referenceFileIds: [a] });
    await s.service.close({ actor: s.buyerActor, orderId, expectedVersion: 1, idempotencyKey: randomUUID(), requestId: randomUUID() });
    expect((await s.service.getOrder({ actor: s.creator.actor, orderId })).referenceFiles).toEqual([expect.objectContaining({ name: null, availability: "withdrawn" })]);
    expect((await s.service.getOrder({ actor: s.buyerActor, orderId })).referenceFiles).toEqual([expect.objectContaining({ name: "ref.png", availability: "available" })]);
  });
  test.each(["scanning", "foreign", "reused"] as const)("refuses a %s reference without creating an order", async (kind) => {
    const s = await setupWithFiles(); const other = await s.buyer();
    const bad = kind === "scanning" ? await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId, state: "scanning" })
      : kind === "foreign" ? await cleanFile({ keyring: s.input.keyring, ownerUserId: other.userId, packageId: s.packageId })
      : await (async () => { const id = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId }); await s.service.request({ ...s.request(), referenceFileIds: [id] }); return id; })();
    const before = (await ordersOf(s.buyerActor.userId)).length;
    await expect(s.service.request({ ...s.request(), referenceFileIds: [bad] })).rejects.toMatchObject({ code: "invalid_reference_files" });
    expect((await ordersOf(s.buyerActor.userId)).length).toBe(before);
  });
  test.each([[Array.from({ length: 11 }, () => randomUUID())], [(() => { const id = randomUUID(); return [id, id]; })()], [["not-a-uuid"]]])("rejects malformed reference lists", async (referenceFileIds) => {
    const s = await setupWithFiles();
    await expect(s.service.request({ ...s.request(), referenceFileIds })).rejects.toMatchObject({ code: "invalid_request" });
  });
  test("reports files_disabled when files are named but unavailable, and keeps text-only briefs working", async () => {
    const s = await setupWithFiles("disabled");
    const a = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId });
    await expect(s.service.request({ ...s.request(), referenceFileIds: [a] })).rejects.toMatchObject({ code: "files_disabled" });
    const noFiles = createCommissionOrderService(s.input);
    await expect(noFiles.request({ ...s.request(), referenceFileIds: [a] })).rejects.toMatchObject({ code: "files_disabled" });
    const orderId = await noFiles.request(s.request());
    expect((await noFiles.getOrder({ actor: s.buyerActor, orderId })).referenceFiles).toEqual([]);
    expect(await fixture.db.select().from(schema.commissionFileAttachments).where(and(eq(schema.commissionFileAttachments.orderId, orderId)))).toHaveLength(0);
  });
});

describe("idempotency fingerprint stability", () => {
  test("a no-files request keeps the exact I6 fingerprint shape", async () => {
    const s = await setupWithFiles();
    const command = s.request();
    await s.service.request(command);
    const [row] = await fixture.db.select({ requestFingerprint: schema.systemCommandIdempotency.requestFingerprint }).from(schema.systemCommandIdempotency)
      .where(and(eq(schema.systemCommandIdempotency.actorUserId, s.buyerActor.userId), eq(schema.systemCommandIdempotency.commandScope, "orders.commission.request")));
    const brief = normalizeCommissionBrief(command.brief);
    const i6Payload = [command.packageId, command.revisionId, command.policyRevisionId, command.acceptTerms, brief, command.abuseKeyHash];
    const expected = commissionCommandFingerprint(s.input.lookupHmacKey, "commission-command", ["request", s.buyerActor.userId, i6Payload]);
    expect(row!.requestFingerprint).toBe(expected);
  });
  test("replays the same key with the same references, but refuses a different reference list under the same key", async () => {
    const s = await setupWithFiles();
    const a = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId });
    const b = await cleanFile({ keyring: s.input.keyring, ownerUserId: s.buyerActor.userId, packageId: s.packageId });
    const command = { ...s.request(), referenceFileIds: [a] };
    const orderId = await s.service.request(command);
    await expect(s.service.request(command)).resolves.toBe(orderId);
    expect((await ordersOf(s.buyerActor.userId)).length).toBe(1);
    await expect(s.service.request({ ...command, referenceFileIds: [b] })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
