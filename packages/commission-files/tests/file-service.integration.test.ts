import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commissionFiles, commissionOrders, systemOutbox, type PawketTransaction } from "@pawket/database";
import { createCommissionFileService, type CommissionFileOrderAccessPort } from "../src/index.js";
import { createFakeCommissionFileStorage } from "./fakes.js";
import { createCommissionFileFixture, fixtureAt, fixtureKeyring, fixtureLookupKey } from "./file-fixture.js";

const fixture = createCommissionFileFixture("service");
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);
let clock = fixtureAt;
const sessions = new Map<string, string>();
const sessionPort = { getTipSessionAssurance: async (_tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date) =>
  sessions.get(actor.userId) === actor.sessionId ? { sessionExpiresAt: new Date(at.getTime() + 600_000) } : null };
// Test double of the Orders-owned port; production uses createCommissionFileAccessPort from @pawket/orders.
const orders: Pick<CommissionFileOrderAccessPort, "briefPackage" | "orderAccess"> = {
  async briefPackage(tx, { packageId, actorUserId }) {
    const [row] = await tx.select({ creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.packageId, packageId)).limit(1);
    return row && row.creatorUserId !== actorUserId ? row : null;
  },
  async orderAccess(tx, { orderId, actorUserId }) {
    const [row] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, orderId), or(eq(commissionOrders.buyerUserId, actorUserId), eq(commissionOrders.creatorUserId, actorUserId)))).limit(1);
    return row ? { role: row.buyerUserId === actorUserId ? "buyer" : "creator", state: row.state, confirmedAt: row.confirmedAt, closedAt: row.closedAt } : null;
  },
};
function service(mode: "disabled" | "enabled" = "enabled") {
  const storage = createFakeCommissionFileStorage();
  const presignUpload = vi.spyOn(storage.port, "presignUpload"); const presignDownload = vi.spyOn(storage.port, "presignDownload");
  return { storage, presignUpload, presignDownload, files: createCommissionFileService({ db: fixture.db, storage: storage.port, keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey,
    mode, sessions: sessionPort, orders, now: () => clock }) };
}
async function participants() {
  const order = await fixture.order();
  const buyer = { userId: order.buyerUserId, sessionId: `s-${randomUUID()}` }; const creator = { userId: order.creatorUserId, sessionId: `s-${randomUUID()}` };
  sessions.set(buyer.userId, buyer.sessionId); sessions.set(creator.userId, creator.sessionId);
  return { ...order, buyer, creator };
}
const ids = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });

describe("commission file service", () => {
  test("issues an exact-size grant, stores the name encrypted and replays the same file", async () => {
    clock = fixtureAt; const p = await participants(); const s = service(); const command = { actor: p.buyer, context: "brief" as const, packageId: p.packageId, fileName: "mẫu nhân vật.png", declaredBytes: 1234, ...ids() };
    const first = await s.files.createUpload(command);
    expect(s.presignUpload).toHaveBeenCalledWith({ key: `commission/${first.fileId}`, contentLength: 1234, expiresInSeconds: 900 });
    const row = await fixture.read(first.fileId);
    expect(row).toMatchObject({ state: "awaiting_upload", declaredBytes: 1234, ownerUserId: p.buyer.userId, uploadExpiresAt: new Date(fixtureAt.getTime() + 900_000) });
    expect(JSON.stringify(row.filenameEnvelope)).not.toContain("nhân");
    expect((await s.files.createUpload(command)).fileId).toBe(first.fileId);
    expect(await fixture.db.select().from(commissionFiles).where(eq(commissionFiles.ownerUserId, p.buyer.userId))).toHaveLength(1);
  });
  test.each([[26_214_401, "file_too_large"], [0, "invalid_request"], [1.5, "invalid_request"]] as const)("refuses %s bytes with %s", async (declaredBytes, code) => {
    const p = await participants();
    await expect(service().files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes, ...ids() })).rejects.toMatchObject({ code });
  });
  test("enforces the 10 unsent references limit and frees a slot on discard", async () => {
    clock = fixtureAt; const p = await participants(); const s = service(); const created: string[] = [];
    for (let index = 0; index < 10; index += 1) created.push((await s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: `r${index}.png`, declaredBytes: 10, ...ids() })).fileId);
    await expect(s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "r10.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "pending_limit" });
    await expect(s.files.discard({ actor: p.buyer, fileId: created[0]! })).resolves.toMatchObject({ state: "discarded" });
    await expect(s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "r10.png", declaredBytes: 10, ...ids() })).resolves.toMatchObject({ fileId: expect.any(String) });
  });
  test("refuses disabled mode, a stale session and a creator uploading to their own package", async () => {
    const p = await participants(); const disabled = service("disabled"); const transaction = vi.spyOn(fixture.db, "transaction");
    await expect(disabled.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "files_disabled" });
    expect(transaction).not.toHaveBeenCalled(); transaction.mockRestore();
    await expect(service().files.createUpload({ actor: { ...p.buyer, sessionId: "revoked-session" }, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(service().files.createUpload({ actor: p.creator, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "not_available" });
  });
  test("completes once, emits one minimal event and expires stale grants", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const { fileId } = await s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() });
    clock = new Date(fixtureAt.getTime() + 60_000);
    await expect(s.files.completeUpload({ actor: p.buyer, fileId, requestId: "req-complete-1" })).resolves.toMatchObject({ state: "scanning", name: "a.png" });
    await expect(s.files.completeUpload({ actor: p.buyer, fileId, requestId: "req-complete-2" })).resolves.toMatchObject({ state: "scanning" });
    const events = await fixture.db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, fileId), eq(systemOutbox.eventType, "commission.file_uploaded.v1")));
    expect(events.map((event) => event.payload)).toEqual([{ fileId, correlationId: "req-complete-1" }]);
    const late = await s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "b.png", declaredBytes: 10, ...ids() });
    clock = new Date(clock.getTime() + 900_000);
    await expect(s.files.completeUpload({ actor: p.buyer, fileId: late.fileId, requestId: "req-late" })).rejects.toMatchObject({ code: "upload_expired" });
    await expect(s.files.completeUpload({ actor: p.creator, fileId, requestId: "req-other" })).rejects.toMatchObject({ code: "not_available" });
  });
  test("grants downloads to both parties with a safe disposition", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const png = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId, name: 'ảnh "mẫu".png' });
    await fixture.attach(png, p.orderId, 0);
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: png, disposition: "inline" })).resolves.toMatchObject({ url: expect.stringContaining("signed=1") });
    expect(s.presignDownload).toHaveBeenLastCalledWith(expect.objectContaining({ key: `commission/${png}`, versionId: "c-fixture", contentType: "image/png", expiresInSeconds: 300,
      contentDisposition: expect.stringMatching(/^inline; filename="[^"]*"; filename\*=UTF-8''/u) }));
    await expect(s.files.downloadGrant({ actor: p.creator, orderId: p.orderId, fileId: png, disposition: "attachment" })).resolves.toMatchObject({ url: expect.any(String) });
  });
  test("refuses strangers, unattached files and inline PDFs", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const loose = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId });
    const pdf = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId, name: "brief.pdf", detectedType: "pdf" });
    await fixture.attach(pdf, p.orderId, 0);
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: loose, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: pdf, disposition: "inline" })).rejects.toMatchObject({ code: "preview_not_allowed" });
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: pdf, disposition: "attachment" })).resolves.toMatchObject({ url: expect.any(String) });
    const stranger = await participants();
    await expect(s.files.downloadGrant({ actor: stranger.buyer, orderId: p.orderId, fileId: pdf, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
  });
  test("removes the creator's access when the request closes before payment", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const fileId = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId });
    await fixture.attach(fileId, p.orderId, 0);
    await fixture.closeOrder(p.orderId, p.buyerUserId);
    await expect(s.files.downloadGrant({ actor: p.creator, orderId: p.orderId, fileId, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId, disposition: "attachment" })).resolves.toMatchObject({ url: expect.any(String) });
  });
});
