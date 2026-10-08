import { expect, test, vi } from "vitest";
import type { PawketDatabase } from "@pawket/database";
import { createResolutionCaseDeadlinePort, createResolutionCaseMetadataPort } from "../src/case-deadlines.js";
const time = new Date("2026-10-10T04:00:00Z");
const row = { caseId: "case", orderId: "order", kind: "dispute", state: "open", sourceId: "source" };
function database(disputeState = "open", endedAt: Date | null = new Date("2026-10-11T04:00:00Z")) {
  let reads = 0;
  const query = { from: () => query, where: () => query, limit: async () => [{ id: "source", state: disputeState, respondBy: time, openedAt: time }],
    orderBy: async () => [{ startedAt: new Date("2026-10-09T04:00:00Z"), endedAt }] };
  const tx = { select: () => { reads++; return query; } };
  return { db: { ...tx, transaction: async (run: (tx: unknown) => unknown) => run(tx) } as unknown as PawketDatabase, reads: () => reads };
}
test.each(["dispute", "refund_overdue", "refund_not_received", "late_payment"])("queue deadline for %s respects a pause and reads only metadata", async (kind) => {
  const { db, reads } = database(); const refunds = { listForOrder: vi.fn(async () => [{ obligationId: "source", dueAt: time }]) };
  const result = await createResolutionCaseDeadlinePort({ refunds }).nextDeadlines(db, [{ ...row, kind }]);
  expect(result.get("case")).toEqual(["dispute", "refund_overdue"].includes(kind) ? new Date("2026-10-13T04:00:00Z") : null);
  expect(refunds.listForOrder.mock.calls.length).toBe(kind === "refund_overdue" ? 1 : 0);
  if (["refund_not_received", "late_payment"].includes(kind)) expect(reads()).toBe(0);
});
test("resolved cases and closed disputes have no deadline; an open pause returns null", async () => {
  const port = createResolutionCaseDeadlinePort({ refunds: { listForOrder: vi.fn(async () => []) } });
  expect((await port.nextDeadlines(database().db, [{ ...row, state: "resolved" }])).get("case")).toBeNull();
  expect((await port.nextDeadlines(database("ruled").db, [row])).get("case")).toBeNull();
  expect((await port.nextDeadlines(database("open", null).db, [row])).get("case")).toBeNull();
});
test("non-dispute owner metadata contains no ruling or private content", async () => {
  const { db, reads } = database();
  expect(await createResolutionCaseMetadataPort().readForCase(db, { ...row, kind: "late_payment" })).toEqual({ disputeOpenedAt: null, respondBy: null, ruling: null });
  expect(reads()).toBe(0);
});
