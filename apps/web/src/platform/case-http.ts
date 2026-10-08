import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CommissionFileError } from "@pawket/commission-files";
import { CommissionError, commissionIdentifier, commissionIdempotencyKey, type CommissionActor } from "@pawket/orders";
import { CommissionRefundError, type CommissionRefundPort } from "@pawket/payments";
import { ResolutionError, RULING_OUTCOMES, type OwnerResolutionService, type LateClaimService, type SuspensionService } from "@pawket/resolutions";
import { TrustCaseError, type TrustCaseKind, type TrustCaseService } from "@pawket/trust";
import { CommissionHttpFailure, commissionJson, readCommissionBody } from "./commission-http.js";

const uuid = z.uuid(); const amount = z.number().int().min(0).max(50_000_000); const text = z.string().max(20_000);
const date = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const evidence = z.strictObject({ section: z.enum(["order_summary", "thread_page", "resolution_records", "refund_destination"]), cursor: z.number().int().min(1).max(2_147_483_647).optional() })
  .refine((value) => value.cursor === undefined || value.section === "thread_page");
const file = z.strictObject({ disposition: z.enum(["attachment", "inline"]) });
const actionBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("rule"), outcome: z.enum(RULING_OUTCOMES), refundAmountVnd: amount, reasoning: text, internalNote: text.optional() }),
  z.strictObject({ action: z.literal("correct"), rulingId: uuid, newRefundAmountVnd: amount, reason: text }),
  z.strictObject({ action: z.literal("question"), text }),
  z.strictObject({ action: z.literal("extend"), until: date, reason: text }),
  z.strictObject({ action: z.literal("accept_evidence"), reason: text }),
  z.strictObject({ action: z.literal("require_resend"), reason: text }),
  z.strictObject({ action: z.literal("waive"), reason: text }),
  z.strictObject({ action: z.literal("extend_deadline"), until: date, reason: text }),
  z.strictObject({ action: z.literal("rule_claim"), outcome: z.enum(["refund_owed", "rejected"]), amountVnd: amount.min(1).optional(), reason: text }),
]);
const freezeBody = z.strictObject({ reason: text });
type Aging = CommissionRefundPort["readAging"];
type Input = Readonly<{
  appBaseUrl: string;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  authenticate(headers: Headers): Promise<CommissionActor | null>;
  issueOwnerStepUpProof(command: CommissionActor & { actionClass: string; now: Date }): Promise<{ id: string }>;
  cases: TrustCaseService; owner: OwnerResolutionService; lateClaims: LateClaimService; suspension: SuspensionService;
  // Runtime binds the database; the adapter never reads private domain tables.
  refunds: Readonly<{ readAging(command: Parameters<Aging>[1]): ReturnType<Aging> }>;
  standing: Readonly<{ readForOrder(orderId: string): Promise<"active" | "suspended" | "none"> }>;
}>;
const invalid = (): never => { throw new CommissionHttpFailure(400, "invalid_request"); };
function noQuery(request: Request) { if (new URL(request.url).searchParams.size !== 0) invalid(); }
function id(value: string) { if (!uuid.safeParse(value).success) invalid(); return value; }
function key(request: Request) { const value = request.headers.get("idempotency-key"); if (!commissionIdempotencyKey(value)) invalid(); return value!; }
function query(request: Request, allowed: readonly string[]) {
  const values: Record<string, string> = {};
  for (const [name, value] of new URL(request.url).searchParams) { if (!allowed.includes(name) || name in values) invalid(); values[name] = value; }
  return values;
}
function limit(value?: string) { if (value === undefined) return undefined; if (!/^[1-9][0-9]*$/u.test(value)) invalid(); const result = Number(value); if (result > 100) invalid(); return result; }
function failure(error: unknown): Response {
  if (error instanceof CommissionHttpFailure) return commissionJson(error.status, { code: error.code });
  if (error instanceof TrustCaseError || error instanceof ResolutionError || error instanceof CommissionRefundError || error instanceof CommissionError || error instanceof CommissionFileError) {
    const code = error.code;
    if (code === "not_authorized") return commissionJson(403, { code: "owner_required" });
    if (code === "not_available") return commissionJson(404, { code });
    if (code === "owner_step_up_required") return commissionJson(403, { code });
    if (code.startsWith("invalid_")) return commissionJson(400, { code });
    if (["resolution_disabled", "dependency_unavailable", "files_disabled", "fulfillment_disabled", "storage_unavailable"].includes(code)) return commissionJson(503, { code });
    return commissionJson(409, { code });
  }
  return commissionJson(503, { code: "dependency_unavailable" });
}
export function createCaseHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin;
  async function run(request: Request, method: "GET" | "POST", action: (owner: CommissionActor) => Promise<unknown>) {
    try {
      const permission = await input.authorizeOwner(request.headers);
      if (permission !== "authorized") throw new CommissionHttpFailure(permission === "unauthenticated" ? 401 : 403, permission === "unauthenticated" ? "authentication_required" : "owner_required");
      const actor = await input.authenticate(request.headers); if (!actor) throw new CommissionHttpFailure(401, "authentication_required");
      if (request.method !== method) throw new CommissionHttpFailure(405, "method_not_allowed");
      const requestOrigin = request.headers.get("origin");
      if (request.headers.get("sec-fetch-site") === "cross-site" || ((method === "POST" || requestOrigin !== null) && requestOrigin !== origin)) throw new CommissionHttpFailure(403, "untrusted_origin");
      return commissionJson(200, await action({ userId: actor.userId, sessionId: actor.sessionId }));
    } catch (error) { return failure(error); }
  }
  async function proof(owner: CommissionActor, actionClass: string) {
    try { return (await input.issueOwnerStepUpProof({ ...owner, actionClass, now: new Date() })).id; }
    catch { throw new CommissionHttpFailure(403, "owner_step_up_required"); }
  }
  return {
    queue: (request: Request) => run(request, "GET", async () => {
      const values = query(request, ["state", "kind", "beforeOpenedAt", "beforeId", "limit"]); const size = limit(values.limit);
      if (values.state !== undefined && !["open", "resolved"].includes(values.state)) invalid();
      if (values.kind !== undefined && !["dispute", "refund_not_received", "refund_overdue", "late_payment"].includes(values.kind)) invalid();
      if ((values.beforeOpenedAt === undefined) !== (values.beforeId === undefined)) invalid();
      return { cases: await input.cases.listQueue({ ...(values.state === undefined ? {} : { state: values.state as "open" | "resolved" }),
        ...(values.kind === undefined ? {} : { kind: values.kind as TrustCaseKind }), ...(size === undefined ? {} : { limit: size }),
        ...(values.beforeId === undefined ? {} : { before: { openedAt: values.beforeOpenedAt!, id: id(values.beforeId) } }) }) };
    }),
    detail: (request: Request, caseId: string) => run(request, "GET", async () => {
      noQuery(request); const detail = await input.cases.getCase(id(caseId));
      return { case: { ...detail, creatorStanding: await input.standing.readForOrder(detail.orderId) } };
    }),
    evidence: (request: Request, caseId: string) => run(request, "POST", async (owner) => {
      noQuery(request); id(caseId); const body = await readCommissionBody(request, evidence);
      const stepUpProofId = await proof(owner, "owner.case_evidence");
      return { evidence: await input.cases.readEvidence({ owner, stepUpProofId, caseId, ...body, requestId: randomUUID() }) };
    }),
    file: (request: Request, caseId: string, fileId: string) => run(request, "POST", async (owner) => {
      noQuery(request); id(caseId); id(fileId); const body = await readCommissionBody(request, file);
      const stepUpProofId = await proof(owner, "owner.case_file");
      return input.cases.fileGrant({ owner, stepUpProofId, caseId, fileId, ...body, requestId: randomUUID() });
    }),
    action: (request: Request, caseId: string) => run(request, "POST", async (owner) => {
      noQuery(request); id(caseId); const idempotencyKey = key(request); const body = await readCommissionBody(request, actionBody);
      const detail = await input.cases.getCase(caseId); const { action } = body;
      if (["rule", "correct", "question", "extend"].includes(action) && detail.kind !== "dispute"
        || action === "rule_claim" && detail.kind !== "late_payment"
        || ["accept_evidence", "require_resend", "waive", "extend_deadline"].includes(action) && !["refund_not_received", "refund_overdue"].includes(detail.kind)) throw new CommissionHttpFailure(404, "not_available");
      const base = { owner, idempotencyKey, stepUpProofId: await proof(owner, `owner.case_${action}`), requestId: randomUUID() };
      // Target IDs for dispute/claim commands come from the case, never the client.
      if (body.action === "rule") return input.owner.rule({ ...base, disputeId: detail.sourceId, outcome: body.outcome, refundAmountVnd: body.refundAmountVnd, reasoning: body.reasoning,
        ...(body.internalNote === undefined ? {} : { internalNote: body.internalNote }) });
      if (body.action === "correct") return input.owner.correctRuling({ ...base, rulingId: body.rulingId, newRefundAmountVnd: body.newRefundAmountVnd, reason: body.reason });
      if (body.action === "question") return input.owner.postQuestion({ ...base, disputeId: detail.sourceId, text: body.text });
      if (body.action === "extend") return input.owner.extendDispute({ ...base, disputeId: detail.sourceId, until: body.until, reason: body.reason });
      if (body.action === "rule_claim") return input.owner.ruleLateClaim({ ...base, claimId: detail.sourceId, outcome: body.outcome, reason: body.reason,
        ...(body.amountVnd === undefined ? {} : { amountVnd: body.amountVnd }) });
      return input.owner.resolveRefundCase({ ...base, caseId, ...body });
    }),
    freeze: (request: Request, creatorUserId: string) => run(request, "POST", async (owner) => {
      noQuery(request); if (!commissionIdentifier(creatorUserId)) invalid(); const idempotencyKey = key(request); const body = await readCommissionBody(request, freezeBody);
      return input.owner.freezeFulfillment({ owner, creatorUserId, ...body, idempotencyKey, stepUpProofId: await proof(owner, "owner.commission_fulfillment_freeze"), requestId: randomUUID() });
    }),
    agingRefunds: (request: Request) => run(request, "GET", async () => {
      const values = query(request, ["limit"]); const at = new Date();
      const rows = await input.refunds.readAging({ at, limit: limit(values.limit) ?? 50 });
      return { refunds: rows.map((row) => ({ orderId: row.orderId, amountVnd: row.amountVnd, ageDays: Math.floor((at.getTime() - row.createdAt.getTime()) / 86_400_000) })) };
    }),
  };
}
