import { createHash, randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { beginIdempotentCommand, type PawketDatabase } from "@pawket/database";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";
import { createContentHideService } from "../src/content-hide-service.js";

vi.mock("@pawket/database", async (original) => ({ ...await original<typeof import("@pawket/database")>(), beginIdempotentCommand: vi.fn() }));

test.each(["hide", "restore", "report_close"] as const)("%s replay fingerprints maximum four-byte reasons with a SHA-256 pre-digest", async (action) => {
  const reference = randomUUID(); const key = new Uint8Array(32).fill(74); const tx = {};
  vi.mocked(beginIdempotentCommand).mockResolvedValue({ kind: "replay", recordId: randomUUID(), resultReference: reference });
  const consume = vi.fn();
  const service = createContentHideService({ db: { transaction: async (run: (value: unknown) => Promise<unknown>) => run(tx) } as unknown as PawketDatabase,
    mode: "enabled", keyring: createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(73) } }), lookupHmacKey: key,
    applicationRevision: "synthetic", consumeStepUpProof: consume, fence: { lockCreatorFence: vi.fn() } });
  const command = { owner: { userId: "owner", sessionId: "session" }, stepUpProofId: randomUUID(), idempotencyKey: randomUUID(), requestId: randomUUID(),
    caseId: randomUUID(), expectedCaseVersion: 2_147_483_646, reason: "\u{1f600}".repeat(2_000) };
  const hideId = action === "restore" ? randomUUID() : null; const resolution = action === "report_close" ? "actioned" as const : null;
  async function execute(c: typeof command) {
    if (action === "hide") return service.hide(c);
    if (hideId) return service.restore({ ...c, hideId });
    return service.closeReportCase({ ...c, resolution: resolution! });
  }
  const first = await execute(command);
  expect(await execute({ ...command, stepUpProofId: randomUUID(), requestId: randomUUID() })).toEqual(first);
  const digest = createHash("sha256").update(JSON.stringify([action, command.caseId, command.expectedCaseVersion, command.reason, hideId, resolution])).digest("hex");
  expect(beginIdempotentCommand).toHaveBeenLastCalledWith(tx, expect.objectContaining({ requestFingerprint: createLookupHmac({ key, context: "trust-content-command", value: digest }) }));
  expect(consume).not.toHaveBeenCalled();
});
