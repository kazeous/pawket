import { describe, expect, it } from "vitest";
import { creatorTipErrorText, readCreatorTip, readCreatorTipQueue, readCreatorTipSettings } from "../src/ui/tips/creator-tip-client";

const pending = { id: "10000000-0000-4000-8000-000000000001", reference: "PW0123456789ABCDEF0123", amountVnd: 50_000, state: "awaiting_transfer", expiresAt: "2026-10-01T00:00:00Z", transferClaimedAt: null, confirmedAt: null };
describe("creator tip UI privacy boundary", () => {
  it("rejects guest content on unpaid rows and strips all unrelated fields", () => {
    expect(readCreatorTip({ ...pending, accountNumber: "private", sessionId: "secret" })).toEqual(pending);
    expect(() => readCreatorTip({ ...pending, guestContent: { name: "hidden", message: "hidden" } })).toThrow("dependency_unavailable");
    const confirmed = { ...pending, state: "confirmed", confirmedAt: "2026-09-30T00:00:00Z", guestContent: { name: "Guest", message: "<script>literal text</script>" } };
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
    const settings = { revisionId: null, revisionNumber: 0, enabled: false, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000] };
    expect(readCreatorTipSettings({ ...settings, available: true, private: "discard" })).toEqual(settings);
    for (const change of [{ revisionNumber: 1 }, { revisionNumber: -1 }, { presetsVnd: [20_000, 20_000, 100_000] }, { maximumVnd: 5_000_001 }]) expect(() => readCreatorTipSettings({ ...settings, ...change })).toThrow("dependency_unavailable");
    expect(creatorTipErrorText("private account or credential")).not.toContain("private");
  });
});
