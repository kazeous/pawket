// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("../src/auth/oidc-review-redirect", () => ({ redirectToOidcReview: redirect }));
import { casePost, caseRequest, openCaseFile, caseErrorText, queueSchema } from "../src/ui/cases/case-client";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); redirect.mockReset(); });
test.each(["use_penalty", "duplicate", "resolution_disabled", "enforcement_disabled"])("owner error %s has actionable copy", (code) => {
  expect(caseErrorText(code)).not.toBe(caseErrorText("dependency_unavailable"));
  if (code === "use_penalty") expect(caseErrorText(code)).toContain("biện pháp");
  if (code === "duplicate") expect(caseErrorText(code)).toContain("đang có hiệu lực");
});
test.each(["report", "appeal"])("queue accepts orderless %s metadata", (kind) => {
  const id = "10000000-0000-4000-8000-000000000001";
  expect(queueSchema.safeParse({ cases: [{ caseId: id, orderId: null, sourceId: id, sourceType: "commission_package", kind, state: "open", resolutionKind: null, policyRevisionId: null, version: 1, openedAt: "2026-10-07T00:00:00.000Z", resolvedAt: null, nextDeadline: null }] }).success).toBe(true);
});
test("owner commands preserve actor and command id and use the existing opaque step-up flow", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ code: "OIDC_STEP_UP_REQUIRED", reviewPath: "/auth/review/10000000-0000-4000-8000-000000000001" }), { status: 403, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const init = casePost({ section: "order_summary" }, "synthetic-owner", "synthetic-command");
  await expect(caseRequest("/api/v1/admin/cases/synthetic/evidence", init)).rejects.toMatchObject({ code: "OIDC_STEP_UP_REQUIRED" });
  expect(redirect).toHaveBeenCalledOnce(); const options = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(options.cache).toBe("no-store"); expect(options.referrerPolicy).toBe("no-referrer");
  expect(new Headers(options.headers).get("x-pawket-actor")).toBe("synthetic-owner");
  expect(new Headers(options.headers).get("idempotency-key")).toBe("synthetic-command");
});
test("file grants open directly and write no browser storage", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null); const storage = vi.spyOn(Storage.prototype, "setItem");
  openCaseFile({ url: "https://example.invalid/synthetic-file" });
  expect(open.mock.calls.length === 1 && open.mock.calls[0]?.[1] === "_blank" && open.mock.calls[0]?.[2] === "noopener,noreferrer").toBe(true);
  expect(storage).not.toHaveBeenCalled();
  expect(() => openCaseFile({ url: "javascript:alert(1)" })).toThrow();
});
