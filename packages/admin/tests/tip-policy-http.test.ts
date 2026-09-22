import { describe, expect, test, vi } from "vitest";
import { createTipPolicyHttpHandlers } from "../src/tip-policy-http.js";

const policy = { revisionId: "00000000-0000-4000-8000-000000000001", revisionNumber: 1,
  minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000], effectiveAt: "2026-09-22T00:00:00.000Z" };
const actor = { userId: "owner-test", sessionId: "owner-session" };
const body = { expectedRevision: 1, minimumVnd: 30_000, maximumVnd: 500_000, allowedPresetsVnd: [30_000, 50_000, 100_000], reason: "Update launch amounts" };
function fixture() {
  const service = { getPolicy: vi.fn(async () => policy), getHistory: vi.fn(async () => ({ revisions: [], nextBeforeRevision: null })),
    savePolicy: vi.fn(async () => ({ ...policy, ...body, revisionNumber: 2 })) };
  const authenticate = vi.fn(async () => actor as typeof actor | null);
  const authorizeOwner = vi.fn(async (): Promise<"authorized" | "forbidden" | "unauthenticated"> => "authorized");
  const throttle = vi.fn(async () => true);
  const handlers = createTipPolicyHttpHandlers({ appBaseUrl: "https://pawket.example", lookupHmacKey: new Uint8Array(32).fill(51),
    paymentsMode: "disabled", publishingMode: "disabled", authenticate, authorizeOwner, throttle, service });
  return { handlers, service, authenticate, authorizeOwner, throttle };
}
function request(method = "POST", value: unknown = body, overrides: Record<string, string> = {}, query = "") {
  return new Request(`https://pawket.example/api/v1/admin/tip-policy${query}`, { method,
    headers: { origin: "https://pawket.example", "content-type": "application/json", "idempotency-key": "owner-policy-attempt-1", "x-real-ip": "127.0.0.1", ...overrides },
    ...(method === "GET" ? {} : { body: JSON.stringify(value) }) });
}
describe("owner tip-policy HTTP boundary", () => {
  test("allows authenticated policy maintenance while payment/publishing modes stay disabled", async () => {
    const f = fixture(); const read = await f.handlers.read(request("GET"));
    expect(await read.json()).toMatchObject({ policy, paymentsEnabled: false, publishingEnabled: false });
    expect(read.headers.get("cache-control")).toContain("no-store");
    expect(read.headers.get("referrer-policy")).toBe("no-referrer");
    const result = await f.handlers.save(request());
    expect(result.status).toBe(200);
    expect(f.service.savePolicy).toHaveBeenCalledWith({ ...body, actor, idempotencyKey: "owner-policy-attempt-1", requestId: expect.any(String) });
  });
  test.each(["unauthenticated", "forbidden"] as const)("rejects %s before domain work", async (state) => {
    const f = fixture(); f.authorizeOwner.mockResolvedValue(state);
    for (const method of ["GET", "POST"]) {
      const result = await (method === "GET" ? f.handlers.read(request(method)) : f.handlers.save(request(method)));
      expect(result.status).toBe(state === "unauthenticated" ? 401 : 403);
    }
    expect(f.service.getPolicy).not.toHaveBeenCalled(); expect(f.service.savePolicy).not.toHaveBeenCalled();
  });
  test("rejects lost session, untrusted origin and missing trusted network independently", async () => {
    const f = fixture(); f.authenticate.mockResolvedValue(null);
    expect((await f.handlers.save(request())).status).toBe(401);
    f.authenticate.mockResolvedValue(actor);
    expect((await f.handlers.save(request("POST", body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await f.handlers.read(request("GET", body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await f.handlers.save(request("POST", body, { "x-real-ip": "" }))).status).toBe(503);
    expect(f.service.savePolicy).not.toHaveBeenCalled();
  });
  test.each([
    { ...body, expectedRevision: "1" }, { ...body, expectedRevision: 0 },
    { ...body, minimumVnd: 29_999.5 }, { ...body, minimumVnd: 500_001 },
    { ...body, maximumVnd: 5_000_001 }, { ...body, allowedPresetsVnd: [30_000, 30_000, 100_000] },
    { ...body, allowedPresetsVnd: [20_000, 50_000, 100_000] }, { ...body, reason: "ab" },
    { ...body, reason: "bad\nreason" }, { ...body, reason: "x".repeat(501) },
    { ...body, actor }, { ...body, proofToken: "client-supplied" }, { ...body, paymentsMode: "manual_only" },
  ])("rejects malformed or expanded commands", async (value) => {
    const f = fixture(); expect((await f.handlers.save(request("POST", value))).status).toBe(400);
    expect(f.service.savePolicy).not.toHaveBeenCalled();
  });
  test("bounds history and rejects ambiguous cursors", async () => {
    const f = fixture(); expect((await f.handlers.read(request("GET", null, {}, "?beforeRevision=4"))).status).toBe(200);
    expect(f.service.getHistory).toHaveBeenLastCalledWith({ actor, beforeRevision: 4, limit: 25 });
    for (const query of ["?beforeRevision=0", "?beforeRevision=2147483648", "?beforeRevision=2&beforeRevision=3", "?limit=100000", "?beforeRevision=1e3"]) {
      expect((await f.handlers.read(request("GET", null, {}, query))).status).toBe(400);
    }
  });
  test("throttles writes and normalizes mapped IPv6 addresses to the same network key", async () => {
    const f = fixture(); await f.handlers.read(request("GET"));
    const first = f.throttle.mock.calls[0];
    await f.handlers.read(request("GET", null, { "x-real-ip": "::ffff:127.0.0.1" }));
    expect(f.throttle.mock.calls[1]).toEqual(first);
    f.throttle.mockResolvedValue(false);
    expect((await f.handlers.save(request())).status).toBe(429); expect(f.service.savePolicy).not.toHaveBeenCalled();
  });
  test("enforces media type, streaming byte bound, and no command query", async () => {
    const f = fixture();
    expect((await f.handlers.save(request("POST", body, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await f.handlers.save(request("POST", { ...body, reason: "x".repeat(5000) }))).status).toBe(413);
    expect((await f.handlers.save(request("POST", body, {}, "?bypass=true"))).status).toBe(400);
    expect((await f.handlers.save(request("POST", body, { "content-encoding": "gzip" }))).status).toBe(400);
    expect(f.service.savePolicy).not.toHaveBeenCalled();
  });
  test.each([
    ["OWNER_STEP_UP_REQUIRED", 403, "owner_totp_required"], ["VERSION_CONFLICT", 409, "version_conflict"],
    ["IDEMPOTENCY_CONFLICT", 409, "idempotency_conflict"], ["POLICY_UNAVAILABLE", 503, "policy_unavailable"],
    ["SQL_SENSITIVE", 503, "dependency_unavailable"],
  ] as const)("maps %s without disclosing dependency messages", async (code, status, safeCode) => {
    const f = fixture(); f.service.savePolicy.mockRejectedValue(Object.assign(new Error("private-sql-marker"), { code }));
    const result = await f.handlers.save(request()); expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ code: safeCode });
  });
});
