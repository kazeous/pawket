import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commissionFiles, systemOutbox } from "@pawket/database";
import { ClamdUnavailableError, CommissionFileStorageError, processCommissionFileScan } from "../src/index.js";
import { createFakeCommissionFileStorage, fakeScanner, sha256 } from "./fakes.js";
import { createCommissionFileFixture, fixtureAt } from "./file-fixture.js";

const fixture = createCommissionFileFixture("scan");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
let clock = fixtureAt;
const now = () => clock;
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);

async function scanning(bytes: Uint8Array | null, declaredBytes = PNG.byteLength) {
  const { buyerUserId, packageId } = await fixture.order();
  const fileId = await fixture.file({ ownerUserId: buyerUserId, packageId, state: "scanning", declaredBytes });
  const storage = createFakeCommissionFileStorage();
  if (bytes) storage.put("quarantine", `commission/${fileId}`, bytes);
  return { fileId, storage, buyerUserId };
}

/** An async iterable that records whether its iterator was closed, standing in for the S3 SDK body stream the processor must always release. */
function trackedStream(chunks: readonly Uint8Array[]): { iterable: AsyncIterable<Uint8Array>; returned: () => boolean } {
  let returned = false; let index = 0;
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          return index < chunks.length ? { done: false, value: chunks[index++]! } : { done: true, value: undefined };
        },
        async return(value?: unknown): Promise<IteratorResult<Uint8Array>> { returned = true; return { done: true, value: value as Uint8Array }; },
      };
    },
  };
  return { iterable, returned: () => returned };
}

describe("commission file scan", () => {
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
    expect(await fixture.read(fileId)).toMatchObject({ state: "rejected", rejectionReason: "size_mismatch", sha256: null });
    const unsent = await fixture.db.select().from(commissionFiles).where(and(eq(commissionFiles.ownerUserId, buyerUserId), inArray(commissionFiles.state, ["awaiting_upload", "scanning", "clean"])));
    expect(unsent).toHaveLength(0);
  });
  test("rejects size mismatches in either direction", async () => {
    clock = fixtureAt;
    const short = await scanning(PNG.subarray(0, 8));
    await expect(processCommissionFileScan({ db: fixture.db, storage: short.storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId: short.fileId, now })).resolves.toMatchObject({ reason: "size_mismatch" });
    const long = await scanning(PNG);
    vi.spyOn(long.storage.port, "open").mockResolvedValueOnce((async function* () { yield PNG; yield PNG; })());
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
    vi.spyOn(storage.port, "open").mockResolvedValueOnce((async function* () { yield PNG.subarray(0, 4); throw new Error("ECONNRESET"); })());
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ wrapSourceErrors: true, signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "storage_unavailable" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "scanning", nextScanAt: expect.any(Date), scanLeaseExpiresAt: null });
  });
  test("releases the quarantine stream when the declared size is exceeded", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const tracked = trackedStream([PNG, PNG]);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(tracked.iterable);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toMatchObject({ reason: "size_mismatch" });
    expect(tracked.returned()).toBe(true);
  });
  test("releases the quarantine stream when the scanner abandons it mid-read", async () => {
    // Mirrors the real clamd client: its own `for await` over the source throws (a rejected
    // socket write) after consuming some chunks, which must close the still-open source instead
    // of leaving it to be garbage-collected.
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const tracked = trackedStream([PNG]);
    vi.spyOn(storage.port, "open").mockResolvedValueOnce(tracked.iterable);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ abandonAfterChunks: 1, signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "retry", reason: "scanner_unavailable" });
    expect(tracked.returned()).toBe(true);
  });
  test("fails the scan once the 24-hour deadline passes", async () => {
    const { fileId, storage } = await scanning(PNG); clock = new Date(fixtureAt.getTime() + 86_400_000);
    await expect(processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })).resolves.toEqual({ outcome: "scan_failed" });
    expect(await fixture.read(fileId)).toMatchObject({ state: "scan_failed", endedAt: clock });
  });
  test("lets only one worker hold the lease", async () => {
    clock = fixtureAt; const { fileId, storage } = await scanning(PNG);
    const results = await Promise.all([1, 2].map(() => processCommissionFileScan({ db: fixture.db, storage: storage.port, scanner: fakeScanner({ signatureDate: () => clock }), fileId, now })));
    expect(results.map((result) => result.outcome).sort()).toEqual(["clean", "skipped"]);
  });
});
