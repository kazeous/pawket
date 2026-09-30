import { describe, expect, test, vi } from "vitest";
import { createOidcCommandHttp } from "../src/platform/oidc-command-http.js";
import { OidcIdentityError } from "@pawket/identity";

const id = "99999999-9999-4999-8999-999999999999";
const pendingId = "88888888-8888-4888-8888-888888888888";
const path = `/api/v1/creator/tips/${id}/confirm`;
const payload = { method: "POST" as const, path, body: '{ "observedAmountVnd": 50000 }', idempotencyKey: "original-idempotency-key", ifMatch: null, returnPath: "/creator/tips" };
const actor = { userId: "creator", sessionId: "session", authorizationVersion: 2, subject: "subject", leaseRequired: false };
type Options = Parameters<typeof createOidcCommandHttp>[0];
function fixture() {
  const authenticate = vi.fn().mockResolvedValue(actor); const ready = vi.fn().mockResolvedValue(true);
  const prepare = vi.fn().mockResolvedValue({ reviewPath: `/auth/review/${pendingId}` });
  const review = vi.fn().mockResolvedValue({ payload, ready: true, expiresAt: new Date("2026-09-27T12:00:00Z") });
  const confirm = vi.fn(async (request: Request) => Response.json({ received: await request.text(), key: request.headers.get("idempotency-key") }));
  const options = { db: { transaction: (callback: (tx: unknown) => unknown) => callback({}) }, baseUrl: "https://pawket.example", authenticate,
    commands: { prepare, review, cancel: vi.fn() }, context: { ready, run: (_input: unknown, execute: () => Promise<Response>) => execute() },
    runtime: () => ({ creatorTipHandlers: { confirm } }) } as unknown as Options;
  return { http: createOidcCommandHttp(options), authenticate, prepare, ready, review, confirm };
}
const request = (body = payload.body, extra: HeadersInit = {}, target = path) => new Request(`https://pawket.example${target}`, {
  method: "POST", headers: { origin: "https://pawket.example", "content-type": "application/json", "idempotency-key": payload.idempotencyKey, ...extra }, body,
});
describe("OIDC command HTTP boundary", () => {
  test("expiry behind business locks preserves the original command", async () => {
    const f = fixture();
    const response = await f.http.run(request(), async () => { throw new OidcIdentityError("assurance_required"); });
    expect(response.status).toBe(409); expect(f.prepare.mock.calls[0]![0]).toMatchObject({ actor, payload });
  });
  test("stale assurance preserves exact bytes before any business execution", async () => {
    const f = fixture(); f.ready.mockResolvedValue(false); const execute = vi.fn();
    const response = await f.http.run(request(), execute);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "OIDC_STEP_UP_REQUIRED", reviewPath: `/auth/review/${pendingId}` });
    expect(f.prepare.mock.calls[0]![0]).toMatchObject({ actor, payload }); expect(execute).not.toHaveBeenCalled();
  });
  test("cross-origin and changed draft actor cannot preserve or execute a command", async () => {
    const f = fixture(); const execute = vi.fn();
    expect((await f.http.run(request(undefined, { origin: "https://evil.example" }), execute)).status).toBe(403);
    expect((await f.http.run(request(undefined, { "x-pawket-actor": "someone-else" }), execute)).status).toBe(409);
    expect(f.prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  test("confirmation dispatches saved bytes and original key, never new browser payload", async () => {
    const f = fixture(); const response = await f.http.confirm(request('{"amount":999999}', {}, `/api/v1/auth/commands/${pendingId}`), pendingId);
    expect(await response.json()).toEqual({ received: payload.body, key: payload.idempotencyKey });
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });
  test("a non-owner cannot preserve an owner command after account switching", async () => {
    const f = fixture(); f.authenticate.mockResolvedValue({ ...actor, owner: false, leaseRequired: true });
    const execute = vi.fn();
    const response = await f.http.run(request('{}', {}, `/api/v1/admin/creator-applications/${id}/detail`), execute);
    expect(response.status).toBe(403); expect(f.prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  test("review cannot read private pending content with an expired lease", async () => {
    const f = fixture(); f.authenticate.mockResolvedValue({ ...actor, leaseRequired: true });
    const response = await f.http.review(new Request(`https://pawket.example/api/v1/auth/commands/${pendingId}`), pendingId);
    expect(response.status).toBe(401); expect(f.review).not.toHaveBeenCalled();
  });
  test("unready or unregistered pending commands cannot dispatch", async () => {
    const f = fixture(); f.review.mockResolvedValueOnce({ payload, ready: false });
    expect((await f.http.confirm(request(), pendingId)).status).toBe(409);
    f.review.mockResolvedValueOnce({ payload: { ...payload, path: "/api/v1/unregistered" }, ready: true });
    expect((await f.http.confirm(request(), pendingId)).status).toBe(409); expect(f.confirm).not.toHaveBeenCalled();
  });
  test("provider webhooks retain their original body and size contract", async () => {
    const f = fixture(); const original = request("x".repeat(70_000), {}, `/api/v1/webhooks/sepay/${id}`);
    const execute = vi.fn(async () => Response.json({ size: (await original.text()).length }));
    expect(await (await f.http.run(original, execute)).json()).toEqual({ size: 70_000 }); expect(f.authenticate).not.toHaveBeenCalled();
  });
});
