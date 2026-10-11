// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("../src/ui/commissions/commission-session", () => ({ useCommissionCommand: () => ({ execute: vi.fn(), retry: vi.fn(), locked: false, pending: false, code: null }), CommandFeedback: () => null }));
const routeRuntime = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: routeRuntime.get }));
import { projectTrustCases } from "../src/platform/trust-party-view";
import { MyCases } from "../src/ui/help/my-cases";
import { myTrustCasesSchema } from "../src/ui/trust/trust-client";
import { createResolutionHttpHandlers } from "../src/platform/resolution-http";
import { oidcCommand } from "../src/platform/oidc-command-registry";
const id = "10000000-0000-4000-8000-000000000001";
const at = "2026-10-10T00:00:00.000Z";
test("reported user's projection and rendered HTML contain no reporter or report source data", async () => {
  const secret = { reporterUserId: "secret-reporter-id", reporterRole: "secret-reporter-role", reportReference: "secret-report-reference",
    sourceCaseId: "secret-source-case", sourcePublicReportId: "secret-public-report", internalNote: "secret-internal-note", reason: "secret-hide-reason" };
  const view = await projectTrustCases({ reportsFiled: [], penalties: [{ ...secret, penaltyId: id, kind: "restriction", restriction: "reporting", target: null,
    state: "active", reasonCategory: "privacy", explanation: "Giải thích công khai", startsAt: at, endsAt: null, endedAt: null, acknowledgedAt: null, replaced: false }],
    hides: [{ ...secret, hideId: id, targetKind: "commission_message", hiddenAt: at, releasedAt: null }],
    appeals: [{ ...secret, appealId: id, penaltyId: id, hideId: null, state: "open", reasoning: null, createdAt: at, decidedAt: null }],
    now: new Date(at), effectiveDeadline: async (deadline: Date) => deadline });
  expect(myTrustCasesSchema.safeParse(view).success).toBe(true);
  const html = renderToStaticMarkup(createElement(MyCases, { cases: { disputes: [], refunds: [], lateClaims: [], ...view }, orderRoles: {}, trustMode: "enabled" }));
  for (const value of Object.values(secret)) { expect(JSON.stringify(view)).not.toContain(value); expect(html).not.toContain(value); }
  expect(view.penalties[0]!.canAppeal).toBe(false); expect(view.hides[0]!.explanation).toBe("Nội dung này đã bị Pawket ẩn vì vi phạm quy định cộng đồng.");
});
test("filed reports expose reference, target kind and status only", async () => {
  const report = { reportReference: "report:v2:synthetic", targetKind: "commission_brief" as const, state: "closed" as const, createdAt: at, outcome: "secret-penalty-outcome" };
  const view = await projectTrustCases({ reportsFiled: [report], penalties: [], hides: [], appeals: [], now: new Date(at), effectiveDeadline: async (date: Date) => date });
  expect(view.reportsFiled).toEqual([{ reportReference: report.reportReference, targetKind: report.targetKind, state: "closed" }]);
  const html = renderToStaticMarkup(createElement(MyCases, { cases: { disputes: [], refunds: [], lateClaims: [], ...view }, orderRoles: {}, trustMode: "enabled" }));
  expect(html).toContain("Đã xử lý"); expect(html).not.toContain(report.outcome);
});
test("appeal eligibility uses effective deadlines, active state, expiry, replacements and one appeal", async () => {
  const original = { penaltyId: id, kind: "restriction" as const, restriction: "reporting" as const, target: null, state: "active" as const, reasonCategory: "privacy" as const,
    explanation: "Synthetic explanation", startsAt: at, endsAt: null, endedAt: null, acknowledgedAt: null, replaced: false };
  const now = new Date("2026-10-30T00:00:00.000Z"); const deadline = new Date("2026-11-01T00:00:00.000Z");
  const project = (penalty = original, effective = deadline) => projectTrustCases({ reportsFiled: [], penalties: [penalty], hides: [], appeals: [], now, effectiveDeadline: async () => effective });
  expect((await project()).penalties[0]).toMatchObject({ canAppeal: true, appealDeadline: deadline.toISOString() });
  expect((await project(original, now)).penalties[0]!.canAppeal).toBe(false);
  expect((await project({ ...original, replaced: true })).penalties[0]!.canAppeal).toBe(false);
  const warning = await projectTrustCases({ reportsFiled: [], penalties: [{ ...original, kind: "warning", restriction: null }], hides: [], appeals: [], now, effectiveDeadline: async () => deadline });
  expect(warning.penalties[0]!.canAppeal).toBe(false);
  const releasedHide = await projectTrustCases({ reportsFiled: [], penalties: [], hides: [{ hideId: id, targetKind: "commission_file", hiddenAt: at, releasedAt: at }], appeals: [], now, effectiveDeadline: async () => deadline });
  expect(releasedHide.hides[0]!.canAppeal).toBe(false);
});

function httpFixture(mode: "disabled" | "enabled" = "enabled") {
  const actor = { userId: "synthetic-user", sessionId: "synthetic-session" };
  const listForUser = vi.fn().mockResolvedValue({ penalties: [], hides: [], appeals: [], reportsFiled: [] });
  const acknowledgeWarning = vi.fn().mockResolvedValue(undefined);
  const authenticate = vi.fn().mockResolvedValue(actor);
  const handlers = createResolutionHttpHandlers({ appBaseUrl: "https://pawket.invalid", lookupHmacKey: new Uint8Array(32), mode: "enabled", authenticate,
    throttle: vi.fn().mockResolvedValue(true), view: { listMyCases: vi.fn().mockResolvedValue({ disputes: [], refunds: [], lateClaims: [] }) },
    trust: { mode, listForUser, acknowledgeWarning } } as unknown as Parameters<typeof createResolutionHttpHandlers>[0]);
  const request = (method = "POST", body: object = {}) => new Request(`https://pawket.invalid/api/v1/help/warnings/${id}/acknowledge`, {
    method, headers: { origin: "https://pawket.invalid", "content-type": "application/json", "idempotency-key": "synthetic-key", "x-real-ip": "192.0.2.1" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  return { handlers, listForUser, acknowledgeWarning, authenticate, actor, request };
}
test("my cases scopes trust reads to the authenticated user and skips them while disabled", async () => {
  const f = httpFixture(); const response = await f.handlers.myCases(f.request("GET"));
  expect(response.status).toBe(200); expect(f.listForUser).toHaveBeenCalledWith(f.actor.userId);
  expect(await response.json()).toMatchObject({ controls: { trustMode: "enabled" }, cases: { penalties: [], reportsFiled: [], hides: [], appeals: [] } });
  const disabled = httpFixture("disabled"); const value = await (await disabled.handlers.myCases(disabled.request("GET"))).json();
  expect(disabled.listForUser).not.toHaveBeenCalled(); expect(value.controls.trustMode).toBe("disabled"); expect(value.cases).not.toHaveProperty("penalties");
});
test("warning acknowledgement uses private origin, session, empty body and idempotency boundaries", async () => {
  const f = httpFixture(); const response = await f.handlers.acknowledgeWarning(f.request(), id);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ acknowledged: true });
  expect(f.acknowledgeWarning).toHaveBeenCalledWith(expect.objectContaining({ actor: f.actor, penaltyId: id, idempotencyKey: "synthetic-key" }));
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await f.handlers.acknowledgeWarning(f.request("POST", { userId: "other" }), id)).status).toBe(400);
  const missingKey = f.request(); missingKey.headers.delete("idempotency-key"); expect((await f.handlers.acknowledgeWarning(missingKey, id)).status).toBe(400);
  const foreign = f.request(); foreign.headers.set("origin", "https://foreign.invalid"); expect((await f.handlers.acknowledgeWarning(foreign, id)).status).toBe(403);
  f.authenticate.mockResolvedValue(null as never); expect((await f.handlers.acknowledgeWarning(f.request(), id)).status).toBe(401);
});
test("disabled warning acknowledgement refuses before calling the service and registers non-fresh OIDC", async () => {
  const f = httpFixture("disabled"); const response = await f.handlers.acknowledgeWarning(f.request(), id);
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "enforcement_disabled" }); expect(f.acknowledgeWarning).not.toHaveBeenCalled();
  expect(oidcCommand({ method: "POST", path: `/api/v1/help/warnings/${id}/acknowledge`, body: "{}", idempotencyKey: "key", ifMatch: null, returnPath: "/" })?.policy).toEqual({ actionClass: "trust.warning_acknowledge", fresh: false });
});
test("acknowledgement route awaits Next.js params and masks runtime errors", async () => {
  const { POST } = await import("../src/app/api/v1/help/warnings/[penaltyId]/acknowledge/route");
  const handler = vi.fn().mockResolvedValue(Response.json({ acknowledged: true }));
  routeRuntime.get.mockReturnValue({ resolutionHandlers: { acknowledgeWarning: handler } });
  const request = httpFixture().request(); expect((await POST(request, { params: Promise.resolve({ penaltyId: id }) })).status).toBe(200);
  expect(handler).toHaveBeenCalledWith(request, id);
  routeRuntime.get.mockImplementation(() => { throw new Error("Private dependency detail"); });
  const response = await POST(request, { params: Promise.resolve({ penaltyId: id }) });
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "dependency_unavailable" });
});
