import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { normalizeSePayId, normalizeSePayReference, normalizeSePayVnd, parseSePayJson, parseSePayVietnamTime } from "../src/sepay-normalization.js";
import { authenticateAndParseSePayWebhook, parseAuthenticatedSePayWebhook, SEPAY_WEBHOOK_MAX_BYTES } from "../src/sepay-webhook.js";

const now = new Date("2026-09-23T12:00:00.000Z");
const secret = "synthetic-hmac-key-".repeat(3);
const reference = "PW0123456789ABCDEF0123";
const payload = { id: 12345, gateway: "Vietcombank", transactionDate: "2026-09-23 18:59:59", accountNumber: "0071000888888", subAccount: null,
  code: reference, content: `Tip ${reference}`, transferType: "in", transferAmount: 20000, referenceCode: "bank-reference" };
const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
function authenticate(bytes = raw(payload), overrides: Partial<Parameters<typeof authenticateAndParseSePayWebhook>[0]> = {}) {
  const timestamp = String(now.getTime() / 1000);
  return authenticateAndParseSePayWebhook({ rawBody: bytes, contentType: "application/json", timestamp,
    signature: `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(bytes).digest("hex")}`, secret, now, ...overrides });
}

describe("SePay raw-byte webhook boundary (synthetic fixtures)", () => {
  it("authenticates exact original bytes and yields only minimal normalized facts", () => {
    const result = authenticate(raw({ ...payload, accumulated: 99999999, description: "private unrelated provider field" }));
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unexpected disposition");
    expect(result.event).toEqual({ id: "12345", bankGateway: "Vietcombank", accountNumber: "0071000888888", subAccount: null,
      amountVnd: 20000, occurredAt: new Date("2026-09-23T11:59:59Z"), reference, referenceStatus: "exact", bankReference: "bank-reference" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parseAuthenticatedSePayWebhook(raw(payload))).toEqual(authenticate());
  });
  it("rejects a signature after whitespace or byte mutation", () => {
    const timestamp = String(now.getTime() / 1000);
    const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw(payload)).digest("hex")}`;
    expect(() => authenticate(Buffer.from(`${JSON.stringify(payload)} `), { signature })).toThrow("invalid_authentication");
  });
  it.each([null, "sha256=", "sha256=" + "x".repeat(64), "SHA256=" + "0".repeat(64), "sha256=" + "0".repeat(64)])("rejects missing/malformed/incorrect signature %s", (signature) => {
    expect(() => authenticate(undefined, { signature })).toThrow("invalid_authentication");
  });
  it.each([null, "0", "177", "1.2", "1e10", " 1790164800", "1790164800,1790164800"])("rejects malformed timestamp %s", (timestamp) => {
    expect(() => authenticate(undefined, { timestamp })).toThrow("invalid_authentication");
  });
  it("enforces the bounded replay window in both directions", () => {
    expect(() => authenticate(undefined, { now: new Date(now.getTime() + 300001) })).toThrow("invalid_authentication");
    expect(() => authenticate(undefined, { now: new Date(now.getTime() - 300001) })).toThrow("invalid_authentication");
    expect(authenticate(undefined, { now: new Date(now.getTime() + 300000) }).kind).toBe("accepted");
  });
  it.each([null, "text/json", "text/plain", "application/json; charset=latin1", "application/json, text/html"])("rejects media type %s", (contentType) => {
    expect(() => authenticate(undefined, { contentType })).toThrow("unsupported_media");
  });
  it("accepts UTF-8 declarations and rejects compressed bodies or invalid UTF-8", () => {
    expect(authenticate(undefined, { contentType: 'application/json; charset="UTF-8"' }).kind).toBe("accepted");
    expect(() => authenticate(undefined, { contentEncoding: "gzip" })).toThrow("unsupported_media");
    expect(() => authenticate(Buffer.from([0xff, 0xfe]))).toThrow("invalid_payload");
  });
  it("bounds raw body size before parsing", () => {
    expect(() => authenticate(Buffer.alloc(SEPAY_WEBHOOK_MAX_BYTES + 1))).toThrow("body_too_large");
    expect(() => parseAuthenticatedSePayWebhook(Buffer.alloc(SEPAY_WEBHOOK_MAX_BYTES + 1))).toThrow("body_too_large");
  });
  it.each([["outgoing", { transferType: "out" }], ["non_pawket", { code: null, content: "Personal transfer" }], ["mock", { id: 0 }]] as const)("minimizes authenticated %s events", (reason, fields) => {
    const result = authenticate(raw({ ...payload, ...fields }));
    expect(result).toEqual({ kind: "ignored", reason, providerEventId: reason === "mock" ? "0" : "12345", digest: expect.any(String) });
    expect(result).not.toHaveProperty("event");
  });
  it.each([{ id: -1 }, { transferType: "credit" }, { transferAmount: 1.25 }, { transactionDate: "2026-02-30 12:00:00" },
    { gateway: "bad\nvalue" }, { accountNumber: null }, { subAccount: undefined }, { code: {} }, { content: "a".repeat(4097) }])("rejects invalid normalized fields %j", (fields) => {
    expect(() => authenticate(raw({ ...payload, ...fields }))).toThrow("invalid_payload");
  });
  it("rejects duplicate JSON keys including escaped aliases", () => {
    const bytes = Buffer.from(JSON.stringify(payload).replace('"id":12345', '"id":12345,"\\u0069d":54321'));
    expect(() => authenticate(bytes)).toThrow("invalid_payload");
  });
  it("keeps ambiguous references for private review without granting a match", () => {
    const result = authenticate(raw({ ...payload, content: `${reference} ${reference}` }));
    expect(result.kind === "accepted" && result.event.referenceStatus).toBe("ambiguous");
  });
});

describe("lossless provider normalization", () => {
  it("preserves numeric IDs beyond JavaScript's integer range", () => {
    const value = parseSePayJson('{"id":9007199254740993123456789}') as { id: unknown };
    expect(normalizeSePayId(value.id)).toBe("9007199254740993123456789");
  });
  it.each(["01", "1e3", "1.0", "-1", "0", "api-v2-uuid", "1".repeat(33), Number.MAX_SAFE_INTEGER + 1])("rejects ambiguous/lossy numeric identity %s", (value) => {
    expect(() => normalizeSePayId(value)).toThrow("invalid_provider_schema");
  });
  it.each(["20000", "20000.0", "20000.000000000000000000", 20000])("accepts integral VND %s", (value) => {
    expect(normalizeSePayVnd(value)).toBe(20000);
  });
  it("checks the original decimal instead of rounding provider JSON", () => {
    const value = parseSePayJson('{"amount":20000.000000000000000001}') as { amount: unknown };
    expect(() => normalizeSePayVnd(value.amount)).toThrow("invalid_provider_schema");
    const exact = parseSePayJson('{"amount":20000.00}') as { amount: unknown };
    expect(normalizeSePayVnd(exact.amount)).toBe(20000);
  });
  it.each(["0", "-1", "1e4", "20000.01", "9007199254740992", " 20000", "020000", 0.01, Infinity, NaN])("rejects nonpositive/fractional/unsafe VND %s", (value) => {
    expect(() => normalizeSePayVnd(value)).toThrow("invalid_provider_schema");
  });
  it("rejects duplicate keys and deep objects, including irrelevant provider fields", () => {
    expect(() => parseSePayJson('{"id":1,"id":2}')).toThrow("invalid_provider_schema");
    expect(() => parseSePayJson("[".repeat(17) + "0" + "]".repeat(17))).toThrow("invalid_provider_schema");
  });
  it.each(["2026-02-29 12:00:00", "2026-09-23T12:00:00Z", "2026-09-23 24:00:00", "2026-13-23 12:00:00"])("rejects invalid or alternate timezone interpretation %s", (value) => {
    expect(() => parseSePayVietnamTime(value)).toThrow("invalid_provider_schema");
  });
  it("uses explicit Vietnam timezone and validates leap days", () => {
    expect(parseSePayVietnamTime("2028-02-29 00:00:00").toISOString()).toBe("2028-02-28T17:00:00.000Z");
  });
  it("requires an entire reference token and code/content agreement", () => {
    expect(normalizeSePayReference(reference, `Tip ${reference}`)).toMatchObject({ reference, referenceStatus: "exact" });
    expect(normalizeSePayReference(reference, `Tip prefix${reference}`)).toMatchObject({ referenceStatus: "missing" });
    expect(normalizeSePayReference(reference, `Tip ${reference}0`)).toMatchObject({ referenceStatus: "missing" });
    expect(normalizeSePayReference("PWFFFFFFFFFFFFFFFFFFFF", `Tip ${reference}`)).toMatchObject({ referenceStatus: "conflicting" });
    expect(normalizeSePayReference(reference.toLowerCase(), `Tip ${reference.toLowerCase()}`)).toMatchObject({ referenceStatus: "missing" });
  });
});
