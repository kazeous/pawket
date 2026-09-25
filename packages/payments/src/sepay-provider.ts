import {
  normalizeSePayId, normalizeSePayReference, normalizeSePayVnd, parseSePayJson,
  parseSePayVietnamTime, sepayNullableText, sepayRecord, sepayText,
  type SePayReference,
} from "./sepay-normalization.js";
import type { SePayWebhookEvent } from "./sepay-webhook.js";

export const SEPAY_READ_SCOPES = ["bank-account:read", "transaction:read"] as const;
export type SePayEnvironment = "test" | "live";
export type SePayProviderCapabilities = Readonly<{
  oauthApplication: boolean; pkceS256: boolean; stableAccountIdentity: boolean;
  canonicalTransactionIdentity: boolean; bankTimeReference: boolean; remoteRevocation: boolean;
}>;
/** Values must come from a provider-authenticated contract, never creator input. */
export type SePayProviderBinding = Readonly<{
  environment: SePayEnvironment; tenantId: string; accountId: string;
  bankBin: string; bankGateway: string; accountNumber: string; subAccount: string | null;
}>;
export type SePayProviderGrant = Readonly<{
  accessToken: string; refreshToken: string; expiresAt: Date; scopes: ReadonlyArray<string>;
}>;
export type SePayProviderAccount = Readonly<{
  accountId: string; bankBin: string; bankGateway: string; accountNumber: string;
  subAccount: string | null; active: boolean; binding: SePayProviderBinding | null;
}>;
export type SePayProviderTransaction = Readonly<{
  id: string; binding: SePayProviderBinding; amountVnd: number; direction: "in" | "out";
  occurredAt: Date; reference: string | null; referenceStatus: SePayReference["referenceStatus"];
  bankReference: string | null;
}>;
export type SePayInconclusiveReason = "contract_unverified" | "limit_exceeded" | "pagination_changed" | "invalid_schema";
export type SePayReadbackResult = Readonly<{ kind: "complete"; transactions: ReadonlyArray<SePayProviderTransaction> }> |
  Readonly<{ kind: "inconclusive"; reason: SePayInconclusiveReason }>;
export type SePayAccountDiscovery = Readonly<{ kind: "complete"; accounts: ReadonlyArray<SePayProviderAccount> }> |
  Readonly<{ kind: "inconclusive"; reason: SePayInconclusiveReason }>;
export type SePayReadbackInput = Readonly<{
  accessToken: string; binding: SePayProviderBinding; event: SePayWebhookEvent; from: Date; to: Date;
}>;
export interface SePayProviderPort {
  readonly environment: SePayEnvironment;
  readonly capabilities: SePayProviderCapabilities;
  authorizationUrl(input: Readonly<{ state: string; codeChallenge: string }>): string;
  exchange(input: Readonly<{ code: string; codeVerifier: string }>): Promise<SePayProviderGrant>;
  refresh(input: Readonly<{ refreshToken: string }>): Promise<SePayProviderGrant>;
  discoverAccounts(input: Readonly<{ accessToken: string }>): Promise<SePayAccountDiscovery>;
  readback(input: SePayReadbackInput): Promise<SePayReadbackResult>;
  revoke?(input: Readonly<{ accessToken: string; refreshToken: string }>): Promise<"revoked" | "unverified">;
}
export type SePayProviderErrorCode = "contract_unverified" | "invalid_request" | "unauthorized" | "forbidden" |
  "rate_limited" | "unavailable" | "invalid_response" | "grant_outcome_unknown";
/** Fixed categories only: provider bodies, URLs and token-bearing causes are never exposed. */
export class SePayProviderError extends Error {
  constructor(readonly code: SePayProviderErrorCode, readonly retryAfterSeconds: number | null = null) {
    super(code); this.name = "SePayProviderError";
  }
}

/** Only the local transport wrapper may assert that no provider request was sent. */
export class SePayProviderNotDispatchedError extends SePayProviderError {
  constructor(code: "rate_limited" | "unavailable", retryAfterSeconds: number) {
    super(code, retryAfterSeconds); this.name = "SePayProviderNotDispatchedError";
  }
}

/**
 * No runtime/env switch can assert the unresolved provider proofs. The separately
 * tested documented transport below is not an automation-ready provider adapter.
 * See docs/audits/2026-09-23-increment-5-oauth-plan-contract-gates.md.
 */
export function createSePayOAuthProvider(environment: SePayEnvironment): SePayProviderPort {
  if (environment !== "test" && environment !== "live") throw new SePayProviderError("invalid_request");
  const capabilities: SePayProviderCapabilities = Object.freeze({ oauthApplication: false, pkceS256: false,
    stableAccountIdentity: false, canonicalTransactionIdentity: false, bankTimeReference: false, remoteRevocation: false });
  const unavailable = (): never => { throw new SePayProviderError("contract_unverified"); };
  return Object.freeze({ environment, capabilities, authorizationUrl: unavailable,
    exchange: async () => unavailable(), refresh: async () => unavailable(),
    discoverAccounts: async () => ({ kind: "inconclusive" as const, reason: "contract_unverified" as const }),
    readback: async () => ({ kind: "inconclusive" as const, reason: "contract_unverified" as const }),
    revoke: async () => "unverified" as const });
}

// Pinned documented read/token surfaces. Not exported through the package barrel
// or wired into production until the provider's missing contracts are proved.
const PROVIDER_ORIGIN = "https://my.sepay.vn";
const PAGE_SIZE = 20;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 128 * 1_024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_WINDOW_MS = 48 * 3_600_000;
type FetchPort = (url: URL, init: RequestInit) => Promise<Response>;
export type SePayDocumentedTransaction = Omit<SePayProviderTransaction, "binding"> & Readonly<{
  accountId: string; accountNumber: string; bankGateway: string; subAccount: string | null;
}>;
export type SePayDocumentedResult<T> = Readonly<{ kind: "complete"; records: ReadonlyArray<T> }> |
  Readonly<{ kind: "inconclusive"; reason: SePayInconclusiveReason }>;

function requireSecret(value: unknown, maximum = 8_192): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\s\u0000-\u001f\u007f]/.test(value)) throw new SePayProviderError("invalid_request");
  return value;
}
function validDate(value: Date): boolean { return value instanceof Date && Number.isFinite(value.getTime()); }
function vietnamDate(value: Date): string { return new Date(value.getTime() + 7 * 3_600_000).toISOString().slice(0, 10); }
function retryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const seconds = /^\d{1,6}$/.test(value) ? Number(value) : (Date.parse(value) - now.getTime()) / 1_000;
  // Workers respect this pause; they must not retry sooner when the value exceeds
  // their attempt window. No sleep/network retry occurs inside this adapter.
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(86_400, Math.ceil(seconds)) : null;
}
function pagination(raw: Record<string, unknown>, expectedPage: number, rowCount: number) {
  if (raw.status !== "success") throw new SePayProviderError("invalid_response");
  const page = sepayRecord(sepayRecord(raw.meta).pagination);
  const total = normalizeSePayVnd(page.total, true);
  const current = normalizeSePayVnd(page.current_page);
  const perPage = normalizeSePayVnd(page.per_page);
  const last = normalizeSePayVnd(page.last_page);
  if (current !== expectedPage || perPage !== PAGE_SIZE || last !== Math.max(1, Math.ceil(total / perPage)) ||
    current > last || rowCount !== Math.min(perPage, Math.max(0, total - (current - 1) * perPage))) throw new SePayProviderError("invalid_response");
  return { total, last };
}

/**
 * Low-level implementation of the documented payloads, with no identity claims.
 * It deliberately cannot implement SePayProviderPort: discovery bindings remain
 * null and read results are unscoped observations until the missing contracts
 * have a separately reviewed implementation. Never accept fetch URLs from users.
 */
export function createSePayDocumentedTransport(input: Readonly<{
  clientId: string; clientSecret: string; redirectUri: string;
  fetch?: FetchPort; now?: () => Date;
}>) {
  const clientId = requireSecret(input.clientId, 256);
  const clientSecret = requireSecret(input.clientSecret);
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash || redirect.search) throw new SePayProviderError("invalid_request");
  const redirectUri = redirect.href;
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());

  async function request(path: "/oauth/token" | "/api/v1/bank-accounts" | "/api/v1/transactions", init: RequestInit, query?: URLSearchParams): Promise<unknown> {
    const url = new URL(path, PROVIDER_ORIGIN);
    if (query) url.search = query.toString();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response: Response | null = null;
    const tokenRequest = path === "/oauth/token";
    try {
      response = await fetcher(url, { ...init, redirect: "error", signal: abort.signal, cache: "no-store" });
      // Protect even test/injected fetch implementations that ignore redirect:error.
      if (response.redirected || (response.url && new URL(response.url).origin !== PROVIDER_ORIGIN)) throw new SePayProviderError("invalid_response");
      if (response.status === 401) throw new SePayProviderError("unauthorized");
      if (response.status === 403) throw new SePayProviderError("forbidden");
      if (response.status === 429) throw new SePayProviderError("rate_limited", retryAfter(response.headers.get("retry-after"), now()));
      if (!response.ok) throw new SePayProviderError(tokenRequest ? "grant_outcome_unknown" : "unavailable");
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(response.headers.get("content-type") ?? "")) throw new SePayProviderError("invalid_response");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) throw new SePayProviderError("invalid_response");
      const reader = response.body?.getReader();
      if (!reader) throw new SePayProviderError("invalid_response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_RESPONSE_BYTES) throw new SePayProviderError("invalid_response");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return parseSePayJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof SePayProviderError) {
        // A successful token response with malformed/truncated content may already
        // have rotated the grant. Its outcome must never invite an old-token retry.
        if (tokenRequest && error.code === "invalid_response") throw new SePayProviderError("grant_outcome_unknown");
        throw error;
      }
      throw new SePayProviderError(tokenRequest ? "grant_outcome_unknown" : response?.ok ? "invalid_response" : "unavailable");
    } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); }
  }

  async function token(fields: Record<string, string>): Promise<SePayProviderGrant> {
    const issuedAt = now();
    if (!validDate(issuedAt)) throw new SePayProviderError("invalid_request");
    const response = await request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }) });
    try {
      const raw = sepayRecord(response);
      if (raw.token_type !== "Bearer") throw new SePayProviderError("invalid_response");
      const accessToken = requireSecret(raw.access_token);
      const refreshToken = requireSecret(raw.refresh_token);
      const seconds = normalizeSePayVnd(raw.expires_in);
      if (seconds > 86_400) throw new SePayProviderError("invalid_response");
      // OAuth permits omitting unchanged scopes. If returned, accept exactly the
      // requested read scopes; no company/profile/webhook/write privilege upgrade.
      const scopes = raw.scope === undefined ? [...SEPAY_READ_SCOPES] : sepayText(raw.scope, 256).split(" ");
      if (scopes.length !== SEPAY_READ_SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some((scope) => !(SEPAY_READ_SCOPES as readonly string[]).includes(scope))) throw new SePayProviderError("invalid_response");
      return { accessToken, refreshToken, expiresAt: new Date(issuedAt.getTime() + seconds * 1_000), scopes };
    } catch { throw new SePayProviderError("grant_outcome_unknown"); }
  }

  async function list<T>(path: "/api/v1/bank-accounts" | "/api/v1/transactions", accessToken: string, filters: Record<string, string>, normalize: (row: unknown) => T): Promise<SePayDocumentedResult<T>> {
    requireSecret(accessToken);
    const records: T[] = [];
    const ids = new Set<string>();
    let previousTotal: number | null = null;
    const startedAt = Date.now();
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - startedAt >= 15_000) return { kind: "inconclusive", reason: "limit_exceeded" };
      const response = await request(path, { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, new URLSearchParams({ ...filters, page: String(page), limit: String(PAGE_SIZE) }));
      try {
        const raw = sepayRecord(response);
        if (!Array.isArray(raw.data) || raw.data.length > PAGE_SIZE) throw new SePayProviderError("invalid_response");
        const paging = pagination(raw, page, raw.data.length);
        if (paging.total > PAGE_SIZE * MAX_PAGES) return { kind: "inconclusive", reason: "limit_exceeded" };
        if (previousTotal !== null && previousTotal !== paging.total) return { kind: "inconclusive", reason: "pagination_changed" };
        previousTotal = paging.total;
        for (const row of raw.data) {
          const id = normalizeSePayId(sepayRecord(row).id);
          if (ids.has(id)) return { kind: "inconclusive", reason: "pagination_changed" };
          ids.add(id);
          records.push(normalize(row));
        }
        if (page === paging.last) return { kind: "complete", records };
      } catch { return { kind: "inconclusive", reason: "invalid_schema" }; }
    }
    return { kind: "inconclusive", reason: "limit_exceeded" };
  }

  return {
    /** Builds S256 parameters; this is not evidence that SePay enforces them. */
    authorizationUrl(command: { state: string; codeChallenge: string }): string {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(command.state) || !/^[A-Za-z0-9_-]{43}$/.test(command.codeChallenge)) throw new SePayProviderError("invalid_request");
      const url = new URL("/oauth/authorize", PROVIDER_ORIGIN);
      url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SEPAY_READ_SCOPES.join(" "), state: command.state,
        code_challenge: command.codeChallenge, code_challenge_method: "S256" }).toString();
      return url.href;
    },
    exchange(command: { code: string; codeVerifier: string }): Promise<SePayProviderGrant> {
      const code = requireSecret(command.code, 4_096);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(command.codeVerifier)) throw new SePayProviderError("invalid_request");
      return token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: command.codeVerifier });
    },
    refresh(command: { refreshToken: string }): Promise<SePayProviderGrant> {
      return token({ grant_type: "refresh_token", refresh_token: requireSecret(command.refreshToken) });
    },
    discoverAccounts(command: { accessToken: string }): Promise<SePayDocumentedResult<SePayProviderAccount>> {
      return list("/api/v1/bank-accounts", command.accessToken, {}, (row) => {
        const raw = sepayRecord(row), bank = sepayRecord(raw.bank);
        const bankBin = sepayText(bank.bin, 6);
        if (!/^[0-9]{6}$/.test(bankBin) || typeof raw.active !== "boolean") throw new SePayProviderError("invalid_response");
        return { accountId: normalizeSePayId(raw.id), bankBin, bankGateway: sepayText(bank.short_name, 80), accountNumber: sepayText(raw.account_number, 64), subAccount: null, active: raw.active, binding: null };
      });
    },
    readback(command: SePayReadbackInput): Promise<SePayDocumentedResult<SePayDocumentedTransaction>> {
      if (!validDate(command.from) || !validDate(command.to) || command.to < command.from || command.to.getTime() - command.from.getTime() > MAX_WINDOW_MS) throw new SePayProviderError("invalid_request");
      const accountId = normalizeSePayId(command.binding.accountId);
      const accountNumber = sepayText(command.binding.accountNumber, 64);
      const amountVnd = normalizeSePayVnd(command.event.amountVnd);
      const filters: Record<string, string> = { bank_account_id: accountId, account_number: accountNumber, from_date: vietnamDate(command.from), to_date: vietnamDate(command.to), amount_in: String(amountVnd), amount_out: "0" };
      if (command.event.bankReference) filters.reference_number = sepayText(command.event.bankReference, 128);
      return list("/api/v1/transactions", command.accessToken, filters, (row) => {
        const raw = sepayRecord(row);
        const incoming = normalizeSePayVnd(raw.amount_in, true), outgoing = normalizeSePayVnd(raw.amount_out, true);
        if ((incoming === 0) === (outgoing === 0)) throw new SePayProviderError("invalid_response");
        const reference = normalizeSePayReference(raw.code, raw.transaction_content);
        return { id: normalizeSePayId(raw.id), accountId: normalizeSePayId(raw.bank_account_id), accountNumber: sepayText(raw.account_number, 64), bankGateway: sepayText(raw.bank_brand_name, 80),
          subAccount: sepayNullableText(raw.sub_account, 64), amountVnd: incoming || outgoing, direction: incoming > 0 ? "in" : "out", occurredAt: parseSePayVietnamTime(raw.transaction_date),
          reference: reference.reference, referenceStatus: reference.referenceStatus, bankReference: sepayNullableText(raw.reference_number, 128) };
      });
    },
  };
}
