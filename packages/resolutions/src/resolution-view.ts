import { asc, desc, eq } from "drizzle-orm";
import { commissionDisputes, commissionDisputeStatements, commissionProposals, commissionRulings, commissionRulingCorrections, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { commissionIdentifier, commissionTime, commissionUuid, readCommissionRecord, type CommissionOrderService } from "@pawket/orders";
import { decryptSensitiveField, type EncryptionEnvelope, type EncryptionKeyring } from "@pawket/security";
import { ResolutionError, RESOLUTION_ERRORS, resolutionFail, type ResolutionActor, type ResolutionErrorCode } from "./contracts.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { evaluateDisputeTrigger } from "./dispute-service.js";
import { RESOLUTION_POLICY } from "./policy.js";
import type { LateClaimService, LateClaimView } from "./late-claim-service.js";
import { isProposalStale } from "./proposal-service.js";
import type { ResolutionOrderPort, ResolutionRefundView, ResolutionSessionPort, ResolutionStandingPort } from "./ports.js";

type RefundView = Omit<ResolutionRefundView, "dueAt" | "confirmBy" | "endedAt" | "destinationPurgedAt" | "createdAt"> & Readonly<{
  dueAt: string | null; confirmBy: string | null; endedAt: string | null; destinationPurgedAt: string | null; createdAt: string;
  sends: readonly Readonly<{ id: string; transferDate: string; recordedAt: string; bankReference: string; note: string | null }>[];
}>;
/** Structural Pick of Payments' listForViewer; no dependency on its tables or package. */
type Refunds = Readonly<{ listForViewer(command: Readonly<{ actor: ResolutionActor; orderId: string }>): Promise<readonly RefundView[]> }>;
type Orders = Pick<ResolutionOrderPort, "lockOrder" | "completionDueAt"> & Pick<CommissionOrderService, "listOrders">;
type Input = Readonly<{ db: PawketDatabase; keyring: EncryptionKeyring; orders: Orders; refunds: Refunds; session: ResolutionSessionPort;
  now?(): Date; standing?: ResolutionStandingPort; lateClaims?: Pick<LateClaimService, "readForOrder"> }>;

export function createResolutionViewService(input: Input) {
  const clock = input.now ?? (() => new Date());
  const now = () => { const at = clock(); commissionTime(at); return new Date(at); };
  function actorValid(actor: ResolutionActor) {
    if (!readCommissionRecord(actor, ["userId", "sessionId"]) || !commissionIdentifier(actor.userId) || !commissionIdentifier(actor.sessionId)) resolutionFail("not_authorized");
  }
  async function session(tx: PawketTransaction, actor: ResolutionActor): Promise<Date> {
    const at = now(); const proof = await input.session.getTipSessionAssurance(tx, actor, at);
    if (!proof || !(proof.sessionExpiresAt instanceof Date) || !Number.isFinite(proof.sessionExpiresAt.getTime()) || proof.sessionExpiresAt <= at) resolutionFail("not_authorized");
    return proof.sessionExpiresAt;
  }
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof ResolutionError) throw error;
      if (error instanceof Error && ["CommissionError", "CommissionRefundError"].includes(error.name) && "code" in error
        && (RESOLUTION_ERRORS as readonly unknown[]).includes(error.code)) resolutionFail(error.code as ResolutionErrorCode);
      return resolutionFail("dependency_unavailable");
    }
  }
  function decrypt<R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, envelope: EncryptionEnvelope<R, F>): string {
    try {
      const value: unknown = JSON.parse(decryptSensitiveField({ keyring: input.keyring, envelope, binding: { recordType, recordId, fieldName } }));
      if (typeof value !== "string") resolutionFail("dependency_unavailable"); return value;
    } catch { return resolutionFail("dependency_unavailable"); }
  }
  async function readRefunds(actor: ResolutionActor, orderId: string): Promise<readonly RefundView[]> {
    try { return await input.refunds.listForViewer({ actor, orderId }); } catch (error) {
      // Payments has no empty-order projection: an authorized order with no obligations is not_available.
      if (error instanceof Error && error.name === "CommissionRefundError" && "code" in error && error.code === "not_available") return [];
      throw error;
    }
  }
  const effective = async (tx: PawketTransaction, value: string | null) => value === null ? null
    : (await effectiveResolutionDeadline(tx, new Date(value)))?.toISOString() ?? null;
  async function getOrderResolution(command: Readonly<{ actor: ResolutionActor; orderId: string }>) {
    if (!readCommissionRecord(command, ["actor", "orderId"]) || !commissionUuid(command.orderId)) resolutionFail("invalid_request"); actorValid(command.actor);
    return boundary(async () => {
      const projection = await input.db.transaction(async (tx) => {
        const order = await input.orders.lockOrder(tx, command.orderId);
        if (!order || (order.buyerUserId !== command.actor.userId && order.creatorUserId !== command.actor.userId)) resolutionFail("not_available");
        const expiry = await session(tx, command.actor);
        const role = order.buyerUserId === command.actor.userId ? "buyer" as const : "creator" as const;
        const proposals = await tx.select().from(commissionProposals).where(eq(commissionProposals.orderId, order.id))
          .orderBy(desc(commissionProposals.createdAt), desc(commissionProposals.id));
        const projected = [];
        for (const row of proposals) projected.push({ id: row.id, proposerRole: row.proposerRole, kind: row.kind, refundAmountVnd: row.refundAmountVnd,
          note: decrypt("commission_proposals", row.id, "note", row.noteEnvelope), state: row.state, stale: isProposalStale(row, order),
          respondBy: (await effectiveResolutionDeadline(tx, row.respondBy))?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(), endedAt: row.endedAt?.toISOString() ?? null });
        const pending = projected.find((row) => row.state === "pending") ?? null;
        const [dispute] = await tx.select().from(commissionDisputes).where(eq(commissionDisputes.orderId, order.id))
          .orderBy(desc(commissionDisputes.openedAt), desc(commissionDisputes.id)).limit(1);
        let disputeView = null;
        if (dispute) {
          const statements = await tx.select().from(commissionDisputeStatements).where(eq(commissionDisputeStatements.disputeId, dispute.id))
            .orderBy(asc(commissionDisputeStatements.createdAt), asc(commissionDisputeStatements.id));
          const [ruling] = await tx.select().from(commissionRulings).where(eq(commissionRulings.disputeId, dispute.id)).limit(1);
          disputeView = { id: dispute.id, state: dispute.state, reason: dispute.reason, trigger: dispute.trigger,
            respondBy: (await effectiveResolutionDeadline(tx, dispute.respondBy))?.toISOString() ?? null,
            statements: statements.map((row) => ({ authorRole: row.authorRole, kind: row.kind,
              text: decrypt("commission_dispute_statements", row.id, "text", row.textEnvelope), createdAt: row.createdAt.toISOString() })),
            ruling: ruling ? { outcome: ruling.outcome, refundAmountVnd: ruling.refundAmountVnd,
              reasoning: decrypt("commission_rulings", ruling.id, "reasoning", ruling.reasoningEnvelope), ruledAt: ruling.ruledAt.toISOString() } : null };
        }
        const at = now(); const trigger = dispute?.state === "open" ? null : await evaluateDisputeTrigger(tx, input.orders, order, command.actor, at);
        const live = order.state === "in_progress" || order.state === "delivered";
        const due = order.state === "delivered" ? await input.orders.completionDueAt(tx, order.id) : null;
        const resolutionEnabled = await effectiveResolutionDeadline(tx, at) !== null;
        const canCancelAfterSuspension = resolutionEnabled && live && role === "buyer" && input.standing !== undefined
          && await input.standing.readCreatorStanding(tx, order.creatorUserId) === "suspended";
        const lateClaim = await input.lateClaims?.readForOrder(tx, order.id) ?? null;
        if (expiry <= now()) resolutionFail("not_authorized");
        return { role, proposals: { pending, history: projected.filter((row) => row.state !== "pending") }, dispute: disputeView, lateClaim,
          actions: { canPropose: resolutionEnabled && live && !pending && proposals.filter((row) => row.proposerUserId === command.actor.userId).length < RESOLUTION_POLICY.maxProposalsPerParty
              && (order.state !== "delivered" || (due !== null && at < due)),
            canOpenDispute: resolutionEnabled && trigger !== null, disputeTrigger: trigger?.kind ?? null, disputeTriggerEndsAt: trigger?.endsAt?.toISOString() ?? null,
            canCancelAfterSuspension } };
      });
      // Payments owns its read transaction and creator fence; do not call it while holding that fence here.
      const refunds = await readRefunds(command.actor, command.orderId);
      return input.db.transaction(async (tx) => {
        const expiry = await session(tx, command.actor); const adjusted = [];
        for (const row of refunds) adjusted.push({ ...row, dueAt: await effective(tx, row.dueAt), confirmBy: await effective(tx, row.confirmBy) });
        if (expiry <= now()) resolutionFail("not_authorized");
        return { ...projection, refunds: adjusted };
      });
    });
  }
  return {
    /** Internal evidence projection: Trust must authorize an open case and log this transaction. */
    async readForCase(tx: PawketTransaction, orderId: string) {
      if (!commissionUuid(orderId)) resolutionFail("invalid_request");
      const proposals = await tx.select().from(commissionProposals).where(eq(commissionProposals.orderId, orderId)).orderBy(asc(commissionProposals.createdAt), asc(commissionProposals.id));
      const disputes = await tx.select().from(commissionDisputes).where(eq(commissionDisputes.orderId, orderId)).orderBy(asc(commissionDisputes.openedAt), asc(commissionDisputes.id));
      const projected = [];
      for (const row of disputes) {
        const statements = await tx.select().from(commissionDisputeStatements).where(eq(commissionDisputeStatements.disputeId, row.id)).orderBy(asc(commissionDisputeStatements.createdAt), asc(commissionDisputeStatements.id));
        const [ruling] = await tx.select().from(commissionRulings).where(eq(commissionRulings.disputeId, row.id)).limit(1);
        const corrections = ruling ? await tx.select().from(commissionRulingCorrections).where(eq(commissionRulingCorrections.rulingId, ruling.id)).orderBy(asc(commissionRulingCorrections.correctedAt), asc(commissionRulingCorrections.id)) : [];
        projected.push({ id: row.id, state: row.state, reason: row.reason, trigger: row.trigger, requestedOutcome: row.requestedOutcome, requestedRefundVnd: row.requestedRefundVnd,
          respondBy: (await effectiveResolutionDeadline(tx, row.respondBy))?.toISOString() ?? null, openedAt: row.openedAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null,
          statements: statements.map((entry) => ({ id: entry.id, authorRole: entry.authorRole, kind: entry.kind, text: decrypt("commission_dispute_statements", entry.id, "text", entry.textEnvelope), createdAt: entry.createdAt.toISOString() })),
          ruling: ruling ? { id: ruling.id, outcome: ruling.outcome, refundAmountVnd: ruling.refundAmountVnd, policyRevisionId: ruling.policyRevisionId,
            reasoning: decrypt("commission_rulings", ruling.id, "reasoning", ruling.reasoningEnvelope), internalNote: ruling.internalNoteEnvelope === null ? null : decrypt("commission_rulings", ruling.id, "internal_note", ruling.internalNoteEnvelope), ruledAt: ruling.ruledAt.toISOString(),
            corrections: corrections.map((entry) => ({ id: entry.id, refundAmountVnd: entry.refundAmountVnd, effect: entry.effect, reason: decrypt("commission_ruling_corrections", entry.id, "reason", entry.reasonEnvelope), correctedAt: entry.correctedAt.toISOString() })) } : null });
      }
      return { proposals: await Promise.all(proposals.map(async (row) => ({ id: row.id, proposerRole: row.proposerRole, kind: row.kind, refundAmountVnd: row.refundAmountVnd,
        note: decrypt("commission_proposals", row.id, "note", row.noteEnvelope), state: row.state, respondBy: (await effectiveResolutionDeadline(tx, row.respondBy))?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(), endedAt: row.endedAt?.toISOString() ?? null }))), disputes: projected, lateClaim: await input.lateClaims?.readForOrder(tx, orderId) ?? null };
    },
    getOrderResolution,
    async listMyCases(command: Readonly<{ actor: ResolutionActor }>) {
      if (!readCommissionRecord(command, ["actor"])) resolutionFail("invalid_request"); actorValid(command.actor);
      return boundary(async () => {
        await input.db.transaction((tx) => session(tx, command.actor));
        const ids = new Set<string>();
        for (const role of ["buyer", "creator"] as const) {
          let before: { createdAt: string; id: string } | undefined;
          do {
            const page = await input.orders.listOrders({ actor: command.actor, role, before, limit: 50 });
            for (const row of page.items) ids.add(row.id);
            before = page.nextBefore ?? undefined;
          } while (before);
        }
        const disputes = []; const refunds = []; const lateClaims: (LateClaimView & { orderId: string })[] = [];
        for (const orderId of ids) {
          const view = await getOrderResolution({ actor: command.actor, orderId });
          // Include earlier withdrawn disputes without private statement text.
          const rows = await input.db.select().from(commissionDisputes).where(eq(commissionDisputes.orderId, orderId))
            .orderBy(desc(commissionDisputes.openedAt), desc(commissionDisputes.id));
          for (const row of rows) disputes.push({ id: row.id, orderId, state: row.state, reason: row.reason, trigger: row.trigger,
            openedAt: row.openedAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null });
          for (const row of view.refunds) refunds.push({ ...row, orderId });
          if (view.lateClaim) lateClaims.push({ ...view.lateClaim, orderId });
        }
        await input.db.transaction((tx) => session(tx, command.actor));
        return { disputes, refunds, lateClaims };
      });
    },
  };
}
