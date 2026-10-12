import { afterEach, expect, test, vi } from "vitest";
import { appealInputSchema, myTrustCasesSchema, reportInputSchema, reportResultSchema, trustClient } from "../src/ui/trust/trust-client";
import { threadSchema } from "../src/ui/commissions/commission-client";

const id = "10000000-0000-4000-8000-000000000001";
const at = "2026-10-10T00:00:00.000Z";
export const penalty = { penaltyId: id, kind: "restriction", restriction: "reporting", target: null, reasonCategoryLabel: "Spam hoặc lừa đảo",
  explanation: "Giải thích dành cho bạn", startsAt: at, endsAt: null, endedAt: null, state: "active", acknowledgedAt: null,
  canAppeal: true, appealDeadline: "2099-10-24T00:00:00.000Z", appealState: null };
afterEach(() => vi.unstubAllGlobals());
test("client schemas reject unknown penalty kinds and states", () => {
  const payload = { reportsFiled: [], penalties: [penalty], hides: [], appeals: [] };
  expect(myTrustCasesSchema.safeParse(payload).success).toBe(true);
  for (const change of [{ kind: "ban" }, { restriction: "wallet" }, { state: "unknown" }]) {
    expect(myTrustCasesSchema.safeParse({ ...payload, penalties: [{ ...penalty, ...change }] }).success).toBe(false);
  }
});
test("appeals count normalized Unicode code points and reject controls", () => {
  expect(appealInputSchema.safeParse({ target: { penaltyId: id }, statement: "😀".repeat(4000) }).success).toBe(true);
  expect(appealInputSchema.safeParse({ target: { penaltyId: id }, statement: "😀".repeat(4001) }).success).toBe(false);
  expect(appealInputSchema.safeParse({ target: { penaltyId: id }, statement: "a\u0000" }).success).toBe(false);
  expect(appealInputSchema.safeParse({ target: { penaltyId: id, hideId: id }, statement: "a" }).success).toBe(false);
});
test("reports accept only bounded target and reason data", () => {
  const target = { kind: "commission_message", orderId: id, messageId: id };
  expect(reportInputSchema.safeParse({ target, reason: "privacy", detail: "😀".repeat(1000) }).success).toBe(true);
  expect(reportInputSchema.safeParse({ target, reason: "privacy", detail: "😀".repeat(1001) }).success).toBe(false);
  expect(reportInputSchema.safeParse({ target, reason: "invented" }).success).toBe(false);
  expect(reportResultSchema.parse({ accepted: true, reportReference: "report:v2:synthetic", caseId: id })).toEqual({ accepted: true, reportReference: "report:v2:synthetic" });
});
test("thread schema preserves hides in disabled mode and rejects hidden text", () => {
  const message = { sequence: 1, kind: "message", id, author: "creator", text: null, hidden: true, files: [], createdAt: at };
  const payload = { thread: { items: [message], nextBeforeSequence: null, writable: false } };
  expect(threadSchema.parse(payload).thread.items[0]).toMatchObject({ hidden: true, text: null });
  expect(threadSchema.safeParse({ thread: { ...payload.thread, items: [{ ...message, text: "private" }] } }).success).toBe(false);
});
test("authenticated trust commands send idempotency keys with bounded private requests", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: true, reportReference: "report:v2:synthetic" }), { status: 202, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  await trustClient.request("/api/v1/reports", { body: "{}" });
  const init = fetch.mock.calls[0]![1]; expect(new Headers(init.headers).has("idempotency-key")).toBe(true);
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
});
