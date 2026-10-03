import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { createCommissionPackageService } from "@pawket/catalog";
import { CommissionError, commissionIdempotencyKey, type CommissionActor, type CommissionOrderService } from "@pawket/orders";
import { TipPaymentError, type createCreatorCommissionPaymentService } from "@pawket/payments";
import { createLookupHmac } from "@pawket/security";

export const COMMISSION_PRIVATE_HEADERS = { "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };
export const commissionJson = (status: number, value: unknown) => Response.json(value, { status, headers: COMMISSION_PRIVATE_HEADERS });
const uuid = z.uuid(); const version = z.number().int().min(1).max(2_147_483_646);
const newRequest = z.strictObject({ packageId: uuid, revisionId: uuid, policyRevisionId: uuid, acceptTerms: z.boolean(), brief: z.unknown(), referenceFileIds: z.array(uuid).max(10).optional() });
const accept = z.strictObject({ expectedVersion: version, quoteRevisionId: uuid.nullable(), policyRevisionId: uuid, acceptTerms: z.literal(true) });
const quote = z.strictObject({ expectedVersion: version, terms: z.unknown(), ttlMs: z.number().int() });
const existing = z.strictObject({ expectedVersion: version });
const draft = z.strictObject({ pageId: uuid, packageId: uuid.nullable(), expectedVersion: z.number().int().min(0).max(2_147_483_646), draft: z.unknown() });
const change = z.strictObject({ packageId: uuid, expectedVersion: version, action: z.enum(["publish", "pause", "archive"]), policyRevisionId: uuid });
const settings = z.strictObject({ expectedVersion: z.number().int().min(0).max(2_147_483_646), enabled: z.boolean(), capacityLimit: z.number().int().min(1).max(20) });
const confirmation = z.strictObject({ observedAmountVnd: z.number().int(), observedTransferReference: z.string().max(128), observedBankTransactionId: z.string().max(128), attestedReceived: z.literal(true) });
export class CommissionHttpFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const invalid = (): never => { throw new CommissionHttpFailure(400, "invalid_request"); };
function failure(error: unknown): Response {
  if (error instanceof CommissionHttpFailure) return commissionJson(error.status, { code: error.code });
  if (error instanceof CommissionError || error instanceof TipPaymentError) {
    const code = error.code;
    if (["not_authorized", "not_available"].includes(code)) return commissionJson(404, { code: "not_available" });
    if (["recent_auth_required", "totp_required"].includes(code)) return commissionJson(403, { code });
    if (["invalid_request", "invalid_terms", "invalid_brief", "invalid_amount", "invalid_reference_files"].includes(code)) return commissionJson(400, { code });
    if (code === "rate_limited") return commissionJson(429, { code });
    if (["intake_disabled", "payments_disabled", "dependency_unavailable", "files_disabled"].includes(code)) return commissionJson(503, { code });
    return commissionJson(409, { code });
  }
  return commissionJson(503, { code: "dependency_unavailable" });
}
function query(request: Request, keys: readonly string[]) {
  const params = new URL(request.url).searchParams;
  for (const name of params.keys()) if (!keys.includes(name) || params.getAll(name).length !== 1) invalid();
  return params;
}
function integerQuery(value: string | null, maximum: number): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) invalid();
  return Number(value);
}
export async function readCommissionBody<T>(request: Request, shape: z.ZodType<T>): Promise<T> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) throw new CommissionHttpFailure(415, "invalid_request");
  if (request.headers.has("content-encoding") || !request.body) invalid();
  const declared = request.headers.get("content-length"); const maxBytes = 65_536;
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) invalid();
  if (declared !== null && Number(declared) > maxBytes) throw new CommissionHttpFailure(413, "invalid_request");
  const reader = request.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw new CommissionHttpFailure(413, "invalid_request"); } chunks.push(chunk.value); }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { invalid(); }
    const result = shape.safeParse(parsed); if (!result.success) return invalid(); return result.data;
  } finally { reader.releaseLock(); }
}
export function commissionNetworkKey(request: Request, key: Uint8Array): string {
  const address = request.headers.get("x-real-ip");
  if (!address || address.length > 64 || address.trim() !== address || address.includes("%") || !isIP(address)) throw new CommissionHttpFailure(503, "dependency_unavailable");
  let normalized = isIP(address) === 4 ? address : new URL(`http://[${address}]/`).hostname;
  const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/u.exec(normalized);
  if (mapped) { const a = parseInt(mapped[1]!, 16); const b = parseInt(mapped[2]!, 16); normalized = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return createLookupHmac({ key, context: "commission-network", value: normalized });
}
type Operation = "read" | "request" | "command" | "confirm";
type Input = {
  appBaseUrl: string; lookupHmacKey: Uint8Array;
  intakeMode: "disabled" | "enabled"; paymentsMode: "disabled" | "manual_only" | "sepay_optional";
  authenticate(headers: Headers): Promise<CommissionActor | null>;
  throttle(command: { actorUserId: string | null; networkKeyHash: string; operation: Operation }): Promise<boolean>;
  orders: CommissionOrderService; catalog: ReturnType<typeof createCommissionPackageService>;
  manual: ReturnType<typeof createCreatorCommissionPaymentService>;
  onOperation?: (event: { operation: string; outcome: string }) => void;
};
export function createCommissionHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  const metric = (operation: Operation, outcome: string) => {
    if (operation !== "read") { try { input.onOperation?.({ operation, outcome }); } catch { /* Telemetry cannot change command results. */ } }
  };
  async function run(request: Request, method: "GET" | "POST", operation: Operation, action: (actor: CommissionActor | null, network: string) => Promise<unknown>, publicRead = false): Promise<Response> {
    try {
      if (request.method !== method) throw new CommissionHttpFailure(405, "method_not_allowed");
      if (request.headers.get("sec-fetch-site") === "cross-site" || (method === "POST" && request.headers.get("origin") !== origin)) throw new CommissionHttpFailure(403, "untrusted_origin");
      const actor = publicRead ? null : await input.authenticate(request.headers);
      if (!publicRead && !actor) throw new CommissionHttpFailure(401, "authentication_required");
      const network = commissionNetworkKey(request, key);
      if (await input.throttle({ actorUserId: actor?.userId ?? null, networkKeyHash: network, operation }) !== true) throw new CommissionHttpFailure(429, "rate_limited");
      const result = await action(actor ? { userId: actor.userId, sessionId: actor.sessionId } : null, network);
      if (operation !== "confirm") metric(operation, "accepted");
      return commissionJson(200, result);
    } catch (error) {
      const code = error instanceof CommissionError || error instanceof TipPaymentError || error instanceof CommissionHttpFailure ? error.code : "dependency_unavailable";
      const outcome = code === "dependency_unavailable" ? "failed" : operation === "confirm"
        ? ["bank_transaction_conflict", "idempotency_conflict", "evidence_mismatch"].includes(code) ? "conflict" : "rejected"
        : code === "capacity_full" && operation === "request" ? "capacity_full" : code === "version_conflict" && operation === "command" ? "version_conflict"
        : code === "rate_limited" ? "rate_limited" : ["intake_disabled", "payments_disabled"].includes(code) ? "disabled" : "rejected";
      metric(operation, outcome); return failure(error);
    }
  }
  function command(request: Request, actor: CommissionActor) {
    query(request, []); const idempotencyKey = request.headers.get("idempotency-key"); if (!commissionIdempotencyKey(idempotencyKey)) invalid();
    return { actor, idempotencyKey: idempotencyKey!, requestId: randomUUID() };
  }
  async function roleOrder(actor: CommissionActor, orderId: string, role: "buyer" | "creator") {
    const result = await input.orders.getOrder({ actor, orderId });
    if (result.role !== role) throw new CommissionHttpFailure(404, "not_available"); return result;
  }
  return {
    publicPackages: (request: Request, handle: string) => run(request, "GET", "read", async () => { query(request, []); return { packages: await input.catalog.listPublic(handle) }; }, true),
    workspace: (request: Request) => run(request, "GET", "read", async (actor) => { query(request, []); return { workspace: await input.catalog.getWorkspace(actor!), controls: { intakeMode: input.intakeMode, paymentsMode: input.paymentsMode } }; }),
    savePackage: (request: Request) => run(request, "POST", "command", async (actor) => ({ packageId: await input.catalog.saveDraft({ ...command(request, actor!), ...await readCommissionBody(request, draft) }) })),
    changePackage: (request: Request) => run(request, "POST", "command", async (actor) => ({ packageId: await input.catalog.changePackage({ ...command(request, actor!), ...await readCommissionBody(request, change) }) })),
    saveSettings: (request: Request) => run(request, "POST", "command", async (actor) => { await input.catalog.saveSettings({ ...command(request, actor!), ...await readCommissionBody(request, settings) }); return { saved: true }; }),
    list: (request: Request, role: "buyer" | "creator") => run(request, "GET", "read", async (actor) => {
      const p = query(request, ["beforeAt", "beforeId", "limit"]); const beforeAt = p.get("beforeAt"); const beforeId = p.get("beforeId");
      if ((beforeAt === null) !== (beforeId === null)) invalid();
      return { orders: await input.orders.listOrders({ actor: actor!, role, limit: integerQuery(p.get("limit"), 50), ...(beforeId !== null ? { before: { id: beforeId, createdAt: beforeAt! } } : {}) }) };
    }),
    detail: (request: Request, orderId: string, role: "buyer" | "creator") => run(request, "GET", "read", async (actor) => {
      query(request, []); return { order: await roleOrder(actor!, orderId, role), controls: { intakeMode: input.intakeMode, paymentsMode: input.paymentsMode } };
    }),
    history: (request: Request, orderId: string, role: "buyer" | "creator", kind: "quotes" | "timeline") => run(request, "GET", "read", async (actor) => {
      const p = query(request, ["before", "limit"]); await roleOrder(actor!, orderId, role);
      const before = integerQuery(p.get("before"), 2_147_483_647); const limit = integerQuery(p.get("limit"), kind === "quotes" ? 25 : 50);
      return { history: kind === "quotes" ? await input.orders.listQuoteHistory({ actor: actor!, orderId, beforeRevision: before, limit })
        : await input.orders.listTimeline({ actor: actor!, orderId, beforeVersion: before, limit }) };
    }),
    request: (request: Request) => run(request, "POST", "request", async (actor, network) => ({ orderId: await input.orders.request({ ...command(request, actor!), ...await readCommissionBody(request, newRequest), abuseKeyHash: network }) })),
    mutate: (request: Request, orderId: string, role: "buyer" | "creator", action: "accept" | "quote" | "close" | "claim") => run(request, "POST", "command", async (actor, network) => {
      const base = { ...command(request, actor!), orderId }; await roleOrder(actor!, orderId, role);
      if (action === "quote") return { orderId: await input.orders.quote({ ...base, ...await readCommissionBody(request, quote) }) };
      if (action === "accept") return { orderId: await input.orders.accept({ ...base, ...await readCommissionBody(request, accept), abuseKeyHash: network }) };
      const payload = { ...base, ...await readCommissionBody(request, existing) };
      return { orderId: action === "close" ? await input.orders.close(payload) : await input.orders.claimTransfer(payload) };
    }),
    confirm: (request: Request, orderId: string) => run(request, "POST", "confirm", async (actor) => {
      const base = command(request, actor!); const order = await roleOrder(actor!, orderId, "creator");
      if (!order.payment) throw new CommissionHttpFailure(404, "not_available");
      return { payment: await input.manual.confirm({ ...base, paymentIntentId: order.payment.id, ...await readCommissionBody(request, confirmation) }) };
    }),
  };
}
