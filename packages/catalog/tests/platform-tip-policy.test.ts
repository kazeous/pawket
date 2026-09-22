import { expect, test } from "vitest";
import { PLATFORM_TIP_POLICY_BOOTSTRAP_ID, type PawketDatabase } from "@pawket/database";
import { createPlatformTipPolicyService, readPlatformTipPolicySnapshot } from "../src/platform-tip-policy.js";

const valid = { revisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, revisionNumber: 1,
  minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000],
  effectiveAt: "2026-09-22T00:00:00.000Z" };

test("snapshot projection copies ordered amounts and freezes evidence", () => {
  const input = { ...valid, allowedPresetsVnd: [100_000, 50_000, 20_000] };
  const result = readPlatformTipPolicySnapshot(input)!;
  expect(result).toEqual({ ...valid, allowedPresetsVnd: [100_000, 50_000, 20_000] });
  input.allowedPresetsVnd[0] = 200_000;
  expect(result.allowedPresetsVnd[0]).toBe(100_000);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.allowedPresetsVnd)).toBe(true);
});

test.each([
  null, [], {}, { ...valid, revisionId: "bad" }, { ...valid, revisionNumber: 0 },
  { ...valid, effectiveAt: "yesterday" }, { ...valid, effectiveAt: "2026-02-30T00:00:00.000Z" },
  { ...valid, minimumVnd: 9_999 }, { ...valid, maximumVnd: 5_000_001 },
  { ...valid, minimumVnd: 100_001, maximumVnd: 100_000 }, { ...valid, minimumVnd: 10_000.5 },
  { ...valid, allowedPresetsVnd: [20_000, 50_000] }, { ...valid, allowedPresetsVnd: [20_000, 20_000, 100_000] },
  { ...valid, allowedPresetsVnd: [20_000, 50_000, "100000"] }, { ...valid, allowedPresetsVnd: [20_000, 50_000, null] },
  { ...valid, allowedPresetsVnd: [20_000, 50_000, 10_000.5] },
  { ...valid, allowedPresetsVnd: Array.from({ length: 11 }, (_, i) => 10_000 + i) },
  { ...valid, actorUserId: "owner" }, { ...valid, reason: "Private reason" },
  Object.create(valid), { ...valid, allowedPresetsVnd: new Array(3) },
  { ...valid, allowedPresetsVnd: Object.assign([20_000, 50_000, 100_000], { extra: 1 }) },
])("rejects malformed policy projection %#", (input) => expect(readPlatformTipPolicySnapshot(input)).toBeNull());

test("snapshot rejects accessors without evaluating them", () => {
  const unexpected = () => { throw new Error("Accessor must not run"); };
  expect(readPlatformTipPolicySnapshot(Object.defineProperty({ ...valid }, "minimumVnd", { get: unexpected }))).toBeNull();
  const amounts = Object.defineProperty([20_000, 50_000, 100_000], "0", { get: unexpected });
  expect(readPlatformTipPolicySnapshot({ ...valid, allowedPresetsVnd: amounts })).toBeNull();
});

test("invalid commands fail before database, authorization or proof operations", async () => {
  const unexpected = () => { throw new Error("Unexpected port call"); };
  const service = createPlatformTipPolicyService({ db: { transaction: unexpected } as unknown as PawketDatabase,
    applicationRevision: "test-revision", commandFingerprintKey: new Uint8Array(32), authorizeOwner: unexpected, requireOwnerStepUp: unexpected });
  const command = { actor: { userId: "owner", sessionId: "owner-session" }, expectedRevision: 1,
    minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000],
    reason: "Change policy", idempotencyKey: "test-command-key", requestId: "request-1" };
  for (const patch of [{ reason: " x " }, { reason: "x\nreason" }, { reason: "a".repeat(501) }, { expectedRevision: 0 },
    { idempotencyKey: "short" }, { requestId: "bad request" }, { minimumVnd: 0 }, { allowedPresetsVnd: [20_000, 50_000] }]) {
    await expect(service.savePolicy({ ...command, ...patch })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }
  await expect(service.getHistory({ actor: command.actor, limit: 51 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(service.getHistory({ actor: command.actor, beforeRevision: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
