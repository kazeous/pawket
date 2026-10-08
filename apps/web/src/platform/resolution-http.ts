import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CommissionFileError } from "@pawket/commission-files";
import { CommissionError, commissionIdempotencyKey, type CommissionActor, type CommissionOrderService } from "@pawket/orders";
import { CommissionRefundError, TipPaymentError, type CommissionRefundService } from "@pawket/payments";
import { DISPUTE_REASONS, PROPOSAL_KINDS, RULING_OUTCOMES, ResolutionError, type createProposalService, type createDisputeService,
  type createResolutionViewService, type LateClaimService, type SuspensionService } from "@pawket/resolutions";
import { CommissionHttpFailure, commissionJson, commissionNetworkKey, readCommissionBody } from "./commission-http.js";

const uuid = z.uuid(); const version = z.number().int().min(1).max(2_147_483_646);
const amount = z.number().int().min(0).max(50_000_000);
const proposal = z.strictObject({ expectedVersion: version, kind: z.enum(PROPOSAL_KINDS), refundAmountVnd: amount, note: z.string().max(20_000) });
const proposalResponse = z.strictObject({ response: z.enum(["accept", "decline"]) });
const empty = z.strictObject({});
const dispute = z.strictObject({ expectedVersion: version, reason: z.enum(DISPUTE_REASONS), statement: z.string().max(20_000),
  requestedOutcome: z.strictObject({ kind: z.enum(RULING_OUTCOMES), refundAmountVnd: amount }), acknowledgeStaffReview: z.literal(true) });
const statement = z.strictObject({ text: z.string().max(20_000) });
const destination = z.strictObject({ expectedVersion: version, bankBin: z.string().max(128), accountNumber: z.string().max(128), accountHolder: z.string().max(2_000) });
const receipt = z.strictObject({ expectedVersion: version, received: z.boolean() });
const send = z.strictObject({ expectedVersion: version, transferDate: z.string().max(32), bankReference: z.string().max(128), note: z.string().max(20_000).optional(), fileIds: z.array(uuid).max(3).optional() });
const claim = z.strictObject({ transferAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)), amountVnd: amount.min(1),
  bankReference: z.string().max(128), note: z.string().max(20_000).optional(), fileIds: z.array(uuid).max(3).optional() });
const claimAnswer = z.strictObject({ received: z.boolean(), receivedAmountVnd: amount.min(1).optional() });
const cancel = z.strictObject({ expectedVersion: version });
type Role = "buyer" | "creator";
type Input = Readonly<{
  appBaseUrl: string; lookupHmacKey: Uint8Array; mode: "disabled" | "enabled";
  authenticate(headers: Headers): Promise<CommissionActor | null>;
  throttle(command: { actorUserId: string; networkKeyHash: string; operation: "read" | "command"; orderId?: string }): Promise<boolean>;
  proposals: Pick<ReturnType<typeof createProposalService>, "propose" | "respondToProposal" | "withdrawProposal">;
  disputes: Pick<ReturnType<typeof createDisputeService>, "openDispute" | "addStatement" | "withdrawDispute">;
  view: ReturnType<typeof createResolutionViewService>;
  refunds: Pick<CommissionRefundService, "enterDestination" | "confirmReceipt" | "revealDestination" | "recordSend">;
  lateClaims: Pick<LateClaimService, "fileLateClaim" | "answerLateClaim">; suspension: SuspensionService; orders: CommissionOrderService;
}>;
const invalid = (): never => { throw new CommissionHttpFailure(400, "invalid_request"); };
function noQuery(request: Request) { if (new URL(request.url).searchParams.size !== 0) invalid(); }
function failure(error: unknown): Response {
  if (error instanceof CommissionHttpFailure) return commissionJson(error.status, { code: error.code });
  if (error instanceof ResolutionError || error instanceof CommissionRefundError || error instanceof CommissionError || error instanceof CommissionFileError || error instanceof TipPaymentError) {
    const code = error.code;
    if (["not_authorized", "not_available"].includes(code)) return commissionJson(404, { code: "not_available" });
    if (["recent_auth_required", "totp_required"].includes(code)) return commissionJson(403, { code });
    if (code.startsWith("invalid_")) return commissionJson(400, { code });
    if (code === "rate_limited") return commissionJson(429, { code });
    if (["resolution_disabled", "dependency_unavailable", "intake_disabled", "payments_disabled", "files_disabled", "fulfillment_disabled"].includes(code)) return commissionJson(503, { code });
    return commissionJson(409, { code });
  }
  return commissionJson(503, { code: "dependency_unavailable" });
}
export function createResolutionHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  async function run(request: Request, method: "GET" | "POST", action: (actor: CommissionActor) => Promise<unknown>, orderId?: string): Promise<Response> {
    try {
      if (request.method !== method) throw new CommissionHttpFailure(405, "method_not_allowed");
      const requestOrigin = request.headers.get("origin");
      if (request.headers.get("sec-fetch-site") === "cross-site" || ((method === "POST" || requestOrigin !== null) && requestOrigin !== origin)) throw new CommissionHttpFailure(403, "untrusted_origin");
      const actor = await input.authenticate(request.headers); if (!actor) throw new CommissionHttpFailure(401, "authentication_required");
      const networkKeyHash = commissionNetworkKey(request, key);
      if (await input.throttle({ actorUserId: actor.userId, networkKeyHash, operation: method === "GET" ? "read" : "command", ...(orderId === undefined ? {} : { orderId }) }) !== true) throw new CommissionHttpFailure(429, "rate_limited");
      return commissionJson(200, await action({ userId: actor.userId, sessionId: actor.sessionId }));
    } catch (error) { return failure(error); }
  }
  async function roleOrder(actor: CommissionActor, orderId: string, role: Role) {
    const order = await input.orders.getOrder({ actor, orderId }); if (order.role !== role) throw new CommissionHttpFailure(404, "not_available");
  }
  async function command(request: Request, actor: CommissionActor, orderId: string, role: Role) {
    noQuery(request); const idempotencyKey = request.headers.get("idempotency-key"); if (!commissionIdempotencyKey(idempotencyKey)) invalid();
    await roleOrder(actor, orderId, role);
    if (input.mode !== "enabled") throw new CommissionHttpFailure(503, "resolution_disabled");
    return { actor, idempotencyKey: idempotencyKey!, requestId: randomUUID() };
  }
  async function target(actor: CommissionActor, orderId: string, kind: "proposal" | "dispute" | "refund" | "claim", id: string) {
    const view = await input.view.getOrderResolution({ actor, orderId });
    let found = kind === "proposal" ? view.proposals.pending?.id === id || view.proposals.history.some((row) => row.id === id)
      : kind === "dispute" ? view.dispute?.id === id : kind === "refund" ? view.refunds.some((row) => row.obligationId === id) : view.lateClaim?.id === id;
    // Earlier withdrawn disputes remain valid replay targets after a new dispute opens.
    if (!found && kind === "dispute") found = (await input.view.listMyCases({ actor })).disputes.some((row) => row.id === id && row.orderId === orderId);
    if (!found) throw new CommissionHttpFailure(404, "not_available");
  }
  return {
    resolution: (request: Request, orderId: string, role: Role) => run(request, "GET", async (actor) => {
      noQuery(request); await roleOrder(actor, orderId, role); return { resolution: await input.view.getOrderResolution({ actor, orderId }), controls: { mode: input.mode } };
    }, orderId),
    propose: (request: Request, orderId: string, role: Role) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, role); return input.proposals.propose({ ...base, orderId, ...await readCommissionBody(request, proposal) });
    }, orderId),
    respondProposal: (request: Request, orderId: string, proposalId: string, role: Role) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, role); const body = await readCommissionBody(request, proposalResponse); await target(actor, orderId, "proposal", proposalId);
      return input.proposals.respondToProposal({ ...base, proposalId, ...body });
    }, orderId),
    withdrawProposal: (request: Request, orderId: string, proposalId: string, role: Role) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, role); await readCommissionBody(request, empty); await target(actor, orderId, "proposal", proposalId);
      return input.proposals.withdrawProposal({ ...base, proposalId });
    }, orderId),
    openDispute: (request: Request, orderId: string, role: Role) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, role); return input.disputes.openDispute({ ...base, orderId, ...await readCommissionBody(request, dispute) });
    }, orderId),
    addStatement: (request: Request, orderId: string, disputeId: string, role: Role) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, role); const body = await readCommissionBody(request, statement); await target(actor, orderId, "dispute", disputeId);
      return input.disputes.addStatement({ ...base, disputeId, ...body });
    }, orderId),
    withdrawDispute: (request: Request, orderId: string, disputeId: string, role: Role) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, role); await readCommissionBody(request, empty); await target(actor, orderId, "dispute", disputeId);
      return input.disputes.withdrawDispute({ ...base, disputeId });
    }, orderId),
    enterRefundDestination: (request: Request, orderId: string, obligationId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "buyer"); const body = await readCommissionBody(request, destination); await target(actor, orderId, "refund", obligationId);
      return input.refunds.enterDestination({ ...base, obligationId, ...body });
    }, orderId),
    confirmRefundReceipt: (request: Request, orderId: string, obligationId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "buyer"); const body = await readCommissionBody(request, receipt); await target(actor, orderId, "refund", obligationId);
      return input.refunds.confirmReceipt({ ...base, obligationId, ...body });
    }, orderId),
    revealRefund: (request: Request, orderId: string, obligationId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "creator"); await readCommissionBody(request, empty); await target(actor, orderId, "refund", obligationId);
      // Reveals are audited on every view; the service deliberately has no replay key.
      return input.refunds.revealDestination({ actor: base.actor, obligationId, requestId: base.requestId });
    }, orderId),
    recordRefundSend: (request: Request, orderId: string, obligationId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "creator"); const body = await readCommissionBody(request, send); await target(actor, orderId, "refund", obligationId);
      return input.refunds.recordSend({ ...base, obligationId, ...body });
    }, orderId),
    fileLateClaim: (request: Request, orderId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "buyer"); return input.lateClaims.fileLateClaim({ ...base, orderId, ...await readCommissionBody(request, claim) });
    }, orderId),
    answerLateClaim: (request: Request, orderId: string, claimId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "creator"); const body = await readCommissionBody(request, claimAnswer); await target(actor, orderId, "claim", claimId);
      return input.lateClaims.answerLateClaim({ ...base, claimId, ...body });
    }, orderId),
    cancelAfterSuspension: (request: Request, orderId: string) => run(request, "POST", async (actor) => {
      const base = await command(request, actor, orderId, "buyer"); return input.suspension.cancelAfterSuspension({ ...base, orderId, ...await readCommissionBody(request, cancel) });
    }, orderId),
    myCases: (request: Request) => run(request, "GET", async (actor) => { noQuery(request); return { cases: await input.view.listMyCases({ actor }) }; }),
  };
}
