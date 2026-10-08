import { createHash, randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { beginIdempotentCommand, completeIdempotentCommand, calculateStoredBusinessDayDeadline, vietnamDateFromInstant,
  commissionRefundObligations, commissionRefundSends, commissionRefundEvents, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { CommissionRefundError, COMMISSION_REFUND_POLICY, normalizeBankReference, refundFail } from "./commission-refund-policy.js";
import { createCommissionRefundPort } from "./commission-refund-port.js";
import { normalizeReceivingAccountProposal } from "./receiving-account-policy.js";
import { readTipPortRecord } from "./tip-port-boundary.js";
import { requireIntegerVnd } from "./tip-contracts.js";
import { createVietQrTransferInstruction, isVietQrDestinationSupported, VIETQR_REFUND_BANKS } from "./vietqr.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Assurance = Readonly<{ primaryAuthenticatedAt: Date; mfaEnrolled: boolean; mfaVerifiedAt: Date | null; sessionExpiresAt: Date }>;
type Obligation = typeof commissionRefundObligations.$inferSelect;
type Command = Readonly<{ actor: Actor; obligationId: string; expectedVersion: number; idempotencyKey: string; requestId: string }>;
type Party = "buyer" | "creator";
// Structural ports keep Payments independent of Orders, Trust and Files.
type Cases = Readonly<{
  openCase(tx: PawketTransaction, command: Readonly<{ kind: "refund_not_received"; orderId: string; sourceType: "commission_refund_obligation";
    sourceId: string; policyRevisionId: string | null; requestId: string; at: Date }>): Promise<{ caseId: string; created: boolean }>;
  findOpenCase(tx: PawketTransaction, command: { kind: "refund_overdue"; sourceId: string }): Promise<{ caseId: string; version: number } | null>;
  resolveCase(tx: PawketTransaction, command: Readonly<{ caseId: string; resolutionKind: string; actor: Actor | null; reason: string | null; requestId: string; at: Date }>): Promise<void>;
}>;
export type CommissionRefundFilesPort = Readonly<{
  attachResolutionEvidence(tx: PawketTransaction, command: Readonly<{ orderId: string; ownerUserId: string;
    target: { kind: "refund_send" | "late_claim"; id: string }; fileIds: readonly string[]; at: Date }>): Promise<"attached" | "invalid" | "disabled">;
}>;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; applicationRevision: string; calendarVersion: string;
  mode: "disabled" | "enabled"; recentAuthMs: number; mfaAuthMs: number;
  lockCreator(tx: PawketTransaction, creatorUserId: string): Promise<void>;
  effectiveDeadline?(tx: PawketTransaction, deadline: Date): Promise<Date | null>;
  assurance: { getTipSessionAssurance(tx: PawketTransaction, actor: Actor, at: Date): Promise<Assurance | null> };
  cases?: Cases; files?: CommissionRefundFilesPort; now?: () => Date; idFactory?: () => string;
}>;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const commandKeys = ["actor", "obligationId", "expectedVersion", "idempotencyKey", "requestId"];
function record(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) refundFail("invalid_request");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) || !readTipPortRecord(value, keys as string[])
    || required.some((key) => !Object.hasOwn(value, key))) refundFail("invalid_request");
}
function actorValid(actor: Actor) {
  const fields = readTipPortRecord(actor, ["userId", "sessionId"]);
  if (!fields || !identifier(fields.userId) || !identifier(fields.sessionId)) refundFail("not_available");
}
function commandValid(command: Command) {
  actorValid(command.actor);
  if (!uuid(command.obligationId) || !identifier(command.requestId) || typeof command.idempotencyKey !== "string"
    || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) || !Number.isSafeInteger(command.expectedVersion)
    || command.expectedVersion < 1 || command.expectedVersion > 2_147_483_646) refundFail("invalid_request");
}
function transferDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) refundFail("invalid_request");
  const date = new Date(`${value}T00:00:00Z`);
  if (!validDate(date) || date.toISOString().slice(0, 10) !== value) refundFail("invalid_request");
  return value;
}
function noteText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") refundFail("invalid_request");
  const text = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if ([...text].length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\p{Cs}]/u.test(text)) refundFail("invalid_request");
  return text || null;
}
function evidenceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 3
    || Reflect.ownKeys(value).length !== value.length + 1) refundFail("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value); const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = descriptors[String(index)];
    if (!field || !field.enumerable || !("value" in field) || !uuid(field.value)) refundFail("invalid_request");
    ids.push(field.value);
  }
  if (new Set(ids).size !== ids.length) refundFail("invalid_request");
  return Object.freeze(ids);
}

export function createCommissionRefundService(input: Input) {
  if (!identifier(input.applicationRevision) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.calendarVersion) || input.lookupHmacKey.length < 32
    || !["disabled", "enabled"].includes(input.mode) || !Number.isSafeInteger(input.recentAuthMs) || input.recentAuthMs < 60_000 || input.recentAuthMs > 3_600_000
    || !Number.isSafeInteger(input.mfaAuthMs) || input.mfaAuthMs < 30_000 || input.mfaAuthMs > 3_600_000 || typeof input.lockCreator !== "function"
    || (input.effectiveDeadline !== undefined && typeof input.effectiveDeadline !== "function")) refundFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date());
  const port = createCommissionRefundPort(input);
  const enabled = () => { if (input.mode !== "enabled") refundFail("resolution_disabled"); };
  const now = () => { const at = clock(); if (!validDate(at)) refundFail("dependency_unavailable"); return new Date(at); };
  const newId = () => { const id = (input.idFactory ?? randomUUID)(); if (!uuid(id)) refundFail("dependency_unavailable"); return id; };
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) { if (error instanceof CommissionRefundError) throw error; return refundFail("dependency_unavailable"); }
  }
  function validateAssurance(proof: Assurance | null, at: Date, fresh: boolean): Assurance {
    const fields = readTipPortRecord(proof, ["primaryAuthenticatedAt", "sessionExpiresAt", "mfaEnrolled", "mfaVerifiedAt"]);
    if (!fields || !validDate(fields.primaryAuthenticatedAt) || !validDate(fields.sessionExpiresAt) || typeof fields.mfaEnrolled !== "boolean"
      || (fields.mfaVerifiedAt !== null && !validDate(fields.mfaVerifiedAt))) refundFail("not_available");
    const result = { primaryAuthenticatedAt: fields.primaryAuthenticatedAt, sessionExpiresAt: fields.sessionExpiresAt,
      mfaEnrolled: fields.mfaEnrolled, mfaVerifiedAt: fields.mfaVerifiedAt };
    if (result.sessionExpiresAt <= at) refundFail("not_available");
    const age = at.getTime() - result.primaryAuthenticatedAt.getTime();
    if (age < 0 || (fresh && age > input.recentAuthMs)) refundFail("recent_auth_required");
    if (fresh && result.mfaEnrolled && (!result.mfaVerifiedAt || result.mfaVerifiedAt > at || result.mfaVerifiedAt < result.primaryAuthenticatedAt
      || at.getTime() - result.mfaVerifiedAt.getTime() > input.mfaAuthMs)) refundFail("totp_required");
    return result;
  }
  async function session(tx: PawketTransaction, actor: Actor, at: Date, fresh: boolean) {
    return validateAssurance(await input.assurance.getTipSessionAssurance(tx, actor, at), at, fresh);
  }
  function party(row: Obligation | undefined, actor: Actor, role?: Party): Obligation {
    // Obligation identity and order/payment/party binding are immutable and database-guarded.
    if (!row || (role === "buyer" ? row.buyerUserId !== actor.userId : role === "creator" ? row.creatorUserId !== actor.userId
      : row.buyerUserId !== actor.userId && row.creatorUserId !== actor.userId)) refundFail("not_available");
    return row;
  }
  async function owned(tx: PawketTransaction, obligationId: string, actor: Actor, role?: Party, locked = false) {
    const query = tx.select().from(commissionRefundObligations).where(eq(commissionRefundObligations.id, obligationId)).limit(1);
    const [row] = await (locked ? query.for("update") : query);
    return party(row, actor, role);
  }
  async function recheck(tx: PawketTransaction, actor: Actor, startedAt: Date, proof: Assurance, fresh: boolean) {
    const at = now(); if (at < startedAt || at >= proof.sessionExpiresAt) refundFail("not_available");
    await session(tx, actor, at, fresh); return at;
  }
  async function event(tx: PawketTransaction, row: Obligation, command: { actor: Actor; requestId: string }, action: string, at: Date, toState = row.state) {
    await tx.insert(commissionRefundEvents).values({ id: newId(), obligationId: row.id, action, actorUserId: command.actor.userId,
      actorSessionId: command.actor.sessionId, fromState: row.state, toState, requestId: command.requestId, occurredAt: at });
  }
  async function change(tx: PawketTransaction, row: Obligation, command: Command, action: string, at: Date,
    values: Partial<typeof commissionRefundObligations.$inferInsert>) {
    if (at < row.updatedAt) refundFail("invalid_request");
    const [updated] = await tx.update(commissionRefundObligations).set({ ...values, version: row.version + 1, updatedAt: at })
      .where(and(eq(commissionRefundObligations.id, row.id), eq(commissionRefundObligations.version, row.version))).returning();
    if (!updated) refundFail("version_conflict");
    await event(tx, row, command, action, at, updated.state); return { version: updated.version };
  }
  async function mutate(command: Command, scope: string, payload: unknown, role: Party, fresh: boolean,
    apply: (tx: PawketTransaction, row: Obligation, at: Date) => Promise<{ version: number }>, guardUntil?: (tx: PawketTransaction, row: Obligation) => Promise<Date>) {
    commandValid(command);
    // Prehash bounded multibyte notes before the shared HMAC primitive's 8 KiB limit.
    const fingerprint = digest("commission-refund-command", createHash("sha256").update(JSON.stringify([scope, command.actor.userId, payload])).digest("hex"));
    return boundary(() => input.db.transaction(async (tx) => {
      const startedAt = now(); const started = await beginIdempotentCommand(tx, { actorUserId: command.actor.userId,
        commandScope: `payments.commission-refund.${scope}`, keyHash: digest("commission-refund-command-key", command.idempotencyKey),
        requestFingerprint: fingerprint, now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
      if (started.kind !== "acquired" && started.kind !== "replay") refundFail("idempotency_conflict");
      const candidate = await owned(tx, command.obligationId, command.actor, role); await input.lockCreator(tx, candidate.creatorUserId);
      const row = await owned(tx, command.obligationId, command.actor, role, true); const proof = await session(tx, command.actor, now(), fresh);
      if (started.kind === "replay") {
        const prefix = `${row.id}:`; const version = Number(started.resultReference.slice(prefix.length));
        if (!started.resultReference.startsWith(prefix) || !Number.isSafeInteger(version) || version < 2 || version > row.version) refundFail("idempotency_conflict");
        await recheck(tx, command.actor, startedAt, proof, fresh); return { version };
      }
      if (row.version !== command.expectedVersion) refundFail("version_conflict");
      const at = now(); const changed = await apply(tx, row, at); const completedAt = await recheck(tx, command.actor, startedAt, proof, fresh);
      if (completedAt < at) refundFail("not_available");
      const deadline = await guardUntil?.(tx, row); if (deadline && completedAt >= deadline) refundFail("invalid_transition");
      if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `${row.id}:${changed.version}`, completedAt })) refundFail("idempotency_conflict");
      return changed;
    }));
  }
  async function receiptDeadline(tx: PawketTransaction, row: Obligation): Promise<Date> {
    if (!row.confirmBy) refundFail("invalid_transition");
    const deadline = input.effectiveDeadline ? await input.effectiveDeadline(tx, row.confirmBy) : row.confirmBy;
    if (deadline === null) refundFail("resolution_disabled");
    return deadline;
  }
  return {
    async enterDestination(command: Command & Readonly<{ bankBin: string; accountNumber: string; accountHolder: string }>): Promise<{ version: number }> {
      enabled(); record(command, [...commandKeys, "bankBin", "accountNumber", "accountHolder"]); commandValid(command);
      if (typeof command.bankBin !== "string" || typeof command.accountNumber !== "string" || typeof command.accountHolder !== "string") refundFail("invalid_destination");
      let destination;
      try { destination = normalizeReceivingAccountProposal({ bankBin: command.bankBin, accountNumber: command.accountNumber,
        accountHolderLabel: command.accountHolder.normalize("NFC"), supportedBanks: VIETQR_REFUND_BANKS }); }
      catch { return refundFail("invalid_destination"); }
      if (!isVietQrDestinationSupported(destination, VIETQR_REFUND_BANKS)) refundFail("invalid_destination");
      return mutate(command, "enter-destination", [command.obligationId, command.expectedVersion, destination.bankBin, destination.accountNumber, destination.accountHolderLabel], "buyer", true, async (tx, row, at) => {
        const [send] = await tx.select({ id: commissionRefundSends.id }).from(commissionRefundSends).where(eq(commissionRefundSends.obligationId, row.id)).limit(1);
        if (!["awaiting_destination", "awaiting_send"].includes(row.state) || send) refundFail("invalid_transition");
        const dueAt = await calculateStoredBusinessDayDeadline(tx, { from: at, businessDays: COMMISSION_REFUND_POLICY.sendBusinessDays, calendarVersion: input.calendarVersion });
        const result = await change(tx, row, command, "destination_entered", at, { state: "awaiting_send", destinationBankBin: destination.bankBin,
          destinationBankName: destination.bankName, destinationSuffix: destination.accountNumber.slice(-4), destinationEnteredAt: at, dueAt, calendarVersion: input.calendarVersion,
          destinationAccountEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: destination.accountNumber,
            binding: { recordType: "commission_refund_obligation", recordId: row.id, fieldName: "account_number" } }),
          destinationHolderEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: destination.accountHolderLabel,
            binding: { recordType: "commission_refund_obligation", recordId: row.id, fieldName: "holder_name" } }) });
        const overdue = await input.cases?.findOpenCase(tx, { kind: "refund_overdue", sourceId: row.id });
        if (overdue) await input.cases!.resolveCase(tx, { caseId: overdue.caseId, resolutionKind: "extended", actor: command.actor, reason: null, requestId: command.requestId, at });
        return result;
      });
    },
    async revealDestination(command: Readonly<{ actor: Actor; obligationId: string; requestId: string }>) {
      enabled(); record(command, ["actor", "obligationId", "requestId"]); actorValid(command.actor);
      if (!uuid(command.obligationId) || !identifier(command.requestId)) refundFail("invalid_request");
      return boundary(() => input.db.transaction(async (tx) => {
        const startedAt = now(); const candidate = await owned(tx, command.obligationId, command.actor, "creator");
        await input.lockCreator(tx, candidate.creatorUserId);
        const row = await owned(tx, command.obligationId, command.actor, "creator", true); const proof = await session(tx, command.actor, now(), true);
        if (row.state !== "awaiting_send" || !row.dueAt) refundFail("invalid_transition");
        if (!row.destinationAccountEnvelope || !row.destinationHolderEnvelope || !row.destinationBankBin || !row.destinationBankName
          || row.destinationPurgedAt !== null) refundFail("not_available");
        let accountNumber: string; let accountHolder: string;
        try {
          accountNumber = decryptSensitiveField({ keyring: input.keyring, envelope: row.destinationAccountEnvelope,
            binding: { recordType: "commission_refund_obligation", recordId: row.id, fieldName: "account_number" } });
          accountHolder = decryptSensitiveField({ keyring: input.keyring, envelope: row.destinationHolderEnvelope,
            binding: { recordType: "commission_refund_obligation", recordId: row.id, fieldName: "holder_name" } });
        } catch { return refundFail("not_available"); }
        const qr = createVietQrTransferInstruction({ bankBin: row.destinationBankBin, accountNumber,
          amountVnd: requireIntegerVnd(row.amountVnd, { minimumVnd: 1, maximumVnd: 50_000_000 }), transferReference: row.reference }, VIETQR_REFUND_BANKS);
        // Each reveal requires its own audit entry; never reuse an old view after a correction.
        await event(tx, row, command, "destination_revealed", now()); await recheck(tx, command.actor, startedAt, proof, true);
        return { bankName: row.destinationBankName, accountNumber, accountHolder,
          amountVnd: row.amountVnd, reference: row.reference, qrPayload: qr.payload, dueAt: row.dueAt.toISOString() };
      }));
    },
    async recordSend(command: Command & Readonly<{ transferDate: string; bankReference: string; note?: unknown; fileIds?: readonly string[] }>): Promise<{ version: number }> {
      enabled(); record(command, [...commandKeys, "transferDate", "bankReference"], ["note", "fileIds"]); commandValid(command);
      const date = transferDate(command.transferDate); const bankReference = normalizeBankReference(command.bankReference); const note = noteText(command.note);
      if (Object.hasOwn(command, "fileIds") && !input.files) refundFail("invalid_request");
      const fileIds = Object.hasOwn(command, "fileIds") ? evidenceIds(command.fileIds) : [];
      return mutate(command, "record-send", [command.obligationId, command.expectedVersion, date, bankReference, note, fileIds], "creator", true, async (tx, row, at) => {
        if (row.state !== "awaiting_send") refundFail("invalid_transition");
        if (date < vietnamDateFromInstant(row.createdAt) || date > vietnamDateFromInstant(at)) refundFail("invalid_request");
        const sendId = newId();
        await tx.insert(commissionRefundSends).values({ id: sendId, obligationId: row.id, transferDate: date,
          referenceEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: bankReference,
            binding: { recordType: "commission_refund_send", recordId: sendId, fieldName: "bank_reference" } }),
          noteEnvelope: note === null ? null : encryptSensitiveField({ keyring: input.keyring, plaintext: note,
            binding: { recordType: "commission_refund_send", recordId: sendId, fieldName: "note" } }),
          actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId, requestId: command.requestId, recordedAt: at });
        if (fileIds.length) {
          const attached = await input.files!.attachResolutionEvidence(tx, { orderId: row.orderId, ownerUserId: row.creatorUserId,
            target: { kind: "refund_send", id: sendId }, fileIds, at });
          if (attached === "disabled") refundFail("resolution_disabled");
          if (attached !== "attached") refundFail("invalid_request");
        }
        const result = await change(tx, row, command, "sent_recorded", at, { state: "sent", currentSendId: sendId,
          confirmBy: new Date(at.getTime() + COMMISSION_REFUND_POLICY.confirmWindowMs) });
        const overdue = await input.cases?.findOpenCase(tx, { kind: "refund_overdue", sourceId: row.id });
        if (overdue) await input.cases!.resolveCase(tx, { caseId: overdue.caseId, resolutionKind: "send_recorded", actor: command.actor, reason: null, requestId: command.requestId, at });
        return result;
      });
    },
    async confirmReceipt(command: Command & Readonly<{ received: boolean }>): Promise<{ version: number }> {
      enabled(); record(command, [...commandKeys, "received"]); commandValid(command);
      if (typeof command.received !== "boolean") refundFail("invalid_request");
      return mutate(command, "confirm-receipt", [command.obligationId, command.expectedVersion, command.received], "buyer", false, async (tx, row, at) => {
        if (row.state !== "sent") refundFail("invalid_transition");
        if (at >= await receiptDeadline(tx, row)) refundFail("invalid_transition");
        if (!command.received && !input.cases) refundFail("dependency_unavailable");
        const result = await change(tx, row, command, command.received ? "receipt_confirmed" : "receipt_denied", at,
          { state: command.received ? "received" : "not_received", endedAt: command.received ? at : null });
        if (!command.received) await input.cases!.openCase(tx, { kind: "refund_not_received", orderId: row.orderId, sourceType: "commission_refund_obligation",
          sourceId: row.id, policyRevisionId: null, requestId: command.requestId, at });
        return result;
      }, receiptDeadline);
    },
    async listForViewer(command: Readonly<{ actor: Actor; orderId: string }>) {
      record(command, ["actor", "orderId"]); actorValid(command.actor); if (!uuid(command.orderId)) refundFail("invalid_request");
      return boundary(() => input.db.transaction(async (tx) => {
        const startedAt = now(); const [candidate] = await tx.select().from(commissionRefundObligations).where(eq(commissionRefundObligations.orderId, command.orderId)).limit(1);
        const ownedRow = party(candidate, command.actor); await input.lockCreator(tx, ownedRow.creatorUserId);
        const proof = await session(tx, command.actor, now(), false);
        const rows = await port.listForOrder(tx, { orderId: command.orderId });
        const result = [];
        for (const row of rows) {
          await owned(tx, row.obligationId, command.actor);
          const sends = await tx.select().from(commissionRefundSends).where(eq(commissionRefundSends.obligationId, row.obligationId))
            .orderBy(asc(commissionRefundSends.recordedAt), asc(commissionRefundSends.id));
          result.push({ ...row, dueAt: row.dueAt?.toISOString() ?? null, confirmBy: row.confirmBy?.toISOString() ?? null,
            endedAt: row.endedAt?.toISOString() ?? null, destinationPurgedAt: row.destinationPurgedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
            sends: sends.map((send) => ({ id: send.id, transferDate: send.transferDate, recordedAt: send.recordedAt.toISOString(),
              bankReference: decryptSensitiveField({ keyring: input.keyring, envelope: send.referenceEnvelope,
                binding: { recordType: "commission_refund_send", recordId: send.id, fieldName: "bank_reference" } }),
              note: send.noteEnvelope === null ? null : decryptSensitiveField({ keyring: input.keyring, envelope: send.noteEnvelope,
                binding: { recordType: "commission_refund_send", recordId: send.id, fieldName: "note" } }) })) });
        }
        await recheck(tx, command.actor, startedAt, proof, false); return result;
      }));
    },
  };
}
export type CommissionRefundService = ReturnType<typeof createCommissionRefundService>;
