import { describe, expect, test, vi } from "vitest";

import * as admin from "../src/index.js";

const origin = "https://pawket.example";
const session = { userId: "owner-1", sessionId: "owner-session", primaryAuthenticatedAt: new Date("2026-08-25T03:00:00.000Z") };

describe("creator review HTTP boundary", () => {
  test("maps the typed stale owner assurance error without reflecting internals", async () => {
    type Factory = { createCreatorReviewHttpHandlers(input: Record<string, unknown>): { detail(request: Request, applicationId: string): Promise<Response> } };
    const api = admin as unknown as Factory;
    const typedError = Object.assign(new Error("internal assurance detail"), { code: "OWNER_TOTP_REQUIRED" });
    const handlers = api.createCreatorReviewHttpHandlers({
      trustedOrigins: [origin], authenticate: vi.fn(async () => session), authorizeOwner: vi.fn(async () => "authorized"),
      issueOwnerStepUpProof: vi.fn(async () => { throw typedError; }), review: {},
    });
    const response = await handlers.detail(new Request(`${origin}/detail`, { method: "POST", headers: { origin } }), "10000000-0000-4000-8000-000000000001");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "OWNER_TOTP_REQUIRED" });
  });

  test("denies non-owners and derives action-scoped TOTP proof on owner decisions", async () => {
    // Break caught: a direct non-owner decision or accepting a client-provided proof ID.
    type Factory = {
      createCreatorReviewHttpHandlers(input: Record<string, unknown>): {
        decide(request: Request, applicationId: string): Promise<Response>;
        detail(request: Request, applicationId: string): Promise<Response>;
      };
    };
    const api = admin as unknown as Partial<Factory>;
    expect(typeof api.createCreatorReviewHttpHandlers).toBe("function");
    const review = { decide: vi.fn(async () => ({ state: "approved" })), getDetail: vi.fn(async () => ({ application: { id: "10000000-0000-4000-8000-000000000001" }, revision: { dateOfBirth: "2002-08-25" } })) };
    const issueOwnerStepUpProof = vi.fn(async ({ actionClass }: { actionClass: string }) => ({ id: `server-proof:${actionClass}` }));
    const handlers = api.createCreatorReviewHttpHandlers!({
      trustedOrigins: [origin], authenticate: vi.fn(async () => session), authorizeOwner: vi.fn(async () => "forbidden"),
      issueOwnerStepUpProof, review,
    });
    const body = { revisionId: "10000000-0000-4000-8000-000000000002", action: "approve", reasonCode: "other", applicantExplanation: "Approved.", stepUpProofId: "attacker-proof" };
    const denied = await handlers.decide(new Request(`${origin}/api/v1/admin/creator-applications/10000000-0000-4000-8000-000000000001/decision`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "owner-decision-one", "if-match": "3" }, body: JSON.stringify(body) }), "10000000-0000-4000-8000-000000000001");
    expect(denied.status).toBe(403);

    const permitted = api.createCreatorReviewHttpHandlers!({ trustedOrigins: [origin], authenticate: vi.fn(async () => session), authorizeOwner: vi.fn(async () => "authorized"), issueOwnerStepUpProof, review });
    const allowed = await permitted.decide(new Request(`${origin}/decision`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "owner-decision-one", "if-match": "3", "x-request-id": "owner-decision-request" }, body: JSON.stringify(body) }), "10000000-0000-4000-8000-000000000001");
    expect(allowed.status).toBe(200);
    expect(issueOwnerStepUpProof).toHaveBeenCalledWith({ userId: "owner-1", sessionId: "owner-session", actionClass: "owner.creator_application_approve", now: expect.any(Date) });
    expect(review.decide).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "owner-1", ownerSessionId: "owner-session", stepUpProofId: "server-proof:owner.creator_application_approve", expectedVersion: 3 }));

    const detailDenied = await handlers.detail(new Request(`${origin}/detail`, { method: "POST", headers: { origin } }), "10000000-0000-4000-8000-000000000001");
    expect(detailDenied.status).toBe(403);
    const detailAllowed = await permitted.detail(new Request(`${origin}/detail`, { method: "POST", headers: { origin, "x-request-id": "detail-request" } }), "10000000-0000-4000-8000-000000000001");
    expect(detailAllowed.status).toBe(200);
    await expect(detailAllowed.json()).resolves.toEqual({ detail: { application: { id: "10000000-0000-4000-8000-000000000001" }, revision: { dateOfBirth: "2002-08-25" } } });
    expect(issueOwnerStepUpProof).toHaveBeenCalledWith({ userId: "owner-1", sessionId: "owner-session", actionClass: "owner.creator_application_detail", now: expect.any(Date) });
  });

  test("enforces origin and owner boundaries on every review route", async () => {
    type Factory = {
      createCreatorReviewHttpHandlers(input: Record<string, unknown>): {
        list(request: Request): Promise<Response>;
        claim(request: Request, applicationId: string): Promise<Response>;
        setCapability(request: Request, userId: string): Promise<Response>;
      };
    };
    const api = admin as unknown as Factory;
    const review = {
      listSubmitted: vi.fn(async () => [{ id: "10000000-0000-4000-8000-000000000001" }]),
      claim: vi.fn(async () => ({ version: 3 })),
      setCreatorCapability: vi.fn(async () => ({ state: "suspended" })),
    };
    const issueOwnerStepUpProof = vi.fn(async ({ actionClass }: { actionClass: string }) => ({ id: `server-proof:${actionClass}` }));
    const authorizeOwner = vi.fn(async () => "authorized" as const);
    const handlers = api.createCreatorReviewHttpHandlers({
      trustedOrigins: [origin], authenticate: vi.fn(async () => session), authorizeOwner,
      issueOwnerStepUpProof, review,
    });
    const applicationId = "10000000-0000-4000-8000-000000000001";

    const listed = await handlers.list(new Request(`${origin}/api/v1/admin/creator-applications`, { method: "GET" }));
    expect(listed.status).toBe(200);
    expect(review.listSubmitted).toHaveBeenCalledOnce();

    const crossOriginClaim = await handlers.claim(new Request(`${origin}/claim`, { method: "POST", headers: { origin: "https://attacker.example", "if-match": "2" } }), applicationId);
    expect(crossOriginClaim.status).toBe(403);
    expect(review.claim).not.toHaveBeenCalled();

    const claimed = await handlers.claim(new Request(`${origin}/claim`, { method: "POST", headers: { origin, "if-match": "2" } }), applicationId);
    expect(claimed.status).toBe(200);
    expect(review.claim).toHaveBeenCalledWith(expect.objectContaining({ applicationId, expectedVersion: 2, ownerUserId: "owner-1" }));

    const invalidVersion = await handlers.claim(new Request(`${origin}/claim`, { method: "POST", headers: { origin, "if-match": "9007199254740992" } }), applicationId);
    expect(invalidVersion.status).toBe(400);

    const forbidden = api.createCreatorReviewHttpHandlers({
      trustedOrigins: [origin], authenticate: vi.fn(async () => session), authorizeOwner: vi.fn(async () => "forbidden"),
      issueOwnerStepUpProof, review,
    });
    const capabilityBody = JSON.stringify({ action: "suspend", reasonCode: "other", applicantExplanation: "Temporarily suspended." });
    const denied = await forbidden.setCapability(new Request(`${origin}/capability`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "suspend-one" }, body: capabilityBody }), "review-artist");
    expect(denied.status).toBe(403);
    expect(review.setCreatorCapability).not.toHaveBeenCalled();

    const allowed = await handlers.setCapability(new Request(`${origin}/capability`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "suspend-one" }, body: capabilityBody }), "review-artist");
    expect(allowed.status).toBe(200);
    expect(issueOwnerStepUpProof).toHaveBeenCalledWith(expect.objectContaining({ actionClass: "owner.creator_capability_suspend" }));
    expect(review.setCreatorCapability).toHaveBeenCalledWith(expect.objectContaining({ userId: "review-artist", action: "suspend", stepUpProofId: "server-proof:owner.creator_capability_suspend" }));
  });
});
