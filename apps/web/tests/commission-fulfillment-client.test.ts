import { expect, test, vi } from "vitest";
vi.mock("@/ui/tips/tip-client", () => ({ TipRequestError: class extends Error {}, tipRequest: vi.fn() }));
import { commissionErrorText, ordersSchema, referenceFileSchema, stateLabels, stateSchema, threadSchema } from "../src/ui/commissions/commission-client";

const id = "10000000-0000-4000-8000-000000000001"; const at = "2026-10-06T00:00:00.000Z";
const file = { fileId: id, name: "synthetic.psd", sizeBytes: 262_144_000, detectedType: "psd", sha256: `sha256:${"a".repeat(64)}`, previewable: false, availability: "available" };
test.each(["delivered", "completed"] as const)("accepts the %s state", (state) => {
  expect(stateSchema.safeParse(state).success).toBe(true);
  expect(stateLabels[state]).toBe(state === "delivered" ? "Đã giao, chờ duyệt" : "Hoàn tất");
});
test.each(["psd", "clip", "zip"])("accepts a 250 MiB %s submission file", (detectedType) => {
  expect(referenceFileSchema.safeParse({ ...file, detectedType }).success).toBe(true);
  expect(referenceFileSchema.safeParse({ ...file, detectedType, sizeBytes: 262_144_001 }).success).toBe(false);
});
test("parses thread entries and removes unrelated fields", () => {
  const result = threadSchema.parse({ thread: { items: [
    { sequence: 2, kind: "submission", id, submissionKind: "final", note: null, files: [file], submittedAt: at, late: false,
      response: null, responseNote: null, respondedAt: null, actionable: true },
    { sequence: 1, kind: "message", id, author: "buyer", text: "<3", files: [], createdAt: at, unrelated: true },
  ], nextBeforeSequence: null, writable: true, unrelated: true } });
  expect(result.thread.items.length).toBe(2); expect("unrelated" in result.thread).toBe(false); expect("unrelated" in result.thread.items[1]!).toBe(false);
  expect(threadSchema.safeParse({ thread: { ...result.thread, items: [{ ...result.thread.items[0], response: "accept" }] } }).success).toBe(false);
});
test("retains creator grouping facts", () => {
  const { orders } = ordersSchema.parse({ orders: { items: [{ id, state: "in_progress", version: 1, route: "fixed_immediate", amountVnd: 500_000,
    createdAt: at, expiresAt: null, dueAt: at, title: "Synthetic", reviewEndsAt: null, awaitingBuyer: true, overdue: true }], nextBefore: null } });
  expect(orders.items[0]!.awaitingBuyer).toBe(true); expect(orders.items[0]!.overdue).toBe(true);
});
test("uses the approved fulfilment error copy and context byte limit", () => {
  expect(commissionErrorText("fulfillment_disabled")).toBe("Tạm dừng trao đổi và giao bài. Lịch sử vẫn được giữ.");
  expect(commissionErrorText("file_too_large", "submission")).toBe("Tệp vượt quá 250 MB.");
  expect(commissionErrorText("file_too_large", "thread")).toBe("Tệp vượt quá 25 MB.");
});
