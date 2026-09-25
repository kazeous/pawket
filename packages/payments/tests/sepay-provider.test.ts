import { describe, expect, it, vi } from "vitest";

import { createSePayDocumentedTransport, createSePayOAuthProvider, SEPAY_READ_SCOPES, type SePayReadbackInput } from "../src/sepay-provider.js";

const at = new Date("2026-09-23T12:00:00Z");
const reference = "PW0123456789ABCDEF0123";
const binding = { environment: "test" as const, tenantId: "synthetic-tenant", accountId: "19", bankBin: "970436", bankGateway: "Vietcombank", accountNumber: "0071000888888", subAccount: null };
const query: SePayReadbackInput = { accessToken: "synthetic-access-token", binding,
  event: { id: "12345", bankGateway: binding.bankGateway, accountNumber: binding.accountNumber, subAccount: null, amountVnd: 20000, occurredAt: at, reference, referenceStatus: "exact", bankReference: "bank-ref" },
  from: new Date("2026-09-23T11:00:00Z"), to: at };
const providerRow = { id: 12345, bank_account_id: 19, bank_brand_name: "Vietcombank", account_number: "0071000888888", transaction_date: "2026-09-23 19:00:00",
  amount_in: 20000, amount_out: 0, transaction_content: `Tip ${reference}`, code: reference, sub_account: null, reference_number: "bank-ref", accumulated: 999999999 };
const accountRow = { id: 19, account_number: "0071000888888", active: true, bank: { bin: "970436", short_name: "Vietcombank" }, account_holder_name: "PRIVATE HOLDER", accumulated: 99999999 };
const page = (data: unknown[], total = data.length, current = 1) => ({ status: "success", data, meta: { pagination: { total, per_page: 20, current_page: current, last_page: Math.max(1, Math.ceil(total / 20)) } } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
const token = { access_token: "returned-access-token", refresh_token: "returned-refresh-token", expires_in: 3600, token_type: "Bearer" };
function transport(fetcher: (url: URL, init: RequestInit) => Promise<Response>) {
  return createSePayDocumentedTransport({ clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret", redirectUri: "https://pawket.test/api/v1/creator/sepay/oauth/callback", fetch: fetcher, now: () => at });
}

describe("SePay unresolved production capabilities", () => {
  it.each(["test", "live"] as const)("cannot turn configuration into proof for %s", async (environment) => {
    const provider = createSePayOAuthProvider(environment);
    expect(provider.environment).toBe(environment);
    expect(Object.values(provider.capabilities).every((capability) => !capability)).toBe(true);
    expect(() => provider.authorizationUrl({ state: "a".repeat(43), codeChallenge: "b".repeat(43) })).toThrow("contract_unverified");
    await expect(provider.exchange({ code: "code", codeVerifier: "v".repeat(43) })).rejects.toThrow("contract_unverified");
    await expect(provider.refresh({ refreshToken: "refresh" })).rejects.toThrow("contract_unverified");
    await expect(provider.discoverAccounts({ accessToken: "access" })).resolves.toEqual({ kind: "inconclusive", reason: "contract_unverified" });
    await expect(provider.readback(query)).resolves.toEqual({ kind: "inconclusive", reason: "contract_unverified" });
    await expect(provider.revoke?.({ accessToken: "access", refreshToken: "refresh" })).resolves.toBe("unverified");
    expect(Object.isFrozen(provider.capabilities)).toBe(true);
  });
});

describe("documented transport using synthetic responses, not provider acceptance", () => {
  it("constructs only fixed authorization origin/read scopes with S256 and registered redirect", () => {
    const fetcher = vi.fn();
    const provider = transport(fetcher);
    const url = new URL(provider.authorizationUrl({ state: "a".repeat(43), codeChallenge: "b".repeat(43) }));
    expect(url.origin + url.pathname).toBe("https://my.sepay.vn/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe(SEPAY_READ_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("exchanges one code without retries and parses grant lifetime conservatively", async () => {
    const fetcher = vi.fn(async () => json(token));
    const grant = await transport(fetcher).exchange({ code: "authorization-code", codeVerifier: "v".repeat(43) });
    expect(grant).toEqual({ accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: new Date(at.getTime() + 3600000), scopes: SEPAY_READ_SCOPES });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://my.sepay.vn/oauth/token");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    const fields = init.body as URLSearchParams;
    expect(fields.get("code_verifier")).toBe("v".repeat(43));
    expect(fields.get("grant_type")).toBe("authorization_code");
    expect(fields.get("redirect_uri")).toBe("https://pawket.test/api/v1/creator/sepay/oauth/callback");
  });
  it("sends refresh exactly once and returns the rotated pair", async () => {
    const fetcher = vi.fn(async () => json(token));
    await transport(fetcher).refresh({ refreshToken: "old-refresh-token" });
    const [, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect((init.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
    expect((init.body as URLSearchParams).get("refresh_token")).toBe("old-refresh-token");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...token, scope: "bank-account:read transaction:read company" }, { ...token, scope: "transaction:read" }, { ...token, token_type: "Other" },
    { ...token, refresh_token: undefined }, { ...token, expires_in: 100000 }, { ...token, expires_in: 0 }, { ...token, access_token: "a\rb" }])("fails ambiguous token response to reconnect %j", async (body) => {
    await expect(transport(async () => json(body)).refresh({ refreshToken: "old-refresh" })).rejects.toThrow("grant_outcome_unknown");
  });
  it("never logs or exposes a lost-token-response error/body/secret", async () => {
    const fetcher = vi.fn(async () => { throw new Error("secret=raw-refresh-token; provider diagnostic personal data"); });
    const failure = await transport(fetcher).refresh({ refreshToken: "raw-refresh-token" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "grant_outcome_unknown" });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("raw-refresh-token");
    expect(String(failure)).not.toContain("personal data");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[401, "unauthorized"], [403, "forbidden"], [500, "unavailable"]] as const)("maps read HTTP %d to fixed %s without a retry", async (status, code) => {
    const fetcher = vi.fn(async () => json({ secret: "never returned" }, { status }));
    await expect(transport(fetcher).readback(query)).rejects.toMatchObject({ code, message: code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([["17", 17], ["Wed, 23 Sep 2026 12:00:21 GMT", 21], ["invalid", null]] as const)("preserves bounded Retry-After %s", async (header, expected) => {
    await expect(transport(async () => json({}, { status: 429, headers: { "retry-after": header } })).readback(query)).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: expected });
  });
  it("does not follow redirects or use a response from another host", async () => {
    const response = json(page([providerRow]));
    Object.defineProperty(response, "url", { value: "https://attacker.test/transactions" });
    await expect(transport(async () => response).readback(query)).rejects.toThrow("invalid_response");
    await expect(transport(async () => json({}, { status: 302, headers: { location: "https://attacker.test" } })).readback(query)).rejects.toThrow("unavailable");
  });
  it("pins detailed account schema, minimizes output and never invents binding identity", async () => {
    const result = await transport(async () => json(page([accountRow]))).discoverAccounts({ accessToken: "access" });
    expect(result).toEqual({ kind: "complete", records: [{ accountId: "19", bankBin: "970436", bankGateway: "Vietcombank", accountNumber: "0071000888888", subAccount: null, active: true, binding: null }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    await expect(transport(async () => json({ status: 200, bankaccounts: [accountRow] })).discoverAccounts({ accessToken: "access" })).resolves.toEqual({ kind: "inconclusive", reason: "invalid_schema" });
  });
  it("bounds queries to one account, dates, exact amount and optional bank reference", async () => {
    const fetcher = vi.fn(async () => json(page([providerRow])));
    const result = await transport(fetcher).readback(query);
    const [url] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(Object.fromEntries(url.searchParams)).toEqual({ bank_account_id: "19", account_number: "0071000888888", from_date: "2026-09-23", to_date: "2026-09-23", amount_in: "20000", amount_out: "0", reference_number: "bank-ref", page: "1", limit: "20" });
    expect(result).toMatchObject({ kind: "complete", records: [{ id: "12345", accountId: "19", amountVnd: 20000, direction: "in", occurredAt: at, reference, referenceStatus: "exact" }] });
    expect(JSON.stringify(result)).not.toContain("accumulated");
  });
  it("independently normalizes returned mismatches instead of relabeling them with requested identity", async () => {
    const result = await transport(async () => json(page([{ ...providerRow, bank_account_id: 20, account_number: "DIFFERENT" }]))).readback(query);
    expect(result).toMatchObject({ kind: "complete", records: [{ accountId: "20", accountNumber: "DIFFERENT" }] });
  });
  it.each([{ amount_in: 20000.01 }, { amount_in: 20000, amount_out: 1 }, { amount_in: 0 }, { transaction_date: "2026-02-30 12:00:00" }, { sub_account: undefined }])("returns inconclusive for malformed transaction %j", async (fields) => {
    await expect(transport(async () => json(page([{ ...providerRow, ...fields }]))).readback(query)).resolves.toEqual({ kind: "inconclusive", reason: "invalid_schema" });
  });
  it("exhausts bounded pagination and verifies every page instead of choosing the first row", async () => {
    const first = Array.from({ length: 20 }, (_, i) => ({ ...providerRow, id: i + 1 }));
    const fetcher = vi.fn().mockResolvedValueOnce(json(page(first, 21, 1))).mockResolvedValueOnce(json(page([providerRow], 21, 2)));
    const result = await transport(fetcher).readback(query);
    expect(result.kind === "complete" && result.records.length).toBe(21);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects duplicate IDs, moving totals or invalid pages", async () => {
    const first = Array.from({ length: 20 }, (_, i) => ({ ...providerRow, id: i + 1 }));
    const duplicate = vi.fn().mockResolvedValueOnce(json(page(first, 21, 1))).mockResolvedValueOnce(json(page([{ ...providerRow, id: 1 }], 21, 2)));
    await expect(transport(duplicate).readback(query)).resolves.toEqual({ kind: "inconclusive", reason: "pagination_changed" });
    const moving = vi.fn().mockResolvedValueOnce(json(page(first, 21, 1))).mockResolvedValueOnce(json(page([providerRow, { ...providerRow, id: 999 }], 22, 2)));
    await expect(transport(moving).readback(query)).resolves.toEqual({ kind: "inconclusive", reason: "pagination_changed" });
    await expect(transport(async () => json(page([providerRow], 21, 1))).readback(query)).resolves.toEqual({ kind: "inconclusive", reason: "invalid_schema" });
  });
  it("rejects an exceeded row budget as inconclusive, never an empty complete result", async () => {
    const fetcher = vi.fn(async () => json(page(Array.from({ length: 20 }, (_, i) => ({ ...providerRow, id: i + 1 })), 101, 1)));
    await expect(transport(fetcher).readback(query)).resolves.toEqual({ kind: "inconclusive", reason: "limit_exceeded" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses whole-feed/unbounded date requests before sending credentials", () => {
    const fetcher = vi.fn();
    const api = transport(fetcher);
    expect(() => api.readback({ ...query, from: new Date("2020-01-01") })).toThrow("invalid_request");
    expect(() => api.readback({ ...query, from: new Date("invalid") })).toThrow("invalid_request");
    expect(() => api.readback({ ...query, from: new Date(at.getTime() + 1) })).toThrow("invalid_request");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects malformed/oversized/duplicate-key provider responses", async () => {
    await expect(transport(async () => new Response("{}", { headers: { "content-type": "text/html" } })).readback(query)).rejects.toThrow("invalid_response");
    await expect(transport(async () => new Response(" ".repeat(128 * 1024 + 1), { headers: { "content-type": "application/json" } })).readback(query)).rejects.toThrow("invalid_response");
    await expect(transport(async () => new Response('{"status":"success","status":"failed"}', { headers: { "content-type": "application/json" } })).readback(query)).rejects.toThrow("invalid_response");
  });
  it("rejects insecure redirects and header injection before network activity", () => {
    expect(() => createSePayDocumentedTransport({ clientId: "x", clientSecret: "y", redirectUri: "http://pawket.test/callback" })).toThrow("invalid_request");
    expect(() => createSePayDocumentedTransport({ clientId: "x", clientSecret: "y", redirectUri: "https://user:password@pawket.test/callback" })).toThrow("invalid_request");
    expect(() => transport(vi.fn()).exchange({ code: "code", codeVerifier: "invalid" })).toThrow("invalid_request");
  });
});
