import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCommissionFileAttachmentPort } from "@pawket/commission-files";
import { createCommissionOrderService } from "@pawket/orders";
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
