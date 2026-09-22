import { describe, expect, it } from "vitest";
import { readOwnerTipPolicyData, ownerTipPolicyError } from "../src/app/admin/tip-policy/owner-tip-policy-client";
import { readTipPolicy, tipPolicyDraft, validateTipPolicyDraft, type TipPolicyDraft } from "../src/ui/tips/tip-policy-client";
import { readTipOffering } from "../src/ui/tips/tip-client";

const policy = { revisionId: "10000000-0000-4000-8000-000000000001", revisionNumber: 1, minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000], effectiveAt: "2026-09-22T00:00:00Z" };
const initial = { policy, history: { revisions: [{ ...policy, origin: "system_bootstrap", actorUserId: null, reason: "Bootstrap", previousPolicy: null }], nextBeforeRevision: null }, paymentsEnabled: false, publishingEnabled: false };

describe("owner tip policy form boundaries", () => {
  it("validates an ordered policy and produces only the exact command fields", () => {
    const result = validateTipPolicyDraft({ ...tipPolicyDraft(policy), presets: ["50000", "20000", "100000", "200000"], reason: "  Update defaults  " }, 4);
    expect(result.errors).toEqual({});
    expect(result.command).toEqual({ expectedRevision: 4, minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [50_000, 20_000, 100_000, 200_000], reason: "Update defaults" });
  });
  it.each([
    [{ minimum: "0" }, "minimum"], [{ minimum: "10.000" }, "minimum"], [{ minimum: "1e4" }, "minimum"], [{ maximum: "5000001" }, "maximum"],
    [{ minimum: "100000", maximum: "20000" }, "maximum"], [{ presets: ["20000", "020000", "100000"] }, "preset-1"],
    [{ presets: ["20000", "50000", "9999"] }, "preset-2"], [{ presets: ["20000", "50000"] }, "presets"],
    [{ reason: "ab" }, "reason"], [{ reason: "x".repeat(501) }, "reason"], [{ reason: "abc\ndef" }, "reason"],
  ] as [Partial<TipPolicyDraft>, string][])("rejects invalid form values %j", (change, field) => {
    const result = validateTipPolicyDraft({ ...tipPolicyDraft(policy), reason: "Change defaults", ...change }, 1);
    expect(result.command).toBeNull(); expect(result.errors).toHaveProperty(field);
  });
  it("strips session evidence from policy and paginated history", () => {
    expect(readTipPolicy({ ...policy, actorSessionId: "private", reason: "owner only" })).toEqual(policy);
    expect(readOwnerTipPolicyData({ ...initial, history: { ...initial.history, revisions: [{ ...initial.history.revisions[0], actorSessionId: "secret", requestId: "private" }] } })).toEqual(initial);
    expect(ownerTipPolicyError("sensitive error details")).not.toContain("sensitive");
  });
  it("rejects malformed history, previous snapshots, cursor and policy values", () => {
    for (const input of [
      { ...initial, paymentsEnabled: "false" },
      { ...initial, history: { revisions: [], nextBeforeRevision: "https://invalid.example" } },
      { ...initial, history: { revisions: new Array(26).fill(initial.history.revisions[0]), nextBeforeRevision: 1 } },
      { ...initial, history: { revisions: [{ ...initial.history.revisions[0], previousPolicy: policy }], nextBeforeRevision: null } },
      { ...initial, policy: { ...policy, allowedPresetsVnd: [20_000, 20_000, 100_000] } },
    ]) expect(() => readOwnerTipPolicyData(input)).toThrow("dependency_unavailable");
    expect(readOwnerTipPolicyData({ ...initial, policy: null, history: { revisions: [], nextBeforeRevision: null } }).policy).toBeNull();
  });
});

describe("public policy refresh projection", () => {
  const offering = { canonicalHandle: "artist", displayName: "Artist", minimumVnd: 30_000, maximumVnd: 500_000, presetsVnd: [30_000, 50_000, 100_000] };
  it("retains only public effective choices for the same creator", () => {
    expect(readTipOffering({ offering: { ...offering, reason: "private", actorUserId: "owner", accountNumber: "hidden" } }, "artist")).toEqual(offering);
  });
  it.each([null, { ...offering, canonicalHandle: "other" }, { ...offering, presetsVnd: [20_000, 50_000, 100_000] }, { ...offering, presetsVnd: [30_000, 30_000, 100_000] }, { ...offering, maximumVnd: 5_000_001 }])("refuses unusable refresh %j", (value) => {
    expect(() => readTipOffering({ offering: value }, "artist")).toThrow("dependency_unavailable");
  });
});
