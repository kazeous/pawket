import { randomBytes, randomUUID } from "node:crypto";
import { TipPaymentError, type AuthorizedTipReceipt, type TipAccess, type TipTransferClaim } from "@pawket/payments";
import { createLookupHmac } from "@pawket/security";
import type { createTipService } from "./create-tip.js";
import { readTipBody, tipBodyRecord, tipCookie, tipCookieHeader, tipJson, tipNetworkKey, tipReceiptCookieName, tipReference, TIP_GUEST_CONTEXT_COOKIE } from "./http-boundary.js";

type Input = Readonly<{
  appBaseUrl: string; paymentsMode: "disabled" | "manual_only"; publishingMode: "disabled" | "general_audience";
  lookupHmacKey: Uint8Array; guestContextTtlMs: number; rateWindowMs: number; createIpLimit: number; createCreatorLimit: number; receiptLimit: number;
  authenticate(headers: Headers): Promise<Readonly<{ userId: string }> | null>;
  resolveCreatorRateSubject(handle: string): Promise<string | null>;
  throttle(input: { action: "tip_context" | "tip_create_ip" | "tip_create_creator" | "tip_receipt" | "tip_claim_ip"; subjectHmac: string; maximumAttempts: number; windowMs: number }): Promise<{ allowed: boolean }>;
  creation: Pick<ReturnType<typeof createTipService>, "createTip">;
  receipts: { readReceipt(command: { reference: string; access: TipAccess }): Promise<AuthorizedTipReceipt>; reportTransfer(command: { reference: string; access: TipAccess; requestId: string }): Promise<TipTransferClaim> };
  now?: () => Date;
}>;
const validHandle = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length >= 3 && v.length <= 30 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v);
const idem = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9._-]{8,200}$/u.test(v);
const invalid = (status = 400) => tipJson(status, { code: "invalid_request" });
function failure(error: unknown) {
  if (!(error instanceof TipPaymentError)) return tipJson(503, { code: "dependency_unavailable" });
  switch (error.code) {
    case "payments_disabled": return tipJson(503, { code: error.code });
    case "rate_limited": return tipJson(429, { code: error.code });
    case "invalid_amount": case "invalid_guest_content": case "invalid_request": return tipJson(400, { code: error.code });
    case "idempotency_conflict": case "intent_not_pending": return tipJson(409, { code: error.code });
    case "not_available": case "not_authorized": return tipJson(404, { code: "not_available" });
    default: return tipJson(503, { code: "dependency_unavailable" });
  }
}
export function createTipHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date());
  if (!Number.isSafeInteger(input.guestContextTtlMs) || input.guestContextTtlMs < 3_600_000 || input.guestContextTtlMs > 2_592_000_000 ||
    !Number.isSafeInteger(input.rateWindowMs) || input.rateWindowMs < 60_000 || input.rateWindowMs > 86_400_000 ||
    !Number.isInteger(input.createIpLimit) || input.createIpLimit < 1 || input.createIpLimit > 100 ||
    !Number.isInteger(input.createCreatorLimit) || input.createCreatorLimit < 1 || input.createCreatorLimit > 1000 ||
    !Number.isInteger(input.receiptLimit) || input.receiptLimit < 1 || input.receiptLimit > 1000) throw new TipPaymentError("invalid_request");
  function preflight(request: Request, method: "GET" | "POST", creating = false) {
    if (request.method !== method) return tipJson(405, { code: "method_not_allowed" });
    if ((method !== "GET" && input.paymentsMode !== "manual_only") || (creating && input.publishingMode !== "general_audience")) return tipJson(503, { code: "payments_disabled" });
    if (request.headers.get("sec-fetch-site") === "cross-site" || (method === "POST" && request.headers.get("origin") !== origin)) return tipJson(403, { code: "untrusted_origin" });
    if (new URL(request.url).search) return invalid();
    return null;
  }
  async function throttle(request: Request, action: Parameters<Input["throttle"]>[0]["action"], maximumAttempts: number) {
    const subjectHmac = tipNetworkKey(request.headers, key);
    if (!subjectHmac) throw new TipPaymentError("dependency_unavailable");
    if ((await input.throttle({ action, subjectHmac, maximumAttempts, windowMs: input.rateWindowMs })).allowed !== true) throw new TipPaymentError("rate_limited");
    return subjectHmac;
  }
  async function access(request: Request, reference: string): Promise<TipAccess> {
    const buyer = await input.authenticate(request.headers);
    const capability = tipCookie(request.headers, tipReceiptCookieName(reference));
    // A valid receipt cookie continues to authorize its guest receipt after
    // sign-in. It never grants access to an account-owned intent.
    if (capability) return { kind: "guest", capability };
    if (buyer) return { kind: "buyer", userId: buyer.userId };
    throw new TipPaymentError("not_authorized");
  }
  return {
    async guestContext(request: Request): Promise<Response> {
      const rejected = preflight(request, "POST", true); if (rejected) return rejected;
      try {
        await throttle(request, "tip_context", input.receiptLimit);
        const body = await readTipBody(request); if ("status" in body) return invalid(body.status);
        if (!tipBodyRecord(body.value, [])) return invalid();
        const at = clock();
        const existing = tipCookie(request.headers, TIP_GUEST_CONTEXT_COOKIE);
        const response = tipJson(200, { ready: true });
        // Keep an existing context; overwriting it would break a lost-response retry.
        if (!existing) response.headers.append("set-cookie", tipCookieHeader(TIP_GUEST_CONTEXT_COOKIE, randomBytes(32).toString("base64url"), "/", new Date(at.getTime() + input.guestContextTtlMs)));
        return response;
      } catch (error) { return failure(error); }
    },
    async create(request: Request, canonicalHandle: string): Promise<Response> {
      const rejected = preflight(request, "POST", true); if (rejected) return rejected;
      try {
        const abuseKeyHash = await throttle(request, "tip_create_ip", input.createIpLimit);
        if (!validHandle(canonicalHandle)) throw new TipPaymentError("not_available");
        const idempotencyKey = request.headers.get("idempotency-key"); if (!idem(idempotencyKey)) return invalid();
        const body = await readTipBody(request); if ("status" in body) return invalid(body.status);
        const payload = tipBodyRecord(body.value, ["amountVnd"], ["name", "message"]); if (!payload) return invalid();
        const buyer = await input.authenticate(request.headers);
        const context = tipCookie(request.headers, TIP_GUEST_CONTEXT_COOKIE);
        if (!buyer && !context) return tipJson(409, { code: "guest_context_required" });
        const creator = await input.resolveCreatorRateSubject(canonicalHandle); if (!creator) throw new TipPaymentError("not_available");
        const allowed = await input.throttle({ action: "tip_create_creator", subjectHmac: createLookupHmac({ key, context: "tip-creator-rate", value: creator }), maximumAttempts: input.createCreatorLimit, windowMs: input.rateWindowMs });
        if (allowed.allowed !== true) throw new TipPaymentError("rate_limited");
        const result = await input.creation.createTip({ principal: buyer ? { kind: "buyer", userId: buyer.userId } : { kind: "guest", context: context! }, canonicalHandle,
          amountVnd: payload.amountVnd, name: payload.name, message: payload.message, abuseKeyHash, idempotencyKey, requestId: randomUUID() });
        const response = tipJson(201, { instruction: result.instruction });
        if (result.guestCapability) {
          const reference = result.instruction.reference; if (!tipReference(reference)) throw new TipPaymentError("dependency_unavailable");
          for (const path of [`/api/v1/tips/${reference}`, `/tips/${reference}`]) response.headers.append("set-cookie", tipCookieHeader(tipReceiptCookieName(reference), result.guestCapability.secret, path, result.guestCapability.expiresAt));
        }
        return response;
      } catch (error) { return failure(error); }
    },
    async receipt(request: Request, reference: string): Promise<Response> {
      const rejected = preflight(request, "GET"); if (rejected) return rejected;
      try {
        await throttle(request, "tip_receipt", input.receiptLimit);
        if (!tipReference(reference)) throw new TipPaymentError("not_authorized");
        const result = await input.receipts.readReceipt({ reference, access: await access(request, reference) });
        return tipJson(200, { receipt: result.receipt, instruction: input.paymentsMode === "manual_only" ? result.instruction : null, paymentsEnabled: input.paymentsMode === "manual_only" });
      } catch (error) { return failure(error); }
    },
    async claim(request: Request, reference: string): Promise<Response> {
      const rejected = preflight(request, "POST"); if (rejected) return rejected;
      try {
        await throttle(request, "tip_claim_ip", input.createIpLimit);
        if (!tipReference(reference)) throw new TipPaymentError("not_authorized");
        const body = await readTipBody(request); if ("status" in body) return invalid(body.status);
        if (!tipBodyRecord(body.value, [])) return invalid();
        const result = await input.receipts.reportTransfer({ reference, access: await access(request, reference), requestId: randomUUID() });
        return tipJson(200, { claim: { claimedAt: result.claimedAt.toISOString(), authoritative: false }, paymentConfirmed: false });
      } catch (error) { return failure(error); }
    },
  };
}
