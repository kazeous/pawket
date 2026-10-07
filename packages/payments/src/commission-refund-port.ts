import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { calculateStoredBusinessDayDeadline, commissionRefundObligations, commissionRefundSends, commissionRefundEvents,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { COMMISSION_REFUND_POLICY, createRefundReference, refundFail, type CommissionRefundSource } from "./commission-refund-policy.js";

type Obligation = typeof commissionRefundObligations.$inferSelect;
type Actor = Readonly<{ userId: string; sessionId: string }>;
type Command = Readonly<{ obligationId: string; actor: Actor | null; requestId: string; at: Date }>;
type Scan = Readonly<{ at: Date; limit: number }>;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const sources: readonly CommissionRefundSource[] = ["agreement", "ruling", "correction", "late_payment", "late_payment_provider", "suspension_cancel", "fulfillment_freeze"];
function time(at: Date) { if (!(at instanceof Date) || !Number.isFinite(at.getTime())) refundFail("invalid_request"); }
function scan(input: Scan) {
  time(input.at); if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) refundFail("invalid_request");
}

/** Internal transaction port. Callers own party/case authorization, creator fences and command idempotency. */
export function createCommissionRefundPort(input: { keyring: EncryptionKeyring; calendarVersion: string; idFactory?: () => string; now?: () => Date }) {
  const newId = () => { const value = (input.idFactory ?? randomUUID)(); if (!uuid(value)) refundFail("dependency_unavailable"); return value; };
  async function event(tx: PawketTransaction, row: Obligation, command: Command, action: string, toState = row.state) {
    await tx.insert(commissionRefundEvents).values({ id: newId(), obligationId: row.id, action, actorUserId: command.actor?.userId ?? null,
      actorSessionId: command.actor?.sessionId ?? null, fromState: action === "created" ? null : row.state,
      toState, requestId: command.requestId, occurredAt: command.at });
  }
  async function lock(tx: PawketTransaction, command: Command): Promise<Obligation> {
    if (!uuid(command.obligationId) || !identifier(command.requestId) || (command.actor !== null &&
      (!identifier(command.actor.userId) || !identifier(command.actor.sessionId)))) refundFail("invalid_request");
    time(command.at);
    const [row] = await tx.select().from(commissionRefundObligations).where(eq(commissionRefundObligations.id, command.obligationId)).limit(1).for("update");
    if (!row) refundFail("not_available");
    return row;
  }
  function fresh(row: Obligation, command: Command) {
    if (command.at < row.updatedAt) refundFail("invalid_request");
  }
  async function recorded(tx: PawketTransaction, command: Command, action: string | readonly string[]) {
    const [row] = await tx.select({ action: commissionRefundEvents.action }).from(commissionRefundEvents)
      .where(and(eq(commissionRefundEvents.obligationId, command.obligationId), eq(commissionRefundEvents.requestId, command.requestId),
        inArray(commissionRefundEvents.action, typeof action === "string" ? [action] : action))).limit(1);
    return row ?? null;
  }
  async function change(tx: PawketTransaction, row: Obligation, command: Command, action: string, values: Partial<typeof commissionRefundObligations.$inferInsert>) {
    const [updated] = await tx.update(commissionRefundObligations).set({ ...values, version: row.version + 1, updatedAt: command.at })
      .where(and(eq(commissionRefundObligations.id, row.id), eq(commissionRefundObligations.version, row.version))).returning();
    if (!updated) refundFail("version_conflict");
    await event(tx, row, command, action, updated.state);
  }
  async function hasSend(tx: PawketTransaction, id: string) {
    const [send] = await tx.select({ id: commissionRefundSends.id }).from(commissionRefundSends)
      .where(eq(commissionRefundSends.obligationId, id)).limit(1);
    return Boolean(send);
  }
  async function findBySource(tx: PawketTransaction, command: { source: CommissionRefundSource; sourceId: string }) {
    if (!sources.includes(command.source) || !uuid(command.sourceId)) refundFail("invalid_request");
    const [row] = await tx.select().from(commissionRefundObligations)
      .where(and(eq(commissionRefundObligations.source, command.source), eq(commissionRefundObligations.sourceId, command.sourceId))).limit(1);
    return row ?? null;
  }
  return {
    /** Caller must have checked the obligation's order and party, or its case. */
    findBySource,
    /** Caller must have checked the obligation's order and parties, or its case. */
    async createObligation(tx: PawketTransaction, command: Readonly<{ orderId: string; paymentIntentId: string; creatorUserId: string; buyerUserId: string;
      source: CommissionRefundSource; sourceId: string; amountVnd: number; requestId: string; at: Date }>): Promise<{ obligationId: string; created: boolean }> {
      if (!uuid(command.orderId) || !uuid(command.paymentIntentId) || !identifier(command.creatorUserId) || !identifier(command.buyerUserId)
        || !sources.includes(command.source) || !uuid(command.sourceId) || !identifier(command.requestId)
        || !Number.isSafeInteger(command.amountVnd) || command.amountVnd < 1 || command.amountVnd > 50_000_000) refundFail("invalid_request");
      time(command.at);
      const [row] = await tx.insert(commissionRefundObligations).values({ id: newId(), orderId: command.orderId, paymentIntentId: command.paymentIntentId,
        creatorUserId: command.creatorUserId, buyerUserId: command.buyerUserId, source: command.source, sourceId: command.sourceId,
        amountVnd: command.amountVnd, reference: createRefundReference(), calendarVersion: input.calendarVersion, createdAt: command.at, updatedAt: command.at })
        .onConflictDoNothing({ target: [commissionRefundObligations.source, commissionRefundObligations.sourceId] }).returning();
      if (!row) {
        const existing = await findBySource(tx, command);
        if (!existing) refundFail("version_conflict");
        if (existing.orderId !== command.orderId || existing.paymentIntentId !== command.paymentIntentId || existing.creatorUserId !== command.creatorUserId
          || existing.buyerUserId !== command.buyerUserId) refundFail("invalid_request");
        return { obligationId: existing.id, created: false };
      }
      await event(tx, row, { obligationId: row.id, actor: null, requestId: command.requestId, at: command.at }, "created");
      return { obligationId: row.id, created: true };
    },
    /** Caller must have checked the obligation's order and party, or its case. */
    async adjustAmount(tx: PawketTransaction, command: Command & Readonly<{ newAmountVnd: number }>): Promise<"adjusted" | "waived" | "recorded_only"> {
      if (!Number.isSafeInteger(command.newAmountVnd) || command.newAmountVnd < 0 || command.newAmountVnd > 50_000_000) refundFail("invalid_request");
      const row = await lock(tx, command);
      const prior = await recorded(tx, command, ["amount_adjusted", "amount_recorded", "waived"]);
      if (prior) return prior.action === "amount_adjusted" ? "adjusted" : prior.action === "amount_recorded" ? "recorded_only" : "waived";
      fresh(row, command);
      if (command.newAmountVnd > row.amountVnd) refundFail("invalid_request");
      const sent = await hasSend(tx, row.id);
      if (sent || !["awaiting_destination", "awaiting_send"].includes(row.state)) {
        await change(tx, row, command, "amount_recorded", {}); return "recorded_only";
      }
      if (command.newAmountVnd === 0) {
        await change(tx, row, command, "waived", { state: "waived", endedAt: command.at }); return "waived";
      }
      await change(tx, row, command, "amount_adjusted", { amountVnd: command.newAmountVnd }); return "adjusted";
    },
    /** Caller must have checked the obligation's order and party, or its case. */
    async waive(tx: PawketTransaction, command: Command): Promise<void> {
      const row = await lock(tx, command); if (await recorded(tx, command, "waived")) return;
      fresh(row, command);
      if (!["awaiting_destination", "awaiting_send", "not_received"].includes(row.state)) refundFail("invalid_transition");
      await change(tx, row, command, "waived", { state: "waived", endedAt: command.at });
    },
    /** Caller must have checked the obligation's order and party, or its case. */
    async extendDeadline(tx: PawketTransaction, command: Command & Readonly<{ until: Date }>): Promise<void> {
      time(command.until); const row = await lock(tx, command); if (await recorded(tx, command, "deadline_extended")) return;
      fresh(row, command);
      if (row.state !== "awaiting_send" || !row.dueAt) refundFail("invalid_transition");
      if (command.until <= row.dueAt || command.until <= command.at || command.until.getTime() > command.at.getTime() + COMMISSION_REFUND_POLICY.maxExtensionMs) refundFail("invalid_request");
      await change(tx, row, command, "deadline_extended", { dueAt: command.until });
    },
    /** Caller must have checked the obligation's order and party, or its case. */
    async acceptReceiptEvidence(tx: PawketTransaction, command: Command): Promise<void> {
      const row = await lock(tx, command); if (await recorded(tx, command, "receipt_confirmed")) return;
      fresh(row, command);
      if (row.state !== "not_received") refundFail("invalid_transition");
      await change(tx, row, command, "receipt_confirmed", { state: "received", endedAt: command.at });
    },
    /** Caller must have checked the obligation's order and party, or its case. */
    async requireResend(tx: PawketTransaction, command: Command): Promise<void> {
      const row = await lock(tx, command); if (await recorded(tx, command, "resend_required")) return;
      fresh(row, command);
      if (row.state !== "not_received") refundFail("invalid_transition");
      const dueAt = await calculateStoredBusinessDayDeadline(tx, { from: command.at, businessDays: COMMISSION_REFUND_POLICY.sendBusinessDays, calendarVersion: input.calendarVersion });
      await change(tx, row, command, "resend_required", { state: "awaiting_send", currentSendId: null, confirmBy: null, dueAt, calendarVersion: input.calendarVersion });
    },
    /** Caller must have checked the obligation's order and party, or its case. */
    async presumeReceived(tx: PawketTransaction, command: Omit<Command, "actor">): Promise<void> {
      const full = { ...command, actor: null }; const row = await lock(tx, full);
      if (await recorded(tx, full, "presumed_received")) return;
      fresh(row, full);
      if (row.state !== "sent" || !row.confirmBy || row.confirmBy > command.at) refundFail("invalid_transition");
      await change(tx, row, full, "presumed_received", { state: "presumed_received", endedAt: command.at });
    },
    async awaitingSendDeadlines(tx: PawketTransaction, creatorUserId: string): Promise<readonly { obligationId: string; dueAt: Date }[]> {
      const rows = await tx.select({ obligationId: commissionRefundObligations.id, dueAt: commissionRefundObligations.dueAt }).from(commissionRefundObligations)
        .where(and(eq(commissionRefundObligations.creatorUserId, creatorUserId), eq(commissionRefundObligations.state, "awaiting_send"))).orderBy(asc(commissionRefundObligations.dueAt), asc(commissionRefundObligations.id));
      return rows.map((row) => ({ obligationId: row.obligationId, dueAt: row.dueAt! }));
    },
    async readOverdueCandidates(db: PawketDatabase, command: Scan) {
      scan(command);
      return db.select({ obligationId: commissionRefundObligations.id, orderId: commissionRefundObligations.orderId, creatorUserId: commissionRefundObligations.creatorUserId,
        buyerUserId: commissionRefundObligations.buyerUserId, dueAt: commissionRefundObligations.dueAt, version: commissionRefundObligations.version }).from(commissionRefundObligations)
        .where(and(eq(commissionRefundObligations.state, "awaiting_send"), lte(commissionRefundObligations.dueAt, command.at)))
        .orderBy(asc(commissionRefundObligations.dueAt), asc(commissionRefundObligations.id)).limit(command.limit);
    },
    async readConfirmationCandidates(db: PawketDatabase, command: Scan) {
      scan(command);
      return db.select({ obligationId: commissionRefundObligations.id, orderId: commissionRefundObligations.orderId, creatorUserId: commissionRefundObligations.creatorUserId,
        confirmBy: commissionRefundObligations.confirmBy, version: commissionRefundObligations.version }).from(commissionRefundObligations)
        .where(and(eq(commissionRefundObligations.state, "sent"), lte(commissionRefundObligations.confirmBy, command.at)))
        .orderBy(asc(commissionRefundObligations.confirmBy), asc(commissionRefundObligations.id)).limit(command.limit);
    },
    async purgeDestinations(db: PawketDatabase, command: Scan): Promise<number> {
      scan(command);
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionRefundObligations).where(and(inArray(commissionRefundObligations.state, ["received", "presumed_received", "waived"]),
          lte(commissionRefundObligations.endedAt, new Date(command.at.getTime() - COMMISSION_REFUND_POLICY.purgeAfterMs)),
          isNotNull(commissionRefundObligations.destinationEnteredAt), isNull(commissionRefundObligations.destinationPurgedAt)))
          .orderBy(asc(commissionRefundObligations.endedAt), asc(commissionRefundObligations.id)).limit(command.limit).for("update", { skipLocked: true });
        for (const row of rows) await change(tx, row, { obligationId: row.id, actor: null, requestId: newId(), at: command.at }, "destination_purged",
          { destinationAccountEnvelope: null, destinationHolderEnvelope: null, destinationPurgedAt: command.at });
        return rows.length;
      });
    },
    /** Caller must have checked the obligations' order and party, or their case. */
    async listForOrder(tx: PawketTransaction, command: { orderId: string }) {
      if (!uuid(command.orderId)) refundFail("invalid_request");
      // Account plaintext and envelopes are available only through authorized reveals.
      return tx.select({ obligationId: commissionRefundObligations.id, source: commissionRefundObligations.source, sourceId: commissionRefundObligations.sourceId,
        amountVnd: commissionRefundObligations.amountVnd, reference: commissionRefundObligations.reference, state: commissionRefundObligations.state,
        bankBin: commissionRefundObligations.destinationBankBin, bankName: commissionRefundObligations.destinationBankName, suffix: commissionRefundObligations.destinationSuffix,
        dueAt: commissionRefundObligations.dueAt, confirmBy: commissionRefundObligations.confirmBy, endedAt: commissionRefundObligations.endedAt,
        destinationPurgedAt: commissionRefundObligations.destinationPurgedAt, currentSendId: commissionRefundObligations.currentSendId,
        version: commissionRefundObligations.version, createdAt: commissionRefundObligations.createdAt }).from(commissionRefundObligations)
        .where(eq(commissionRefundObligations.orderId, command.orderId)).orderBy(asc(commissionRefundObligations.createdAt), asc(commissionRefundObligations.id));
    },
    /** Caller must have checked the obligation's order and authorized case, with same-transaction access logging. */
    async revealForCase(tx: PawketTransaction, obligationId: string) {
      // Trust authorizes an open case and writes its access log in this same transaction.
      if (!uuid(obligationId)) refundFail("invalid_request");
      const [row] = await tx.select().from(commissionRefundObligations).where(eq(commissionRefundObligations.id, obligationId)).limit(1);
      if (!row?.destinationAccountEnvelope || !row.destinationHolderEnvelope || row.destinationPurgedAt !== null) return null;
      try {
        const accountNumber = decryptSensitiveField({ keyring: input.keyring, envelope: row.destinationAccountEnvelope,
          binding: { recordType: "commission_refund_obligation", recordId: row.id, fieldName: "account_number" } });
        const holderName = decryptSensitiveField({ keyring: input.keyring, envelope: row.destinationHolderEnvelope,
          binding: { recordType: "commission_refund_obligation", recordId: row.id, fieldName: "holder_name" } });
        return { obligationId: row.id, bankBin: row.destinationBankBin!, bankName: row.destinationBankName!, accountNumber, holderName, suffix: row.destinationSuffix! };
      } catch { refundFail("not_available"); }
    },
    async readAging(db: PawketDatabase, command: Scan) {
      scan(command);
      return db.select({ obligationId: commissionRefundObligations.id, orderId: commissionRefundObligations.orderId, creatorUserId: commissionRefundObligations.creatorUserId,
        buyerUserId: commissionRefundObligations.buyerUserId, amountVnd: commissionRefundObligations.amountVnd, createdAt: commissionRefundObligations.createdAt }).from(commissionRefundObligations)
        .where(and(eq(commissionRefundObligations.state, "awaiting_destination"), lte(commissionRefundObligations.createdAt, new Date(command.at.getTime() - COMMISSION_REFUND_POLICY.agingAfterMs))))
        .orderBy(asc(commissionRefundObligations.createdAt), asc(commissionRefundObligations.id)).limit(command.limit);
    },
  };
}
export type CommissionRefundPort = ReturnType<typeof createCommissionRefundPort>;
