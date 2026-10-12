import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CommissionFileError } from "@pawket/commission-files";
import { CommissionError, commissionIdentifier, commissionIdempotencyKey, type CommissionActor } from "@pawket/orders";
import { CommissionRefundError, type CommissionRefundPort } from "@pawket/payments";
import { ResolutionError, RULING_OUTCOMES, type OwnerResolutionService, type LateClaimService, type SuspensionService } from "@pawket/resolutions";
import { TrustCaseError, TrustEnforcementError, TRUST_PENALTY_KINDS, TRUST_PENALTY_REASONS, TRUST_PENALTY_TARGETS, TRUST_RESTRICTIONS, TRUST_POLICY_KINDS, type createTrustPolicyService, type TrustEnforcementMode, type PenaltyService, type ContentHideService, type TrustCaseKind, type TrustCaseService, type AppealService } from "@pawket/trust";
import { CommissionHttpFailure, commissionJson, readCommissionBody } from "./commission-http.js";

const uuid = z.uuid(); const amount = z.number().int().min(0).max(50_000_000); const text = z.string().max(20_000);
const date = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const evidence = z.strictObject({ section: z.enum(["order_summary", "thread_page", "resolution_records", "refund_destination", "report_context", "package_revision", "brief", "appeal_source"]), cursor: z.number().int().min(1).max(2_147_483_647).optional() })
  .refine((value) => value.cursor === undefined || value.section === "thread_page");
const file = z.strictObject({ disposition: z.enum(["attachment", "inline"]) });
const penaltyFields = { subjectUserId: z.string().min(1).max(200), kind: z.enum(TRUST_PENALTY_KINDS), restriction: z.enum(TRUST_RESTRICTIONS).optional(), target: z.enum(TRUST_PENALTY_TARGETS).optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(), reasonCategory: z.enum(TRUST_PENALTY_REASONS), explanation: text, internalNote: text.optional(), freezeFulfilment: z.boolean().optional() };
const actionBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("decide_appeal"), expectedCaseVersion: z.number().int().min(1).max(2_147_483_646), decision: z.enum(["upheld", "reduced", "reversed"]), reasoning: text,
    replacement: z.strictObject({ kind: z.enum(["restriction", "suspension"]), restriction: z.enum(TRUST_RESTRICTIONS).optional(), target: z.enum(TRUST_PENALTY_TARGETS).optional(), endsAt: z.iso.datetime({ offset: true }).nullable() }).optional() }),
  z.strictObject({ action: z.literal("penalty"), ...penaltyFields }),
  z.strictObject({ action: z.literal("hide"), reason: text, expectedCaseVersion: z.number().int().min(1).max(2_147_483_646) }),
  z.strictObject({ action: z.literal("restore"), hideId: uuid, reason: text, expectedCaseVersion: z.number().int().min(1).max(2_147_483_646) }),
  z.strictObject({ action: z.literal("close_report"), resolution: z.enum(["dismissed", "actioned"]), reason: text, expectedCaseVersion: z.number().int().min(1).max(2_147_483_646) }),
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
  enforcementMode?: TrustEnforcementMode;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  authenticate(headers: Headers): Promise<CommissionActor | null>;
  issueOwnerStepUpProof(command: CommissionActor & { actionClass: string; now: Date }): Promise<{ id: string }>;
  cases: TrustCaseService; owner: OwnerResolutionService; lateClaims: LateClaimService; suspension: SuspensionService;
  contentHides?: Pick<ContentHideService, "hide" | "restore" | "closeReportCase">;
  penalties?: Pick<PenaltyService, "apply" | "lift" | "listActive">;
  appeals?: Pick<AppealService, "decide">;
  policies?: Pick<ReturnType<typeof createTrustPolicyService>, "publish" | "readCurrent">;
  trustMetadata?: Readonly<{ readForCase(caseId: string): Promise<unknown>; publicReportParties(reportId: string): Promise<unknown> }>;
  // Runtime binds the database; the adapter never reads private domain tables.
  refunds: Readonly<{ readAging(command: Parameters<Aging>[1]): ReturnType<Aging> }>;
  standing: Readonly<{ readForOrder(orderId: string): Promise<"active" | "suspended" | "none"> }>;
  orderMetadata: Readonly<{ readForOrder(orderId: string): Promise<Readonly<{ creatorUserId: string; buyerUserId: string; orderState: string; amountVnd: number | null }>> }>;
  resolutionMetadata: Readonly<{ readForCase(row: Readonly<{ caseId: string; kind: string; state: string; sourceId: string; orderId: string }>): Promise<Readonly<{
    disputeOpenedAt: string | null; respondBy: string | null;
    ruling: Readonly<{ id: string; outcome: string; refundAmountVnd: number; currentRefundAmountVnd: number; correctedAt: string | null; ruledAt: string; correctionEndsAt: string | null }> | null;
  }>> }>;
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
  if (error instanceof TrustCaseError || error instanceof TrustEnforcementError || error instanceof ResolutionError || error instanceof CommissionRefundError || error instanceof CommissionError || error instanceof CommissionFileError) {
    const code = error.code;
    if (code === "not_authorized") return commissionJson(403, { code: "owner_required" });
    if (code === "not_available") return commissionJson(404, { code });
    if (code === "owner_step_up_required") return commissionJson(403, { code });
    if (code.startsWith("invalid_")) return commissionJson(400, { code });
    if (["enforcement_disabled", "resolution_disabled", "dependency_unavailable", "files_disabled", "fulfillment_disabled", "storage_unavailable"].includes(code)) return commissionJson(503, { code });
    return commissionJson(409, { code });
  }
  return commissionJson(503, { code: "dependency_unavailable" });
}
export function createCaseHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin;
  const enabled = input.enforcementMode === "enabled";
  function enforcement() { if (!enabled) throw new TrustEnforcementError("enforcement_disabled"); }
  function checkKind(kind: string) { if (kind === "report" || kind === "appeal") enforcement(); }
  async function checkEvidence(caseId: string, section?: string) {
    if (enabled) return;
    if (section && ["report_context", "package_revision", "brief", "appeal_source"].includes(section)) enforcement();
    checkKind((await input.cases.getCase(caseId)).kind);
  }
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
      if (values.kind !== undefined && !["dispute", "refund_not_received", "refund_overdue", "late_payment", "report", "appeal"].includes(values.kind)) invalid();
      if (values.kind) checkKind(values.kind);
      if ((values.beforeOpenedAt === undefined) !== (values.beforeId === undefined)) invalid();
      const filter = { ...(values.state === undefined ? {} : { state: values.state as "open" | "resolved" }),
        ...(values.kind === undefined ? {} : { kind: values.kind as TrustCaseKind }), ...(size === undefined ? {} : { limit: size }),
        ...(values.beforeId === undefined ? {} : { before: { openedAt: values.beforeOpenedAt!, id: id(values.beforeId) } }) };
      let batch = await input.cases.listQueue(filter);
      if (enabled || values.kind) return { cases: batch };
      // Fill a legacy page across hidden trust rows so pagination never drops older Stage A cases.
      const rows = batch.filter((row) => row.kind !== "report" && row.kind !== "appeal"); const maximum = size ?? 50;
      while (rows.length < maximum && batch.length === maximum) {
        const last = batch.at(-1)!; batch = await input.cases.listQueue({ ...filter, before: { openedAt: last.openedAt, id: last.caseId } });
        rows.push(...batch.filter((row) => row.kind !== "report" && row.kind !== "appeal"));
      }
      return { cases: rows.slice(0, maximum) };
    }),
    detail: (request: Request, caseId: string) => run(request, "GET", async () => {
      noQuery(request); const detail = await input.cases.getCase(id(caseId));
      checkKind(detail.kind);
      const metadata = enabled && input.trustMetadata ? await input.trustMetadata.readForCase(caseId) : {};
      if (detail.orderId === null) {
        if (detail.kind !== "report" && detail.kind !== "appeal") throw new TrustCaseError("not_available");
        return { case: { ...detail, ...metadata as object } };
      }
      const [order, resolution, creatorStanding] = await Promise.all([input.orderMetadata.readForOrder(detail.orderId),
        input.resolutionMetadata.readForCase({ ...detail, orderId: detail.orderId }), input.standing.readForOrder(detail.orderId)]);
      return { case: { ...detail, ...order, ...resolution, creatorStanding, ...metadata as object } };
    }),
    evidence: (request: Request, caseId: string) => run(request, "POST", async (owner) => {
      noQuery(request); id(caseId); const body = await readCommissionBody(request, evidence);
      await checkEvidence(caseId, body.section);
      const stepUpProofId = await proof(owner, "owner.case_evidence");
      return { evidence: await input.cases.readEvidence({ owner, stepUpProofId, caseId, ...body, requestId: randomUUID() }) };
    }),
    file: (request: Request, caseId: string, fileId: string) => run(request, "POST", async (owner) => {
      noQuery(request); id(caseId); id(fileId); const body = await readCommissionBody(request, file);
      await checkEvidence(caseId);
      const stepUpProofId = await proof(owner, "owner.case_file");
      return input.cases.fileGrant({ owner, stepUpProofId, caseId, fileId, ...body, requestId: randomUUID() });
    }),
    action: (request: Request, caseId: string) => run(request, "POST", async (owner) => {
      noQuery(request); id(caseId); const idempotencyKey = key(request); const body = await readCommissionBody(request, actionBody);
      const detail = await input.cases.getCase(caseId); const { action } = body;
      checkKind(detail.kind);
      if (["hide", "restore", "close_report", "penalty", "decide_appeal"].includes(action)) enforcement();
      if (body.action === "decide_appeal") {
        if (detail.kind !== "appeal" || !input.appeals) throw new TrustCaseError("not_available");
        await input.appeals.decide({ owner, caseId, expectedCaseVersion: body.expectedCaseVersion, decision: body.decision, reasoning: body.reasoning,
          ...(body.replacement === undefined ? {} : { replacement: body.replacement }), idempotencyKey,
          stepUpProofId: await proof(owner, "owner.trust_appeal_decide"), requestId: randomUUID() }); return {};
      }
      if (body.action === "penalty") {
        if (!input.penalties) throw new TrustCaseError("not_available");
        return input.penalties.apply({ subjectUserId: body.subjectUserId, kind: body.kind, reasonCategory: body.reasonCategory, explanation: body.explanation,
          restriction: body.restriction, target: body.target, endsAt: body.endsAt, internalNote: body.internalNote, freezeFulfilment: body.freezeFulfilment,
          source: { caseId }, owner, idempotencyKey, stepUpProofId: await proof(owner, "owner.trust_penalty_apply"), requestId: randomUUID() });
      }
      if (body.action === "hide" || body.action === "restore" || body.action === "close_report") {
        if (detail.kind !== "report" || !input.contentHides) throw new TrustCaseError("not_available");
        const actionClass = body.action === "close_report" ? "owner.trust_report_close" : `owner.trust_${body.action}`;
        const base = { owner, caseId, expectedCaseVersion: body.expectedCaseVersion, idempotencyKey, stepUpProofId: await proof(owner, actionClass), requestId: randomUUID() };
        if (body.action === "hide") return input.contentHides.hide({ ...base, reason: body.reason });
        if (body.action === "restore") { await input.contentHides.restore({ ...base, hideId: body.hideId, reason: body.reason }); return {}; }
        await input.contentHides.closeReportCase({ ...base, resolution: body.resolution, reason: body.reason }); return {};
      }
      if (detail.orderId === null) throw new TrustCaseError("not_available");
      if (["rule", "correct", "question", "extend"].includes(action) && detail.kind !== "dispute"
        || action === "rule_claim" && detail.kind !== "late_payment"
        || ["accept_evidence", "require_resend", "waive", "extend_deadline"].includes(action) && !["refund_not_received", "refund_overdue"].includes(detail.kind)) throw new CommissionHttpFailure(404, "not_available");
      const ruling = body.action === "correct" ? (await input.resolutionMetadata.readForCase({ ...detail, orderId: detail.orderId })).ruling : null;
      if (body.action === "correct" && (!ruling || ruling.id !== body.rulingId)) throw new CommissionHttpFailure(404, "not_available");
      const base = { owner, idempotencyKey, stepUpProofId: await proof(owner, `owner.case_${action}`), requestId: randomUUID() };
      // Target IDs for dispute/claim commands come from the case, never the client.
      if (body.action === "rule") return input.owner.rule({ ...base, disputeId: detail.sourceId, outcome: body.outcome, refundAmountVnd: body.refundAmountVnd, reasoning: body.reasoning,
        ...(body.internalNote === undefined ? {} : { internalNote: body.internalNote }) });
      if (body.action === "correct") return input.owner.correctRuling({ ...base, rulingId: ruling!.id, newRefundAmountVnd: body.newRefundAmountVnd, reason: body.reason });
      if (body.action === "question") return input.owner.postQuestion({ ...base, disputeId: detail.sourceId, text: body.text });
      if (body.action === "extend") return input.owner.extendDispute({ ...base, disputeId: detail.sourceId, until: body.until, reason: body.reason });
      if (body.action === "rule_claim") return input.owner.ruleLateClaim({ ...base, claimId: detail.sourceId, outcome: body.outcome, reason: body.reason,
        ...(body.amountVnd === undefined ? {} : { amountVnd: body.amountVnd }) });
      return input.owner.resolveRefundCase({ ...base, caseId, ...body });
    }),
    penalties: (request: Request) => run(request, "GET", async () => {
      enforcement();
      if (!input.penalties) throw new TrustCaseError("not_available");
      const values = query(request, ["subjectUserId", "kind", "limit"]);
      if (values.subjectUserId !== undefined && !commissionIdentifier(values.subjectUserId) || values.kind !== undefined && !(TRUST_PENALTY_KINDS as readonly string[]).includes(values.kind)) invalid();
      return { penalties: await input.penalties.listActive({ ...(values.subjectUserId === undefined ? {} : { subjectUserId: values.subjectUserId }),
        ...(values.kind === undefined ? {} : { kind: values.kind as typeof TRUST_PENALTY_KINDS[number] }), ...(values.limit === undefined ? {} : { limit: limit(values.limit) }) }) };
    }),
    liftPenalty: (request: Request, penaltyId: string) => run(request, "POST", async (owner) => {
      enforcement();
      noQuery(request); id(penaltyId); if (!input.penalties) throw new TrustCaseError("not_available");
      const idempotencyKey = key(request); const body = await readCommissionBody(request, z.strictObject({ reason: text }));
      await input.penalties.lift({ ...body, penaltyId, owner, idempotencyKey, stepUpProofId: await proof(owner, "owner.trust_penalty_lift"), requestId: randomUUID() }); return {};
    }),
    publicReportParties: (request: Request, reportId: string) => run(request, "GET", async () => {
      enforcement(); noQuery(request); id(reportId); if (!input.trustMetadata) throw new TrustCaseError("not_available");
      return input.trustMetadata.publicReportParties(reportId);
    }),
    publicReportPenalty: (request: Request, reportId: string) => run(request, "POST", async (owner) => {
      enforcement(); noQuery(request); id(reportId); if (!input.penalties) throw new TrustCaseError("not_available");
      const idempotencyKey = key(request); const body = await readCommissionBody(request, z.strictObject(penaltyFields));
      return input.penalties.apply({ ...body, source: { publicReportId: reportId }, owner, idempotencyKey,
        stepUpProofId: await proof(owner, "owner.trust_penalty_apply"), requestId: randomUUID() });
    }),
    policies: (request: Request) => run(request, "GET", async () => {
      noQuery(request); if (!input.policies) throw new TrustCaseError("not_available");
      return { policies: await Promise.all(TRUST_POLICY_KINDS.map(async (kind) => ({ kind, current: await input.policies!.readCurrent(kind) }))) };
    }),
    publishPolicy: (request: Request) => run(request, "POST", async (owner) => {
      enforcement(); noQuery(request); if (!input.policies) throw new TrustCaseError("not_available");
      const idempotencyKey = key(request); const body = await readCommissionBody(request, z.strictObject({ kind: z.enum(TRUST_POLICY_KINDS), expectedRevisionNumber: z.number().int().min(0).max(2_147_483_646), document: z.string().max(32_000) }));
      return input.policies.publish({ ...body, owner, idempotencyKey, stepUpProofId: await proof(owner, "owner.trust_policy_publish"), requestId: randomUUID() });
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
