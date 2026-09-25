import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { createLookupHmac } from "@pawket/security";
import type { createSePayConnectionService } from "./sepay-connection-service.js";
import type { createSePayInboxService } from "./sepay-inbox-service.js";
import type { createSePayReconciliationService } from "./sepay-reconciliation-service.js";
import type { createSePayReviewService } from "./sepay-review-service.js";
import { SePayServiceError, sepayUuid, type SePayActor } from "./sepay-service-support.js";
import { SEPAY_WEBHOOK_MAX_BYTES, SePayWebhookError } from "./sepay-webhook.js";

const PRIVATE_HEADERS = { "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };
const json = (status: number, value: unknown) => Response.json(value, { status, headers: PRIVATE_HEADERS });
const invalid = (status = 400) => json(status, { code: "invalid_request" });
type Input = Readonly<{
  appBaseUrl: string; paymentsMode: "disabled" | "manual_only" | "sepay_optional"; ingressEnabled: boolean; lookupHmacKey: Uint8Array;
  authenticate(headers: Headers): Promise<SePayActor | null>;
  throttle(command: { actorUserId: string; networkKeyHash: string; operation: "read" | "write" | "callback" | "owner" }): Promise<boolean>;
  connections: Pick<ReturnType<typeof createSePayConnectionService>, "getSnapshot" | "start" | "callback" | "listAccounts" | "bindAccount" | "change">;
  reviews: Pick<ReturnType<typeof createSePayReviewService>, "list" | "decide" | "diagnostics">;
  reconciliation: Pick<ReturnType<typeof createSePayReconciliationService>, "confirmReviewed">;
  inbox: Pick<ReturnType<typeof createSePayInboxService>, "receive">;
  now?: () => number;
  onOperation?: (event: { operation: string; outcome: string }) => void;
}>;
function failure(error: unknown): Response {
  if (error instanceof SePayWebhookError) return json(error.code === "body_too_large" ? 413 : error.code === "unsupported_media" ? 415 : error.code === "invalid_authentication" ? 401 : 400, { code: error.code });
  if (!(error instanceof SePayServiceError)) return json(503, { code: "dependency_unavailable" });
  const status = error.code === "invalid_request" ? 400 : ["not_authorized", "not_available"].includes(error.code) ? 404 :
    ["recent_auth_required", "totp_required"].includes(error.code) ? 403 : error.code === "rate_limited" ? 429 : error.code === "evidence_mismatch" ? 422 :
    ["version_conflict", "idempotency_conflict", "open_manual_intents", "account_conflict", "intent_not_pending", "reconnect_required"].includes(error.code) ? 409 : 503;
  const response = json(status, { code: error.code === "not_authorized" ? "not_available" : error.code });
  if (error.retryAfterSeconds !== undefined) response.headers.set("retry-after", String(error.retryAfterSeconds));
  return response;
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
}
async function bytes(request: Request, maximum: number): Promise<Uint8Array | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) return invalid();
  if (declared !== null && Number(declared) > maximum) return invalid(413);
  if (!request.headers.get("content-type")?.match(/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu) ||
    (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity")) return invalid(415);
  if (!request.body) return invalid();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => undefined); return invalid(413); } chunks.push(part.value); }
    if (declared !== null && size !== Number(declared)) return invalid();
    const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
  } catch { return invalid(); } finally { reader.releaseLock(); }
}
async function body(request: Request): Promise<{ value: unknown } | Response> {
  const raw = await bytes(request, 4096); if (raw instanceof Response) return raw;
  try { return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown }; } catch { return invalid(); }
}
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const reason = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length >= 3 && value.length <= 500 && !/[\p{Cc}]/u.test(value);

export function createSePayHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const clock = input.now ?? Date.now;
  const ingressMetric = (outcome: string) => { try { input.onOperation?.({ operation: "ingress", outcome }); } catch { /* Receipt never depends on telemetry. */ } };
  // Fixed buckets bound unauthenticated rate-limit memory, including random UUID/IP floods.
  const buckets = Array.from({ length: 64 }, () => ({ window: -1, count: 0 })); let globalWindow = -1; let globalCount = 0;
  function ingressPermit(request: Request): boolean {
    const window = Math.floor(clock() / 60_000); if (globalWindow !== window) { globalWindow = window; globalCount = 0; }
    if (++globalCount > 1800) return false;
    const address = request.headers.get("x-real-ip") ?? "unknown";
    const index = createHash("sha256").update(address.length <= 64 ? address : "invalid").digest()[0]! % buckets.length;
    const bucket = buckets[index]!; if (bucket.window !== window) { bucket.window = window; bucket.count = 0; }
    return ++bucket.count <= 120;
  }
  function preflight(request: Request, method: "GET" | "POST", callback = false): Response | null {
    if (request.method !== method) return json(405, { code: "method_not_allowed" });
    if (method === "POST" && input.paymentsMode === "disabled") return json(503, { code: "payments_disabled" });
    if (!callback && (request.headers.get("sec-fetch-site") === "cross-site" || (method === "POST" && request.headers.get("origin") !== origin))) return json(403, { code: "untrusted_origin" });
    return null;
  }
  async function actor(request: Request, operation: "read" | "write" | "callback" | "owner"): Promise<SePayActor | Response> {
    const session = await input.authenticate(request.headers); if (!session) return json(401, { code: "authentication_required" });
    const address = request.headers.get("x-real-ip");
    if (!address || address.length > 64 || address.trim() !== address || address.includes("%") || !isIP(address)) return json(503, { code: "dependency_unavailable" });
    const networkKeyHash = createLookupHmac({ key: input.lookupHmacKey, context: "sepay-http-network", value: isIP(address) === 4 ? address : new URL(`http://[${address}]/`).hostname });
    if (!await input.throttle({ actorUserId: session.userId, networkKeyHash, operation })) return json(429, { code: "rate_limited" });
    return { userId: session.userId, sessionId: session.sessionId };
  }
  async function read(request: Request, run: (session: SePayActor) => Promise<unknown>, owner = false): Promise<Response> {
    const rejected = preflight(request, "GET"); if (rejected) return rejected;
    try { const session = await actor(request, owner ? "owner" : "read"); if (session instanceof Response) return session; const result = await run(session); return result instanceof Response ? result : json(200, result); } catch (error) { return failure(error); }
  }
  async function command(request: Request, run: (session: SePayActor, value: unknown, command: { idempotencyKey: string; requestId: string }) => Promise<unknown>): Promise<Response> {
    const rejected = preflight(request, "POST"); if (rejected) return rejected;
    try {
      const session = await actor(request, "write"); if (session instanceof Response) return session;
      if (new URL(request.url).search) return invalid();
      const idempotencyKey = request.headers.get("idempotency-key"); if (!idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(idempotencyKey)) return invalid();
      const payload = await body(request); if (payload instanceof Response) return payload;
      const value = await run(session, payload.value, { idempotencyKey, requestId: randomUUID() });
      return value instanceof Response ? value : json(200, value);
    } catch (error) { return failure(error); }
  }
  return {
    snapshot: (request: Request) => read(request, async (session) => new URL(request.url).search ? invalid() : { snapshot: await input.connections.getSnapshot(session) }),
    start: (request: Request) => command(request, async (session, value, meta) => !record(value, []) ? invalid() : input.connections.start({ actor: session, ...meta })),
    async callback(request: Request): Promise<Response> {
      let result = "failed";
      try {
        if (preflight(request, "GET", true)) throw new Error();
        const session = await actor(request, "callback"); if (session instanceof Response) throw new Error();
        const query = new URL(request.url).searchParams;
        if ([...query.keys()].some((key) => !["code", "state"].includes(key)) || query.getAll("code").length !== 1 || query.getAll("state").length !== 1) throw new Error();
        await input.connections.callback({ actor: session, state: query.get("state")!, code: query.get("code")!, requestId: randomUUID() }); result = "connected";
      } catch { /* The fixed destination never reflects OAuth codes, state or provider errors. */ }
      return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, location: new URL(`/creator/tips/sepay?oauth=${result}`, origin).href } });
    },
    accounts: (request: Request, connectionId: string) => read(request, async (session) => {
      if (!sepayUuid(connectionId) || new URL(request.url).search) throw new SePayServiceError("invalid_request");
      return input.connections.listAccounts({ actor: session, connectionId });
    }),
    bind: (request: Request, connectionId: string) => command(request, async (session, value, meta) => {
      if (!sepayUuid(connectionId) || !record(value, ["expectedVersion", "providerAccountId"]) || !version(value.expectedVersion) || typeof value.providerAccountId !== "string" || !/^[1-9][0-9]{0,29}$/u.test(value.providerAccountId)) return invalid();
      return input.connections.bindAccount({ actor: session, connectionId, expectedVersion: value.expectedVersion, providerAccountId: value.providerAccountId, ...meta });
    }),
    change: (request: Request, connectionId: string) => command(request, async (session, value, meta) => {
      if (!sepayUuid(connectionId) || !record(value, ["expectedVersion", "action"]) || !version(value.expectedVersion) || typeof value.action !== "string" || !["pause", "resume", "disconnect", "enable_automation", "rotate_secret"].includes(value.action)) return invalid();
      return input.connections.change({ actor: session, connectionId, expectedVersion: value.expectedVersion, action: value.action as "pause" | "resume" | "disconnect" | "enable_automation" | "rotate_secret", ...meta });
    }),
    reviews: (request: Request) => read(request, async (session) => {
      const query = new URL(request.url).searchParams; const status = query.get("status") ?? "review_required"; const cursor = query.get("cursor");
      if ([...query.keys()].some((key) => !["status", "cursor"].includes(key)) || query.getAll("status").length > 1 || query.getAll("cursor").length > 1 ||
        !["pending", "processing", "review_required", "confirmed", "dismissed"].includes(status) || (cursor !== null && (cursor.length < 1 || cursor.length > 400))) throw new SePayServiceError("invalid_request");
      return { queue: await input.reviews.list({ actor: session, status, ...(cursor === null ? {} : { cursor }) }) };
    }),
    decide: (request: Request, inboxId: string) => command(request, async (session, value, meta) => {
      if (!sepayUuid(inboxId) || !record(value, ["expectedVersion", "action", "reason"]) || !version(value.expectedVersion) || !reason(value.reason) || typeof value.action !== "string" || !["retry", "dismiss", "reopen"].includes(value.action)) return invalid();
      await input.reviews.decide({ actor: session, inboxId, expectedVersion: value.expectedVersion, action: value.action as "retry" | "dismiss" | "reopen", reason: value.reason, ...meta }); return { saved: true };
    }),
    confirm: (request: Request, inboxId: string) => command(request, async (session, value, meta) => {
      if (!sepayUuid(inboxId) || !record(value, ["expectedVersion", "attestedReceived", "reason"]) || !version(value.expectedVersion) || value.attestedReceived !== true || !reason(value.reason)) return invalid();
      return { outcome: await input.reconciliation.confirmReviewed({ actor: session, inboxId, expectedVersion: value.expectedVersion, attestedReceived: true, reason: value.reason, ...meta }) };
    }),
    diagnostics: (request: Request) => read(request, async (session) => {
      if (new URL(request.url).search) throw new SePayServiceError("invalid_request"); return { diagnostics: await input.reviews.diagnostics(session) };
    }, true),
    async webhook(request: Request, connectionId: string): Promise<Response> {
      if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
      if (!input.ingressEnabled) { ingressMetric("disabled"); return json(404, { code: "not_available" }); }
      if (!ingressPermit(request)) { ingressMetric("rate_limited"); return json(429, { code: "rate_limited" }); }
      if (!sepayUuid(connectionId) || new URL(request.url).search) return invalid();
      try {
        const rawBody = await bytes(request, SEPAY_WEBHOOK_MAX_BYTES); if (rawBody instanceof Response) { ingressMetric("failed"); return rawBody; }
        const outcome = await input.inbox.receive({ connectionId, rawBody, contentType: request.headers.get("content-type"), contentEncoding: request.headers.get("content-encoding"), timestamp: request.headers.get("x-sepay-timestamp"), signature: request.headers.get("x-sepay-signature") });
        ingressMetric(outcome);
        return json(200, { success: true });
      } catch (error) {
        ingressMetric(error instanceof SePayWebhookError && error.code === "invalid_authentication" ? "auth_failed" : error instanceof SePayServiceError && error.code === "rate_limited" ? "rate_limited" : "failed");
        return failure(error);
      }
    },
  };
}
