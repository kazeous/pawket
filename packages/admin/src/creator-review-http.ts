import { randomUUID } from "node:crypto";

import { CreatorReviewError, type CreatorDecisionAction } from "./creator-review-service.js";

type Session = { userId: string; sessionId: string; primaryAuthenticatedAt: Date };
type ReviewService = {
  listSubmitted(): Promise<unknown>;
  getDetail(input: { ownerUserId: string; ownerSessionId: string; stepUpProofId: string; applicationId: string; requestId: string }): Promise<unknown>;
  claim(input: { ownerUserId: string; ownerSessionId: string; applicationId: string; expectedVersion: number; requestId: string }): Promise<unknown>;
  decide(input: { ownerUserId: string; ownerSessionId: string; stepUpProofId: string; applicationId: string; revisionId: string; expectedVersion: number; idempotencyKey: string; requestId: string; action: CreatorDecisionAction; reasonCode: string; applicantExplanation: string; privateNote?: string }): Promise<unknown>;
  setCreatorCapability(input: { ownerUserId: string; ownerSessionId: string; stepUpProofId: string; userId: string; action: "suspend" | "reinstate"; reasonCode: string; applicantExplanation: string; privateNote?: string; idempotencyKey: string; requestId: string }): Promise<unknown>;
};

type Input = {
  trustedOrigins: readonly string[];
  authenticate(headers: Headers): Promise<Session | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  issueOwnerStepUpProof(input: { userId: string; sessionId: string; actionClass: string; now: Date }): Promise<{ id: string }>;
  review: ReviewService;
  now?: () => Date;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function json(status: number, body: unknown): Response { return Response.json(body, { status, headers: { "cache-control": "no-store" } }); }
function trusted(request: Request, origins: readonly string[]): boolean { const origin = request.headers.get("origin"); return origin !== null && origins.includes(origin); }
function key(request: Request): string | null { const value = request.headers.get("idempotency-key")?.trim(); return value && /^[A-Za-z0-9._-]{8,200}$/u.test(value) ? value : null; }
function version(request: Request): number | null { const value = request.headers.get("if-match"); return value && /^\d+$/u.test(value) && Number(value) > 0 ? Number(value) : null; }
function text(value: unknown, minimum: number, maximum: number): string | null { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length >= minimum && normalized.length <= maximum ? normalized : null; }
function requestId(request: Request): string { const value = request.headers.get("x-request-id"); return value && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : randomUUID(); }
async function body(request: Request): Promise<Record<string, unknown> | null> { try { const value = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }

export function createCreatorReviewHttpHandlers(input: Input) {
  const now = input.now ?? (() => new Date());
  async function owner(request: Request): Promise<Session | Response> {
    try {
      const result = await input.authorizeOwner(request.headers);
      if (result !== "authorized") return json(result === "unauthenticated" ? 401 : 403, { code: result === "unauthenticated" ? "AUTHENTICATION_REQUIRED" : "OWNER_REQUIRED" });
      return (await input.authenticate(request.headers)) ?? json(401, { code: "AUTHENTICATION_REQUIRED" });
    } catch { return json(503, { code: "CREATOR_REVIEW_UNAVAILABLE" }); }
  }
  function mutation(request: Request): Response | null { if (request.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" }); return trusted(request, input.trustedOrigins) ? null : json(403, { code: "UNTRUSTED_ORIGIN" }); }
  function failure(error: unknown): Response { return error instanceof CreatorReviewError ? json(409, { code: error.code.toUpperCase() }) : json(503, { code: "CREATOR_REVIEW_UNAVAILABLE" }); }

  return {
    async list(request: Request): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const actor = await owner(request); if (actor instanceof Response) return actor;
      try { return json(200, { applications: await input.review.listSubmitted() }); } catch (error) { return failure(error); }
    },
    async detail(request: Request, applicationId: string): Promise<Response> {
      const rejected = mutation(request); if (rejected) return rejected;
      if (!uuidPattern.test(applicationId)) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request); if (actor instanceof Response) return actor;
      try {
        const proof = await input.issueOwnerStepUpProof({ userId: actor.userId, sessionId: actor.sessionId, actionClass: "owner.creator_application_detail", now: now() });
        return json(200, { detail: await input.review.getDetail({ ownerUserId: actor.userId, ownerSessionId: actor.sessionId, stepUpProofId: proof.id, applicationId, requestId: requestId(request) }) });
      } catch (error) { return failure(error); }
    },
    async claim(request: Request, applicationId: string): Promise<Response> {
      const rejected = mutation(request); if (rejected) return rejected;
      if (!uuidPattern.test(applicationId)) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request); if (actor instanceof Response) return actor;
      const expectedVersion = version(request); if (!expectedVersion) return json(400, { code: "INVALID_REQUEST" });
      try { return json(200, { claim: await input.review.claim({ ownerUserId: actor.userId, ownerSessionId: actor.sessionId, applicationId, expectedVersion, requestId: requestId(request) }) }); } catch (error) { return failure(error); }
    },
    async decide(request: Request, applicationId: string): Promise<Response> {
      const rejected = mutation(request); if (rejected) return rejected;
      if (!uuidPattern.test(applicationId)) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request); if (actor instanceof Response) return actor;
      const payload = await body(request); const idempotencyKey = key(request); const expectedVersion = version(request);
      const revisionId = text(payload?.revisionId, 36, 36); const action = payload?.action;
      const reasonCode = text(payload?.reasonCode, 1, 100); const applicantExplanation = text(payload?.applicantExplanation, 1, 2000); const privateNote = payload?.privateNote === undefined ? undefined : text(payload.privateNote, 1, 1000);
      if (!payload || !idempotencyKey || !expectedVersion || !revisionId || !uuidPattern.test(revisionId) || !["request_changes", "approve", "reject", "reopen"].includes(String(action)) || !reasonCode || !applicantExplanation || (payload.privateNote !== undefined && !privateNote)) return json(400, { code: "INVALID_REQUEST" });
      try { const proof = await input.issueOwnerStepUpProof({ userId: actor.userId, sessionId: actor.sessionId, actionClass: `owner.creator_application_${action}`, now: now() }); return json(200, { decision: await input.review.decide({ ownerUserId: actor.userId, ownerSessionId: actor.sessionId, stepUpProofId: proof.id, applicationId, revisionId, expectedVersion, idempotencyKey, requestId: requestId(request), action: action as CreatorDecisionAction, reasonCode, applicantExplanation, privateNote: privateNote ?? undefined }) }); } catch (error) { return failure(error); }
    },
    async setCapability(request: Request, userId: string): Promise<Response> {
      const rejected = mutation(request); if (rejected) return rejected;
      const actor = await owner(request); if (actor instanceof Response) return actor;
      const payload = await body(request); const idempotencyKey = key(request); const action = payload?.action;
      const reasonCode = text(payload?.reasonCode, 1, 100); const applicantExplanation = text(payload?.applicantExplanation, 1, 2000); const privateNote = payload?.privateNote === undefined ? undefined : text(payload.privateNote, 1, 1000);
      if (!payload || !idempotencyKey || !["suspend", "reinstate"].includes(String(action)) || !reasonCode || !applicantExplanation || (payload.privateNote !== undefined && !privateNote)) return json(400, { code: "INVALID_REQUEST" });
      try { const proof = await input.issueOwnerStepUpProof({ userId: actor.userId, sessionId: actor.sessionId, actionClass: `owner.creator_capability_${action}`, now: now() }); return json(200, { capability: await input.review.setCreatorCapability({ ownerUserId: actor.userId, ownerSessionId: actor.sessionId, stepUpProofId: proof.id, userId, action: action as "suspend" | "reinstate", reasonCode, applicantExplanation, privateNote: privateNote ?? undefined, idempotencyKey, requestId: requestId(request) }) }); } catch (error) { return failure(error); }
    },
  };
}
