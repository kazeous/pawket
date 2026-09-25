import { describe, expect, it } from "vitest";
import { creatorTipErrorText, readCreatorTip, readCreatorTipQueue, readCreatorTipSettings } from "../src/ui/tips/creator-tip-client";

const pending = { id: "10000000-0000-4000-8000-000000000001", reference: "PW0123456789ABCDEF0123", amountVnd: 50_000, state: "awaiting_transfer", settlementLane: "manual_attested", confirmationSource: null, expiresAt: "2026-10-01T00:00:00Z", transferClaimedAt: null, confirmedAt: null };
const policy = { revisionId: "10000000-0000-4000-8000-000000000002", revisionNumber: 1, minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000], effectiveAt: "2026-09-22T00:00:00Z" };
const initialSettings = { revisionId: null, revisionNumber: 0, enabled: false, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000], platformPolicyRevisionId: null, effectivePolicy: policy, effectivePresetsVnd: [20_000, 50_000, 100_000], presetsFallback: false };
describe("creator tip UI privacy boundary", () => {
  it("rejects guest content on unpaid rows and strips all unrelated fields", () => {
    expect(readCreatorTip({ ...pending, accountNumber: "private", sessionId: "secret" })).toEqual(pending);
    expect(() => readCreatorTip({ ...pending, guestContent: { name: "hidden", message: "hidden" } })).toThrow("dependency_unavailable");
    const confirmed = { ...pending, state: "confirmed", confirmationSource: "creator_manual", confirmedAt: "2026-09-30T00:00:00Z", guestContent: { name: "Guest", message: "<script>literal text</script>" } };
    expect(readCreatorTip({ ...confirmed, guestContent: { ...confirmed.guestContent, secret: "private" } })).toEqual(confirmed);
    expect(() => readCreatorTip({ ...confirmed, guestContent: { name: "x".repeat(81), message: null } })).toThrow("dependency_unavailable");
  });
  it.each([{ state: "__proto__" }, { reference: "secret?" }, { amountVnd: 0.5 }, { amountVnd: 5_000_001 }, { expiresAt: "invalid" }, { confirmedAt: "2026-09-30T00:00:00Z" }, { transferClaimedAt: 42 }])("rejects malformed queue row %j", (change) => {
    expect(() => readCreatorTip({ ...pending, ...change })).toThrow("dependency_unavailable");
  });
  it("bounds queue pages and validates opaque cursors", () => {
    expect(readCreatorTipQueue({ queue: { items: [pending], nextCursor: null } }).items).toEqual([pending]);
    for (const q of [{ items: new Array(101).fill(pending), nextCursor: null }, { items: [], nextCursor: "https://evil.test" }]) expect(() => readCreatorTipQueue({ queue: q })).toThrow("dependency_unavailable");
  });
  it("accepts initial opt-out settings and refuses malformed revisions or policies", () => {
    const settings = initialSettings;
    expect(readCreatorTipSettings({ ...settings, available: true, private: "discard" })).toEqual(settings);
    for (const change of [{ revisionNumber: 1 }, { revisionNumber: -1 }, { presetsVnd: [20_000, 20_000, 100_000] }, { maximumVnd: 5_000_001 }]) expect(() => readCreatorTipSettings({ ...settings, ...change })).toThrow("dependency_unavailable");
    expect(creatorTipErrorText("private account or credential")).not.toContain("private");
  });
  it("keeps saved choices separate from verified fallback and strips private policy fields", () => {
    const updated = { ...policy, revisionNumber: 2, minimumVnd: 30_000, allowedPresetsVnd: [30_000, 50_000, 100_000, 200_000] };
    const fallback = { ...initialSettings, effectivePolicy: updated, effectivePresetsVnd: [30_000, 50_000, 100_000], presetsFallback: true };
    expect(readCreatorTipSettings({ ...fallback, effectivePolicy: { ...updated, reason: "owner private reason", actorUserId: "owner" } })).toEqual(fallback);
    for (const change of [{ presetsFallback: false }, { effectivePresetsVnd: [30_000, 100_000, 200_000] }, { effectivePresetsVnd: [] }, { platformPolicyRevisionId: "invalid" }]) expect(() => readCreatorTipSettings({ ...fallback, ...change })).toThrow("dependency_unavailable");
  });
  it("accepts unavailable policy without inventing effective amounts", () => {
    const unavailable = { ...initialSettings, effectivePolicy: null, effectivePresetsVnd: [], presetsFallback: false };
    expect(readCreatorTipSettings(unavailable)).toEqual(unavailable);
    expect(() => readCreatorTipSettings({ ...unavailable, effectivePresetsVnd: initialSettings.presetsVnd })).toThrow("dependency_unavailable");
  });
});
