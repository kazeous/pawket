import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { CommissionFileError, type CommissionFileService } from "@pawket/commission-files";
import { createCommissionFileHttpHandlers } from "../src/platform/commission-file-http";

const origin = "https://pawket.example"; const actor = { userId: "user-buyer-1", sessionId: "session-1" };
function handlers(overrides: Partial<Parameters<typeof createCommissionFileHttpHandlers>[0]> = {}) {
  const files = { createUpload: vi.fn<CommissionFileService["createUpload"]>(async () => ({ fileId: randomUUID(), url: "https://bucket.invalid/put", requiredHeaders: { "content-type": "application/octet-stream" }, expiresAt: new Date().toISOString() })),
    completeUpload: vi.fn(async () => ({ state: "scanning" })), discard: vi.fn(async () => ({ state: "discarded" })), getFile: vi.fn(async () => ({ state: "clean" })),
    downloadGrant: vi.fn(async () => ({ url: "https://bucket.invalid/get?signed=1" })) };
  const onOperation = vi.fn();
  return { files, onOperation, http: createCommissionFileHttpHandlers({ appBaseUrl: origin, lookupHmacKey: new Uint8Array(32).fill(5), authenticate: async () => actor,
    throttle: async () => true, files: files as never, onOperation, ...overrides }) };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: "POST", body: JSON.stringify(body),
  headers: { origin, "content-type": "application/json", "x-real-ip": "203.0.113.5", "idempotency-key": randomUUID(), ...headers } });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { headers: { "x-real-ip": "203.0.113.5", ...headers } });

describe("commission file HTTP", () => {
  test.each(["thread", "submission"] as const)("accepts an order-bound %s upload without a package", async (context) => {
    const { http, files } = handlers(); const orderId = randomUUID();
    const response = await http.createUpload(post("/api/v1/commission-files", { context, orderId, fileName: "synthetic.png", declaredBytes: 10 }));
    expect(response.status).toBe(200);
    expect(files.createUpload).toHaveBeenCalledWith(expect.objectContaining({ actor, context, orderId, declaredBytes: 10 }));
    expect("packageId" in files.createUpload.mock.calls[0]![0]!).toBe(false);
  });
  test("refuses a package-bound thread grant and reports the submission byte limit without echoing input", async () => {
    const { http, files } = handlers();
    expect((await http.createUpload(post("/api/v1/commission-files", { context: "thread", packageId: randomUUID(), fileName: "synthetic.png", declaredBytes: 10 }))).status).toBe(400);
    expect(files.createUpload).not.toHaveBeenCalled();
    files.createUpload.mockRejectedValueOnce(new CommissionFileError("file_too_large"));
    const response = await http.createUpload(post("/api/v1/commission-files", { context: "submission", orderId: randomUUID(), fileName: "synthetic.psd", declaredBytes: 262_144_001 }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "file_too_large" });
    expect(files.createUpload).toHaveBeenCalledOnce();
  });
  test.each([["fulfillment_disabled", 503], ["order_quota_exceeded", 409]] as const)("maps %s for order file grants", async (code, status) => {
    const { http, files } = handlers(); files.createUpload.mockRejectedValueOnce(new CommissionFileError(code));
    const response = await http.createUpload(post("/api/v1/commission-files", { context: "thread", orderId: randomUUID(), fileName: "synthetic.png", declaredBytes: 10 }));
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ code });
  });
  test("serializes redacted terminal status with a null filename and no cache", async () => {
    const fileId = randomUUID();
    const { http } = handlers({ files: { getFile: async () => ({ fileId, state: "discarded", name: null }) } as never });
    const response = await http.status(get(`/api/v1/commission-files/${fileId}`), fileId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ file: { fileId, state: "discarded", name: null } });
  });
  test.each(["createUpload", "status", "complete", "discard", "download"] as const)("rejects a changed expected actor before %s throttling or service access", async (operation) => {
    const throttle = vi.fn(async () => true);
    const { http, files } = handlers({ throttle });
    const fileId = randomUUID(); const orderId = randomUUID();
    const headers = { "x-pawket-actor": "user-buyer-other" };
    const response = operation === "createUpload"
      ? await http.createUpload(post("/api/v1/commission-files", { context: "brief", packageId: randomUUID(), fileName: "a.png", declaredBytes: 10 }, headers))
      : operation === "status" ? await http.status(get(`/api/v1/commission-files/${fileId}`, headers), fileId)
      : operation === "download" ? await http.download(get(`/api/v1/commissions/${orderId}/files/${fileId}?disposition=attachment`, headers), orderId, fileId)
      : await http[operation](post(`/api/v1/commission-files/${fileId}/${operation}`, {}, headers), fileId);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "OIDC_ACTOR_CHANGED" });
    expect(throttle).not.toHaveBeenCalled();
    for (const service of Object.values(files)) expect(service).not.toHaveBeenCalled();
  });
  test.each([undefined, actor.userId])("accepts an absent or matching expected actor (%s)", async (expectedActor) => {
    const throttle = vi.fn(async () => true);
    const { http, files } = handlers({ throttle }); const packageId = randomUUID();
    const response = await http.createUpload(post("/api/v1/commission-files", { context: "brief", packageId, fileName: "a.png", declaredBytes: 10 },
      expectedActor === undefined ? {} : { "x-pawket-actor": expectedActor }));
    expect(response.status).toBe(200);
    expect(throttle).toHaveBeenCalledOnce();
    expect(files.createUpload).toHaveBeenCalledWith(expect.objectContaining({ actor, packageId }));
  });
  test("creates an upload grant for a same-origin authenticated buyer", async () => {
    const { http, files, onOperation } = handlers(); const packageId = randomUUID();
    const response = await http.createUpload(post("/api/v1/commission-files", { context: "brief", packageId, fileName: "a.png", declaredBytes: 10 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ upload: { url: "https://bucket.invalid/put" } });
    expect(files.createUpload).toHaveBeenCalledWith(expect.objectContaining({ actor, context: "brief", packageId, fileName: "a.png", declaredBytes: 10 }));
    expect(onOperation).toHaveBeenCalledWith({ operation: "grant", outcome: "accepted" });
  });
  test.each([
    ["a cross-origin post", () => post("/api/v1/commission-files", {}, { origin: "https://evil.example" }), 403, "untrusted_origin"],
    ["a missing client address", () => post("/api/v1/commission-files", { context: "brief", packageId: randomUUID(), fileName: "a.png", declaredBytes: 1 }, { "x-real-ip": "" }), 503, "dependency_unavailable"],
    ["an extra body field", () => post("/api/v1/commission-files", { context: "brief", packageId: randomUUID(), fileName: "a.png", declaredBytes: 1, orderId: randomUUID() }), 400, "invalid_request"],
  ])("refuses %s", async (_label, request, status, code) => {
    const response = await handlers().http.createUpload(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });
  test("maps service errors to stable HTTP codes", async () => {
    for (const [code, status] of [["file_too_large", 400], ["files_disabled", 503], ["unsent_limit", 409], ["not_available", 404]] as const) {
      const { http, files } = handlers(); files.createUpload.mockRejectedValueOnce(new CommissionFileError(code));
      const response = await http.createUpload(post("/api/v1/commission-files", { context: "brief", packageId: randomUUID(), fileName: "a.png", declaredBytes: 10 }));
      expect([response.status, await response.json()]).toEqual([status, { code }]);
    }
  });
  test("requires a session and respects the rate limit", async () => {
    expect((await handlers({ authenticate: async () => null }).http.status(get(`/api/v1/commission-files/${randomUUID()}`), randomUUID())).status).toBe(401);
    expect((await handlers({ throttle: async () => false }).http.status(get(`/api/v1/commission-files/${randomUUID()}`), randomUUID())).status).toBe(429);
  });
  test("redirects downloads without caching and validates the disposition", async () => {
    const { http, files } = handlers(); const orderId = randomUUID(); const fileId = randomUUID();
    const response = await http.download(get(`/api/v1/commissions/${orderId}/files/${fileId}?disposition=inline`), orderId, fileId);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://bucket.invalid/get?signed=1");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(files.downloadGrant).toHaveBeenCalledWith({ actor, orderId, fileId, disposition: "inline" });
    for (const query of ["", "?disposition=raw", "?disposition=inline&disposition=attachment", "?disposition=inline&x=1"]) {
      expect((await http.download(get(`/api/v1/commissions/${orderId}/files/${fileId}${query}`), orderId, fileId)).status).toBe(400);
    }
    files.downloadGrant.mockRejectedValueOnce(new CommissionFileError("preview_not_allowed"));
    expect((await http.download(get(`/api/v1/commissions/${orderId}/files/${fileId}?disposition=inline`), orderId, fileId)).status).toBe(400);
  });
  test("complete and discard accept only an empty JSON object", async () => {
    const { http } = handlers(); const fileId = randomUUID();
    expect((await http.complete(post(`/api/v1/commission-files/${fileId}/complete`, {}), fileId)).status).toBe(200);
    expect((await http.discard(post(`/api/v1/commission-files/${fileId}/discard`, { reason: "x" }), fileId)).status).toBe(400);
  });
});
