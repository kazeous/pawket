import { describe, expect, test, vi } from "vitest";

import * as admin from "../src/index.js";

const origin = "https://pawket.example";
const session = { userId: "owner-1", sessionId: "owner-session", primaryAuthenticatedAt: new Date("2026-08-25T03:00:00.000Z") };

describe("creator review HTTP boundary", () => {
  test("denies non-owners and derives action-scoped TOTP proof on owner decisions", async () => {
    // Break caught: a direct non-owner decision or accepting a client-provided proof ID.
    type Factory = {
      createCreatorReviewHttpHandlers(input: Record<string, unknown>): {
        decide(request: Request, applicationId: string): Promise<Response>;
      };
    };
    const api = admin as unknown as Partial<Factory>;
    expect(typeof api.createCreatorReviewHttpHandlers).toBe("function");
    const review = { decide: vi.fn(async () => ({ state: "approved" })) };
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
  });
});
