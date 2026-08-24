import { describe, expect, test } from "vitest";
import * as identity from "../src/index.js";

type Factory = { createCreatorApplicationHttpHandlers(input: unknown): { get(request: Request): Promise<Response>; save(request: Request): Promise<Response>; submit(request: Request): Promise<Response>; withdraw(request: Request): Promise<Response> } };
const api = identity as unknown as Partial<Factory>;
const origin = "https://pawket.example";
const detail = { id: "application-1", state: "draft", version: 1, revision: { id: "revision-1" } };

describe("creator application HTTP boundary", () => {
  test("requires the authenticated applicant and returns only their minimized application detail", async () => {
    // Break caught: an unauthenticated or cross-user GET disclosing private application data.
    expect(typeof api.createCreatorApplicationHttpHandlers).toBe("function");
    const handlers = api.createCreatorApplicationHttpHandlers!({ trustedOrigins: [origin], authenticate: async () => null, service: { getForApplicant: async () => detail } });
    expect((await handlers.get(new Request(`${origin}/api/v1/creator-application`))).status).toBe(401);
  });

  test("rejects a state-changing request without origin, idempotency key, and expected version", async () => {
    // Break caught: CSRFable/replayable/stale applicant commands.
    expect(typeof api.createCreatorApplicationHttpHandlers).toBe("function");
    const handlers = api.createCreatorApplicationHttpHandlers!({ trustedOrigins: [origin], authenticate: async () => ({ userId: "artist-1" }), service: { saveDraft: async () => detail, submit: async () => detail, withdraw: async () => detail, getForApplicant: async () => detail } });
    expect((await handlers.withdraw(new Request(`${origin}/api/v1/creator-application/withdraw`, { method: "POST", headers: { origin } }))).status).toBe(400);
    const response = await handlers.withdraw(new Request(`${origin}/api/v1/creator-application/withdraw`, { method: "POST", headers: { origin, "idempotency-key": "withdraw-1", "if-match": "1" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ application: detail });
  });
});
