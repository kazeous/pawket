import { isTipPaymentsEnabled, type TipPaymentsMode } from "@pawket/config/increment-four";
import { randomUUID } from "node:crypto";
import { TipPaymentError, type ConfirmCreatorTipCommand, type CreatorTipProjection, type CreatorTipQueue, type PaymentIntentState } from "@pawket/payments";
import { readTipBody, tipBodyRecord, tipJson, tipNetworkKey } from "./http-boundary.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Input = Readonly<{
  appBaseUrl: string; paymentsMode: TipPaymentsMode; lookupHmacKey: Uint8Array;
  authenticate(headers: Headers): Promise<Actor | null>;
  throttle(command: { actorUserId: string; networkKeyHash: string; operation: "queue" | "confirm" }): Promise<boolean>;
  service: { listQueue(command: { actor: Actor; state?: PaymentIntentState; cursor?: string }): Promise<CreatorTipQueue>;
    confirm(command: ConfirmCreatorTipCommand): Promise<CreatorTipProjection> };
}>;
const invalid = (status = 400) => tipJson(status, { code: "invalid_request" });
function failure(error: unknown): Response {
  if (!(error instanceof TipPaymentError)) return tipJson(503, { code: "dependency_unavailable" });
  switch (error.code) {
    case "payments_disabled": return tipJson(503, { code: error.code });
    case "not_authorized": case "not_available": return tipJson(404, { code: "not_available" });
    case "recent_auth_required": case "totp_required": return tipJson(403, { code: error.code });
    case "invalid_request": case "invalid_amount": return tipJson(400, { code: error.code });
    case "evidence_mismatch": return tipJson(422, { code: error.code });
    case "idempotency_conflict": case "bank_transaction_conflict": case "intent_not_pending": return tipJson(409, { code: error.code });
    case "rate_limited": return tipJson(429, { code: error.code });
    default: return tipJson(503, { code: "dependency_unavailable" });
  }
}
export function createCreatorTipHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  function preflight(request: Request, method: "GET" | "POST") {
    if (request.method !== method) return tipJson(405, { code: "method_not_allowed" });
    if (method !== "GET" && !isTipPaymentsEnabled(input.paymentsMode)) return tipJson(503, { code: "payments_disabled" });
    if (request.headers.get("sec-fetch-site") === "cross-site" || (method === "POST" && request.headers.get("origin") !== origin)) return tipJson(403, { code: "untrusted_origin" });
    return null;
  }
  async function actor(request: Request, operation: "queue" | "confirm"): Promise<Actor | Response> {
    const session = await input.authenticate(request.headers);
    if (!session) return tipJson(401, { code: "authentication_required" });
    const networkKeyHash = tipNetworkKey(request.headers, key);
    if (!networkKeyHash) throw new TipPaymentError("dependency_unavailable");
    if (await input.throttle({ actorUserId: session.userId, networkKeyHash, operation }) !== true) throw new TipPaymentError("rate_limited");
    return Object.freeze({ userId: session.userId, sessionId: session.sessionId });
  }
  return {
    async queue(request: Request): Promise<Response> {
      const rejected = preflight(request, "GET"); if (rejected) return rejected;
      try {
        const session = await actor(request, "queue"); if (session instanceof Response) return session;
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some((name) => name !== "state" && name !== "cursor") || params.getAll("state").length > 1 || params.getAll("cursor").length > 1) return invalid();
        const state = params.get("state") ?? "awaiting_transfer";
        if (!["awaiting_transfer", "confirmed", "expired", "rejected"].includes(state)) return invalid();
        const cursor = params.get("cursor"); if (cursor !== null && (cursor.length < 1 || cursor.length > 400)) return invalid();
        return tipJson(200, { queue: await input.service.listQueue({ actor: session, state: state as PaymentIntentState, ...(cursor === null ? {} : { cursor }) }) });
      } catch (error) { return failure(error); }
    },
    async confirm(request: Request, paymentIntentId: string): Promise<Response> {
      const rejected = preflight(request, "POST"); if (rejected) return rejected;
      try {
        const session = await actor(request, "confirm"); if (session instanceof Response) return session;
        if (new URL(request.url).search || typeof paymentIntentId !== "string" || paymentIntentId.trim() !== paymentIntentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(paymentIntentId)) return invalid();
        const idempotencyKey = request.headers.get("idempotency-key");
        if (!idempotencyKey || idempotencyKey.trim() !== idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(idempotencyKey)) return invalid();
        const body = await readTipBody(request); if ("status" in body) return invalid(body.status);
        const payload = tipBodyRecord(body.value, ["observedAmountVnd", "observedTransferReference", "observedBankTransactionId", "attestedReceived"]);
        if (!payload || payload.attestedReceived !== true) return invalid();
        return tipJson(200, { tip: await input.service.confirm({ actor: session, paymentIntentId, observedAmountVnd: payload.observedAmountVnd,
          observedTransferReference: payload.observedTransferReference, observedBankTransactionId: payload.observedBankTransactionId,
          attestedReceived: true, idempotencyKey, requestId: randomUUID() }) });
      } catch (error) { return failure(error); }
    },
  };
}
