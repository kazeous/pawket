import { Readable } from "node:stream";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commissionFiles, systemOutbox } from "@pawket/database";
import { ClamdUnavailableError, CommissionFileStorageError, createS3CommissionFileStorage, processCommissionFileScan, runCommissionFileMaintenance, noCommissionFileEvidenceHolds } from "../src/index.js";
import { createFakeCommissionFileStorage, fakeScanner, sha256 } from "./fakes.js";
import { createCommissionFileFixture, fixtureAt } from "./file-fixture.js";

const fixture = createCommissionFileFixture("scan");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
let clock = fixtureAt;
const now = () => clock;
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);

async function scanning(bytes: Uint8Array | null, declaredBytes = PNG.byteLength) {
  const { buyerUserId, packageId, orderId } = await fixture.order();
  const fileId = await fixture.file({ ownerUserId: buyerUserId, packageId, state: "scanning", declaredBytes });
  const storage = createFakeCommissionFileStorage();
  if (bytes) storage.put("quarantine", `commission/${fileId}`, bytes);
  return { fileId, storage, buyerUserId, orderId };
}

// Real node:stream Readables stand in for the S3 SDK body stream here — a plain-object async
// iterable would let a processor bug that never calls destroy() pass unnoticed, since only a
// real stream's own release semantics (a stream's async iterator queues .return() behind an
// already-pending .next(), but .destroy() tears it down synchronously) can expose that bug.
/** A Readable yielding the given chunks then ending normally. */
function readableOf(chunks: readonly Uint8Array[]): Readable {
  return Readable.from(chunks);
}
/** A Readable that pushes one chunk, then errors on the next read — a dropped connection mid-stream. */
function readableThatErrorsAfter(chunk: Uint8Array, error: Error): Readable {
  let pushed = false;
  return new Readable({ read() { if (!pushed) { pushed = true; this.push(chunk); return; } this.destroy(error); } });
}
/** A Readable that pushes one chunk and then stalls forever — never ends, never errors — until destroyed. */
function stalledReadable(chunk: Uint8Array): Readable {
  let pushed = false;
  return new Readable({ read() { if (!pushed) { pushed = true; this.push(chunk); } /* else: stall, simulating a dropped connection that never sends FIN/RST */ } });
}

describe("commission file scan", () => {
  test("a silent pre-header provider releases the processor for the next job", async () => {
    clock = fixtureAt; const { fileId } = await scanning(PNG); const sockets = new Set<Socket>();
    const server = createServer((socket) => { sockets.add(socket); socket.on("data", () => undefined); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const storage = createS3CommissionFileStorage({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: "us-east-1",
        accessKeyId: "synthetic", secretAccessKey: "synthetic", quarantineBucket: "test-quarantine", cleanBucket: "test-clean", operationTimeoutMs: 150 });
      await expect(processCommissionFileScan({ db: fixture.db, storage, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "storage_unavailable" });
      expect(await fixture.read(fileId)).toMatchObject({ state: "scanning", scanLeaseExpiresAt: null, nextScanAt: expect.any(Date) });
      const next = await scanning(PNG);
      await expect(processCommissionFileScan({ db: fixture.db, storage: next.storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId: next.fileId, now })).resolves.toEqual({ outcome: "clean" });
      await new Promise((resolve) => setTimeout(resolve, 50)); expect(sockets.size).toBe(0);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  test.each(["late-success", "ambiguous-failure", "crash"] as const)("reconciles every late copy version after terminal purge (%s)", async (mode) => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG); const key = `commission/${fileId}`;
    let start!: () => void; const started = new Promise<void>((resolve) => { start = resolve; });
    let finish!: () => void; const finished = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(storage.port, "copyToClean").mockImplementation(async () => {
      expect((await fixture.read(fileId)).cleanCopyIntent).toBe(true);
      start();
      if (mode === "ambiguous-failure") throw new CommissionFileStorageError("unavailable");
      if (mode === "crash") throw new Error("simulated process loss after provider acceptance");
      await finished;
      return { versionId: storage.put("clean", key, PNG) };
    });
    // Catch immediately so the simulated process-loss rejection never becomes unhandled.
    const pending = processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now }).catch((error: unknown) => error);
    await started;
    if (mode !== "late-success") {
      const result = await pending;
      if (mode === "ambiguous-failure") expect(result).toEqual({ outcome: "retry", reason: "storage_unavailable" });
      else expect(result).toBeInstanceOf(Error);
    }
    const row = await fixture.read(fileId);
    await fixture.db.update(commissionFiles).set({ state: "discarded", endedAt: clock, scanLeaseExpiresAt: null, nextScanAt: null, version: row.version + 1 }).where(eq(commissionFiles.id, fileId));
    const sweep = () => runCommissionFileMaintenance({ db: fixture.db, storage: storage.port, orders: { retentionFacts: async () => new Map() },
      holds: noCommissionFileEvidenceHolds, retentionMode: "report_only", batchSize: 500, enqueueScan: async () => undefined, now });
    await sweep();
    expect(await fixture.read(fileId)).toMatchObject({ state: "discarded", cleanCopyIntent: true, cleanPurgedAt: null, filenameEnvelope: null });
    // Provider work already accepted can finish after request failure or process loss too.
    if (mode === "late-success") { finish(); expect(await pending).toEqual({ outcome: "skipped" }); }
    else storage.put("clean", key, PNG);
    storage.put("clean", key, PNG);
    expect(storage.has("clean", key)).toBe(true);
    await sweep();
    expect(storage.has("clean", key)).toBe(false);
    expect(await fixture.read(fileId)).toMatchObject({ state: "discarded", cleanPurgedAt: null });
    // There is deliberately no final completion stamp: an arbitrarily later accepted write is covered.
    storage.put("clean", key, PNG); await sweep(); expect(storage.has("clean", key)).toBe(false);
  });
  test("maintenance never deletes a live winning clean or attached copy with intent", async () => {
    clock = fixtureAt; const { fileId, storage, orderId } = await scanning(PNG);
    expect(await processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).toEqual({ outcome: "clean" });
    await runCommissionFileMaintenance({ db: fixture.db, storage: storage.port, orders: { retentionFacts: async () => new Map() }, holds: noCommissionFileEvidenceHolds,
      retentionMode: "report_only", batchSize: 500, enqueueScan: async () => undefined, now });
    expect(storage.has("clean", `commission/${fileId}`)).toBe(true);
    expect(await fixture.read(fileId)).toMatchObject({ state: "clean", cleanCopyIntent: true, filenameEnvelope: expect.any(Object) });
    await fixture.attach(fileId, orderId);
    await runCommissionFileMaintenance({ db: fixture.db, storage: storage.port, orders: { retentionFacts: async () => new Map() }, holds: noCommissionFileEvidenceHolds,
      retentionMode: "report_only", batchSize: 500, enqueueScan: async () => undefined, now });
    expect(storage.has("clean", `commission/${fileId}`)).toBe(true);
    expect(await fixture.read(fileId)).toMatchObject({ state: "attached", cleanCopyIntent: true, filenameEnvelope: expect.any(Object) });
  });
  test("copies a clean PNG, records evidence and purges quarantine", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "clean" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "clean", sha256: sha256(PNG), detectedType: "png", scanLeaseExpiresAt: null, quarantinePurgedAt: expect.any(Date), cleanVersionId: expect.any(String) });
    expect(storage.has("clean", `commission/${fileId}`)).toBe(true);
    expect(storage.has("quarantine", `commission/${fileId}`)).toBe(false);
    const events = await fixture.db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, fileId), eq(systemOutbox.eventType, "commission.file_scanned.v1")));
    expect(events.map((event) => event.payload)).toEqual([{ fileId, outcome: "clean" }]);
  });
  test("rejects a completion with no uploaded object and frees the unsent slot", async () => {
    clock = fixtureAt; const { fileId, storage, buyerUserId } = await scanning(null);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "rejected", reason: "size_mismatch" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "rejected", rejectionReason: "size_mismatch", sha256: null, filenameEnvelope: null });
    const unsent = await fixture.db.select().from(commissionFiles).where(and(eq(commissionFiles.ownerUserId, buyerUserId), inArray(commissionFiles.state, ["awaiting_upload", "scanning", "clean"])));
    expect(unsent).toHaveLength(0);
  });
  test("rejects size mismatches in either direction", async () => {
    clock = fixtureAt;
    const short = await scanning(PNG.subarray(0, 8));
    await expect(processCommissionFileScan({ db: fixture.db, storage: short.storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId: short.fileId, now })).resolves.toMatchObject({ reason: "size_mismatch" });
    const long = await scanning(PNG);
    vi.spyOn(long.storage.port, "open").mockResolvedValueOnce(readableOf([PNG, PNG]));
    await expect(processCommissionFileScan({ db: fixture.db, storage: long.storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId: long.fileId, now })).resolves.toMatchObject({ reason: "size_mismatch" });
    expect(long.storage.has("clean", `commission/${long.fileId}`)).toBe(false);
  });
  test.each([
    [{ kind: "found", reason: "malware", signature: "Eicar-Signature" }, "malware", "Eicar-Signature"],
    [{ kind: "found", reason: "encrypted_archive", signature: "Heuristics.Encrypted.Zip" }, "encrypted_archive", null],
    [{ kind: "found", reason: "limits_exceeded", signature: "Heuristics.Limits.Exceeded.MaxFiles" }, "limits_exceeded", null],
  ] as const)("rejects a %j verdict without copying", async (verdict, reason, signature) => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ verdict, signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "rejected", reason });
    expect(await fixture.read(fileId)).toMatchObject({ state: "rejected", rejectionReason: reason, malwareSignature: signature });
    expect(storage.copies()).toBe(0);
  });
  test("rejects a renamed executable by its bytes", async () => {
    clock = fixtureAt; const exe = new Uint8Array(16); exe.set([0x4d, 0x5a]); const { fileId, storage } = await scanning(exe);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "rejected", reason: "type_not_allowed" });
  });
  test("schedules a retry when clamd is unavailable and honours the delay", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const down = fakeScanner({ error: new ClamdUnavailableError("connect"), signatureDate: () => clock });
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: down, fileId, now })).resolves.toEqual({ outcome: "retry", reason: "scanner_unavailable" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "scanning", scanAttempts: 1, nextScanAt: new Date(fixtureAt.getTime() + 60_000), scanLeaseExpiresAt: null });
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "skipped" });
    clock = new Date(fixtureAt.getTime() + 61_000);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "clean" });
  });
  test("treats stale signatures as unavailable without reading the object", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG); const head = vi.spyOn(storage.port, "head");
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => new Date(clock.getTime() - 86_400_001) }), fileId, now }))
      .resolves.toEqual({ outcome: "retry", reason: "signatures_stale" });
    expect(head).not.toHaveBeenCalled();
  });
  test("retries a failed copy instead of marking the file clean", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    vi.spyOn(storage.port, "copyToClean").mockRejectedValueOnce(new CommissionFileStorageError("unavailable"));
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "storage_unavailable" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "scanning", sha256: null });
  });
  test("ends a mid-stream storage read failure as a scheduled retry, never clean or an unhandled throw", async () => {
    // The real clamd client re-wraps anything its source throws as its own ClamdUnavailableError
    // (see clamd-client.ts), so a scanner that behaves like the real one is used here — a fake
    // that merely passed the raw storage error through would prove nothing about production.
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(readableThatErrorsAfter(PNG.subarray(0, 4), new Error("ECONNRESET")));
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ wrapSourceErrors: true, signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "storage_unavailable" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "scanning", nextScanAt: expect.any(Date), scanLeaseExpiresAt: null });
  });
  test("releases the quarantine stream when the declared size is exceeded", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const readable = readableOf([PNG, PNG]);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(readable);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toMatchObject({ reason: "size_mismatch" });
    expect(readable.destroyed).toBe(true);
  });
  test("releases the quarantine stream when the scanner abandons it mid-read", async () => {
    // Mirrors the real clamd client: its own `for await` over the source throws (a rejected
    // socket write) after consuming some chunks, which must close the still-open source instead
    // of leaving it to be garbage-collected.
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const readable = readableOf([PNG]);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(readable);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ abandonAfterChunks: 1, signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "scanner_unavailable" });
    expect(readable.destroyed).toBe(true);
  });
  test("destroys the quarantine stream without ever reading it when the scanner never starts", async () => {
    // Calling .return() on a never-started async generator completes it without running its
    // body/finally, so the stream is never destroyed that way; release here must happen from the
    // outer flow, by destroying the real stream resource directly, independent of the generator.
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const readable = readableOf([PNG]);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(readable);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ rejectBeforeReading: new ClamdUnavailableError("connect"), signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "scanner_unavailable" });
    expect(readable.destroyed).toBe(true);
  });
  test("destroys a stalled quarantine stream within a bounded time instead of hanging the scan", async () => {
    // A stream's async iterator queues .return() behind an already-pending .next(), so awaiting
    // that close hangs forever against a source that never pushes another chunk. destroy() must
    // unblock this on its own, promptly, instead of leaving the job pending indefinitely.
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const readable = stalledReadable(PNG);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(readable);
    const startedAt = Date.now();
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ timeoutAfterMs: 50, signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "scanner_unavailable" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(readable.destroyed).toBe(true);
  });
  test("fails the scan once the 24-hour deadline passes", async () => {
    const { fileId, storage } = await scanning(PNG); clock = new Date(fixtureAt.getTime() + 86_400_000);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "scan_failed" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "scan_failed", endedAt: clock, filenameEnvelope: null });
  });
  test("lets only one worker hold the lease", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const results = await Promise.all([1, 2].map(() => processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })));
    expect(results.map((result) => result.outcome).sort()).toEqual(["clean", "skipped"]);
  });
});
