import { describe, expect, test, vi } from "vitest";
import { requireIntegerVnd, TipPaymentError, type TipInstructionProjection, type TipCreationPaymentResult } from "@pawket/payments";
import { createTipHttpHandlers } from "../src/tip-http.js";
import { tipCookie, tipNetworkKey, TIP_GUEST_CONTEXT_COOKIE, tipReceiptCookieName } from "../src/http-boundary.js";

const at = new Date("2026-09-12T00:00:00Z"); const key = new Uint8Array(32).fill(37);
const reference = `PW${"1".repeat(20)}`; const context = "A".repeat(43); const secret = "B".repeat(43);
const instruction: TipInstructionProjection = { reference, creator: { displayName: "Artist", handle: "artist" }, amountVnd: requireIntegerVnd(50_000), currency: "VND",
  state: "awaiting_transfer", expiresAt: new Date(at.getTime() + 86_400_000).toISOString(), confirmedAt: null, transferClaimedAt: null,
  destination: { bankBin: "970436", bankName: "Vietcombank", accountNumber: "000001234567", accountName: "SYNTHETIC ARTIST" }, qrPayload: "synthetic-local-payload" };
const { destination: _destination, qrPayload: _qrPayload, ...receipt } = instruction;
void _destination; void _qrPayload;
function setup(overrides: Partial<Parameters<typeof createTipHttpHandlers>[0]> = {}) {
  const creation = { createTip: vi.fn(async (): Promise<TipCreationPaymentResult> => ({ instruction, guestCapability: { secret, expiresAt: new Date(at.getTime() + 604_800_000) } })) };
  const receipts = { readReceipt: vi.fn(async () => ({ receipt, instruction })), reportTransfer: vi.fn(async () => ({ claimedAt: at, authoritative: false as const })) };
  const authenticate = vi.fn(async (): Promise<{ userId: string } | null> => null);
  const throttle = vi.fn(async () => ({ allowed: true })); const resolveCreatorRateSubject = vi.fn(async () => "creator-internal-id");
  const handlers = createTipHttpHandlers({ appBaseUrl: "https://pawket.test", paymentsMode: "manual_only", publishingMode: "general_audience", lookupHmacKey: key,
    guestContextTtlMs: 604_800_000, rateWindowMs: 3_600_000, createIpLimit: 10, createCreatorLimit: 100, receiptLimit: 120,
    creation, receipts, authenticate, throttle, resolveCreatorRateSubject, now: () => at, ...overrides });
  return { handlers, creation, receipts, authenticate, throttle, resolveCreatorRateSubject };
}
function request(path = "/api/v1/public/creators/artist/tips", init: RequestInit = {}) {
  return new Request(`https://pawket.test${path}`, { method: "POST", body: JSON.stringify({ amountVnd: 50_000 }), ...init,
    headers: { origin: "https://pawket.test", "content-type": "application/json", "x-real-ip": "192.0.2.44", "idempotency-key": "synthetic-command-1",
      cookie: `${TIP_GUEST_CONTEXT_COOKIE}=${context}`, ...Object.fromEntries(new Headers(init.headers).entries()) } });
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

describe("tip HTTP capability and bounded request boundary", () => {
  test("kill switch preserves authorized receipts but suppresses instructions and transfer claims", async () => {
    const s = setup({ paymentsMode: "disabled" });
    const response = await s.handlers.receipt(request(`/api/v1/tips/${reference}`, { method: "GET", body: undefined, headers: { cookie: `${tipReceiptCookieName(reference)}=${secret}` } }), reference);
    expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toEqual({ receipt, instruction: null, paymentsEnabled: false });
    expect(s.receipts.readReceipt).toHaveBeenCalledWith({ reference, access: { kind: "guest", capability: secret } });
    expect((await s.handlers.claim(request(undefined, { body: "{}" }), reference)).status).toBe(503);
    expect(s.receipts.reportTransfer).not.toHaveBeenCalled();
    expect((await s.handlers.receipt(request(undefined, { method: "GET", body: undefined, headers: { cookie: "" } }), reference)).status).toBe(404);
  });
  test("creates the receipt without a JSON credential and sets both narrowly scoped Secure cookies", async () => {
    const s = setup(); const response = await s.handlers.create(request(), "artist");
    expect(response.status).toBe(201); privateResponse(response);
    const body = await response.text(); expect(body).not.toContain(secret); expect(body).not.toContain(context); expect(JSON.parse(body)).toEqual({ instruction });
    const cookies = response.headers.getSetCookie(); expect(cookies).toHaveLength(2);
    for (const cookie of cookies) { expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict"); expect(cookie).not.toContain("Domain="); }
    expect(cookies[0]).toContain(`Path=/api/v1/tips/${reference};`); expect(cookies[1]).toContain(`Path=/tips/${reference};`);
    expect(s.creation.createTip).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: "guest", context }, amountVnd: 50_000,
      abuseKeyHash: expect.stringMatching(/^hmac-sha256:v1:/u), idempotencyKey: "synthetic-command-1" }));
    expect(JSON.stringify(s.throttle.mock.calls)).not.toContain("192.0.2.44"); expect(JSON.stringify(s.throttle.mock.calls)).not.toContain(context);
  });

  test("establishes an opaque guest context without exposing it and preserves it for lost-response retries", async () => {
    const s = setup();
    const issued = await s.handlers.guestContext(request("/api/v1/tips/guest-context", { body: "{}", headers: { cookie: "" } }));
    expect(await issued.json()).toEqual({ ready: true }); privateResponse(issued);
    expect(issued.headers.getSetCookie()[0]).toMatch(/^__Host-pawket_tip_create=[A-Za-z0-9_-]{43}; Path=\/;/u);
    const kept = await s.handlers.guestContext(request("/api/v1/tips/guest-context", { body: "{}" }));
    expect(kept.headers.getSetCookie()).toEqual([]);
    const missing = await s.handlers.create(request(undefined, { headers: { cookie: "" } }), "artist");
    expect(missing.status).toBe(409); expect(await missing.json()).toEqual({ code: "guest_context_required" }); expect(s.creation.createTip).not.toHaveBeenCalled();
  });

  test("signed-in creation uses server session ownership and never trusts buyer fields from JSON", async () => {
    const s = setup(); s.authenticate.mockResolvedValue({ userId: "buyer-one" }); s.creation.createTip.mockResolvedValue({ instruction, guestCapability: null });
    const response = await s.handlers.create(request(undefined, { headers: { cookie: "" } }), "artist");
    expect(response.status).toBe(201); expect(response.headers.getSetCookie()).toEqual([]);
    expect(s.creation.createTip).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: "buyer", userId: "buyer-one" } }));
    const rejected = await s.handlers.create(request(undefined, { body: JSON.stringify({ amountVnd: 50_000, buyerUserId: "victim" }) }), "artist");
    expect(rejected.status).toBe(400);
  });

  test.each(["https://evil.test", "null", "https://pawket.test.evil.test", "https://pawket.test/", ""]) ("rejects an untrusted/malformed origin before authentication or business calls (%s)", async (origin) => {
    const s = setup(); const response = await s.handlers.create(request(undefined, { headers: { origin } }), "artist");
    expect(response.status).toBe(403); privateResponse(response); expect(s.authenticate).not.toHaveBeenCalled(); expect(s.throttle).not.toHaveBeenCalled();
  });

  test("disabled modes and methods are uniform, and cross-site reads cannot reach receipt services", async () => {
    for (const modes of [{ paymentsMode: "disabled" as const }, { publishingMode: "disabled" as const }]) {
      const s = setup(modes); const response = await s.handlers.create(request(), "artist");
      expect(response.status).toBe(503); privateResponse(response); expect(s.creation.createTip).not.toHaveBeenCalled();
    }
    const s = setup(); expect((await s.handlers.create(request(undefined, { method: "PUT" }), "artist")).status).toBe(405);
    const cross = await s.handlers.receipt(request(`/api/v1/tips/${reference}`, { method: "GET", body: undefined, headers: { "sec-fetch-site": "cross-site" } }), reference);
    expect(cross.status).toBe(403); expect(s.receipts.readReceipt).not.toHaveBeenCalled();
  });

  test.each([
    [{ "content-type": "text/plain" }, "{}", 415], [{ "content-type": "application/json; charset=utf-16" }, "{}", 415],
    [{ "content-length": "99999" }, "{}", 413], [{ "content-length": "1e3" }, "{}", 400],
    [{}, " ".repeat(4097), 413], [{}, "{broken", 400], [{}, "[]", 400], [{}, "null", 400],
    [{}, '{"amountVnd":50000,"accountNumber":"11111111"}', 400],
  ])("bounds content type, declared/streamed bytes and exact JSON fields (%#)", async (headers, body, status) => {
    const s = setup(); const response = await s.handlers.create(request(undefined, { headers: headers as Record<string, string>, body: body as string }), "artist");
    expect(response.status).toBe(status); privateResponse(response); expect(s.creation.createTip).not.toHaveBeenCalled();
  });

  test("invalid UTF-8 and query credentials are rejected", async () => {
    const s = setup();
    expect((await s.handlers.create(request(undefined, { body: new Uint8Array([0xff, 0xfe]) }), "artist")).status).toBe(400);
    expect((await s.handlers.receipt(request(`/api/v1/tips/${reference}?secret=${secret}`, { method: "GET", body: undefined }), reference)).status).toBe(400);
    expect(s.creation.createTip).not.toHaveBeenCalled(); expect(s.receipts.readReceipt).not.toHaveBeenCalled();
  });

  test("missing proxy address, unavailable throttle and per-creator denial fail closed", async () => {
    const s = setup();
    const missing = await s.handlers.create(request(undefined, { headers: { "x-real-ip": "", "x-forwarded-for": "192.0.2.1" } }), "artist");
    expect(missing.status).toBe(503); expect(s.creation.createTip).not.toHaveBeenCalled();
    s.throttle.mockRejectedValueOnce(new Error("private dependency detail"));
    const unavailable = await s.handlers.create(request(), "artist"); expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain("private");
    s.throttle.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });
    const limited = await s.handlers.create(request(), "artist"); expect(limited.status).toBe(429); expect(s.creation.createTip).not.toHaveBeenCalled();
  });

  test("receipt failures are enumeration-safe and matching cookies are the only guest access input", async () => {
    const s = setup(); const path = `/api/v1/tips/${reference}`;
    const missing = await s.handlers.receipt(request(path, { method: "GET", body: undefined }), reference);
    expect(missing.status).toBe(404); const failureBody = await missing.json();
    for (const code of ["not_authorized", "not_available"] as const) {
      s.receipts.readReceipt.mockRejectedValueOnce(new TipPaymentError(code));
      const response = await s.handlers.receipt(request(path, { method: "GET", body: undefined, headers: { cookie: `${tipReceiptCookieName(reference)}=${secret}` } }), reference);
      expect(response.status).toBe(404); privateResponse(response); expect(await response.json()).toEqual(failureBody);
    }
    const read = await s.handlers.receipt(request(path, { method: "GET", body: undefined, headers: { cookie: `${tipReceiptCookieName(reference)}=${secret}` } }), reference);
    expect(read.status).toBe(200); expect(s.receipts.readReceipt).toHaveBeenLastCalledWith({ reference, access: { kind: "guest", capability: secret } });
  });

  test("claim only accepts an empty command and explicitly says it is not confirmation", async () => {
    const s = setup(); const path = `/api/v1/tips/${reference}/transfer-claims`; const headers = { cookie: `${tipReceiptCookieName(reference)}=${secret}` };
    const rejected = await s.handlers.claim(request(path, { body: '{"confirmed":true}', headers }), reference);
    expect(rejected.status).toBe(400); expect(s.receipts.reportTransfer).not.toHaveBeenCalled();
    const response = await s.handlers.claim(request(path, { body: "{}", headers }), reference);
    expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toEqual({ claim: { claimedAt: at.toISOString(), authoritative: false }, paymentConfirmed: false });
  });

  test("normalizes IPv6 and IPv4-mapped addresses and rejects forged forwarded chains or duplicate cookies", () => {
    const network = (ip: string) => tipNetworkKey(new Headers({ "x-real-ip": ip }), key);
    expect(network("2001:db8::1")).toBe(network("2001:0DB8:0000:0000:0000:0000:0000:0001"));
    expect(network("192.0.2.44")).toBe(network("::ffff:192.0.2.44"));
    for (const bad of ["192.0.2.44, 10.0.0.1", "010.0.0.1", "fe80::1%eth0", "999.1.1.1"]) expect(network(bad)).toBeNull();
    expect(tipCookie(new Headers({ cookie: `${TIP_GUEST_CONTEXT_COOKIE}=${context}; ${TIP_GUEST_CONTEXT_COOKIE}=${secret}` }), TIP_GUEST_CONTEXT_COOKIE)).toBeNull();
  });
});
