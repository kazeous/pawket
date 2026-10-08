import { afterEach, expect, test, vi } from "vitest";
import { resolutionPath, resolutionRequest, resolutionSchema, disputeBefore, type ResolutionAction } from "../src/ui/resolutions/resolution-client";
import { detailSchema } from "../src/ui/commissions/commission-client";

const id = "10000000-0000-4000-8000-000000000001";
const target = "10000000-0000-4000-8000-000000000002";
afterEach(() => vi.unstubAllGlobals());
const commands: [ResolutionAction, "buyer" | "creator", string][] = [
  ["propose", "buyer", "proposals"], ["respondProposal", "creator", `proposals/${target}/respond`],
  ["withdrawProposal", "buyer", `proposals/${target}/withdraw`], ["openDispute", "buyer", "disputes"],
  ["addStatement", "creator", `disputes/${target}/statements`], ["withdrawDispute", "buyer", `disputes/${target}/withdraw`],
  ["enterDestination", "buyer", `refunds/${target}/destination`], ["confirmReceipt", "buyer", `refunds/${target}/receipt`],
  ["reveal", "creator", `refunds/${target}/reveal`], ["recordSend", "creator", `refunds/${target}/send`],
  ["fileLateClaim", "buyer", "late-claim"], ["answerLateClaim", "creator", `late-claim/${target}/answer`],
  ["cancelAfterSuspension", "buyer", "suspension-cancel"],
];
test.each(commands)("%s sends the exact party path and command headers", async (action, role, suffix) => {
  const fetcher = vi.fn(async () => Response.json({ version: 2 })); vi.stubGlobal("fetch", fetcher);
  await resolutionRequest(resolutionPath(role, id, action, target), { body: "{}", headers: { "x-pawket-actor": "synthetic-actor" } });
  const [path, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/${role === "creator" ? "creator/" : ""}commissions/${id}/${suffix}`);
  expect(init).toMatchObject({ method: "POST", body: "{}", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
  const headers = new Headers(init.headers);
  expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u); expect(headers.get("content-type")).toBe("application/json"); expect(headers.get("x-pawket-actor")).toBe("synthetic-actor");
});
test("a retry preserves the original idempotency key and body bytes", async () => {
  const fetcher = vi.fn(async () => Response.json({ version: 2 })); vi.stubGlobal("fetch", fetcher);
  const request = { body: "{}", headers: { "idempotency-key": "synthetic-original" } };
  await resolutionRequest(resolutionPath("buyer", id, "propose"), request); await resolutionRequest(resolutionPath("buyer", id, "propose"), request);
  for (const call of fetcher.mock.calls) { const init = (call as unknown as [string, RequestInit])[1]; expect(new Headers(init.headers).get("idempotency-key")).toBe("synthetic-original"); expect(init.body).toBe(request.body); }
});
test.each([ ["enterDestination", "buyer"], ["reveal", "creator"], ["recordSend", "creator"], ["answerLateClaim", "creator"] ] as const)("fresh %s commands follow the existing opaque OIDC resume flow for a 403", async (action, role) => {
  const assign = vi.fn(); vi.stubGlobal("window", { location: { assign } });
  const reviewPath = `/auth/review/${target}`;
  // The registry wraps recent_auth_required in its opaque resumable command response.
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "OIDC_STEP_UP_REQUIRED", reason: "recent_auth_required", reviewPath }, { status: 403 })));
  await expect(resolutionRequest(resolutionPath(role, id, action, target), { method: "POST", body: "{}", headers: { "content-type": "application/json", "idempotency-key": "synthetic-key", "x-pawket-actor": "synthetic-actor" } })).rejects.toMatchObject({ code: "OIDC_STEP_UP_REQUIRED" });
  expect(assign).toHaveBeenCalledWith(reviewPath);
});
test.each(["agreement", "ruling"])("completed orders accept completion kind %s", (completionKind) => {
  expect(detailSchema.shape.order.shape.fulfillment.safeParse({ deliveredAt: null, reviewEndsAt: null, completionDueAt: null,
    completedAt: "2026-10-08T00:00:00.000Z", completionKind, revisionsUsed: 0, revisionAllowance: 0, lateDelivery: false, fileDeletionAt: null }).success).toBe(true);
});
test("display deadlines preserve the exclusive final boundary and inclusive proposal boundary", () => {
  const endsAt = "2026-10-08T00:00:00.000Z";
  expect(disputeBefore("final_delivery", endsAt)).toBe(endsAt);
  expect(disputeBefore("proposal_declined", endsAt)).toBe("2026-10-08T00:00:00.001Z");
});
test("party projections drop owner case reasons and unrevealed destination fields", () => {
  const result = resolutionSchema.parse({ resolution: { role: "creator", proposals: { pending: null, history: [] }, dispute: null, refunds: [], lateClaim: null,
    ownerCaseReason: "private", actions: { canPropose: false, canOpenDispute: false, disputeTrigger: null, disputeTriggerEndsAt: null, canCancelAfterSuspension: false } }, controls: { mode: "enabled" } });
  expect("ownerCaseReason" in result.resolution).toBe(false);
});
