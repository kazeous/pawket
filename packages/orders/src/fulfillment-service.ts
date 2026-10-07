import { types as nodeTypes } from "node:util";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { commissionFulfillmentPauses, commissionOrders, commissionSubmissions, commissionTermsSnapshots, insertOutboxEvent,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { commissionFail, type CommissionActor, type CommissionState } from "./contracts.js";
import { commissionCompletionDueAt, commissionReviewEndsAt } from "./fulfillment-timing.js";
import { requireCommissionTransition } from "./lifecycle.js";
import { lockCommissionCreator } from "./payment-lifecycle.js";
import { COMMISSION_FULFILLMENT_POLICY, commissionIdentifier, commissionInteger, commissionPlainText, commissionUuid, requireCommissionBeforeDeadline } from "./policy.js";
import { noCommissionCompletionHolds, type CommissionAttachedFileView, type CommissionCompletionHoldPort, type CommissionThreadPort } from "./ports.js";
import type { createCommissionOrderPersistence } from "./order-persistence.js";

type Order = typeof commissionOrders.$inferSelect;
type Persistence = ReturnType<typeof createCommissionOrderPersistence>;
type Command = Readonly<{ actor: CommissionActor; idempotencyKey: string; requestId: string }>;
type ExistingCommand = Command & Readonly<{ orderId: string; expectedVersion: number }>;
type Change = Readonly<{ orderId: string; at: Date; guardUntil?: Date }>;
type Kit = Readonly<{
  mutate(command: Command, scope: string, payload: unknown, creator: (tx: PawketTransaction) => Promise<string>, apply: (tx: PawketTransaction) => Promise<Change>): Promise<string>;
  owned(tx: PawketTransaction, orderId: string, actor: CommissionActor): Promise<Order>;
  session(tx: PawketTransaction, actor: CommissionActor): Promise<Date>;
  record: Persistence["record"]; boundary<T>(run: () => Promise<T>): Promise<T>; now(): Date; newId(): string;
}>;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; fulfillmentMode: "disabled" | "enabled";
  thread?: CommissionThreadPort; holds?: CommissionCompletionHoldPort; completeCommissionOrder: Persistence["completeCommissionOrder"];
}>;
type SubmissionKind = "draft" | "final";
type SubmissionResponse = "approved" | "changes_requested" | "superseded";
export type CommissionMessageItem = Readonly<{
  sequence: number; kind: "message"; id: string; author: "buyer" | "creator"; text: string | null;
  files: readonly CommissionAttachedFileView[]; createdAt: string;
}>;
export type CommissionSubmissionItem = Readonly<{
  sequence: number; kind: "submission"; id: string; submissionKind: SubmissionKind; note: string | null;
  files: readonly CommissionAttachedFileView[]; submittedAt: string; late: boolean; response: SubmissionResponse | null;
  responseNote: string | null; respondedAt: string | null; actionable: boolean;
}>;
export type CommissionThreadView = Readonly<{ items: readonly (CommissionMessageItem | CommissionSubmissionItem)[]; nextBeforeSequence: number | null; writable: boolean }>;

/** Read pauses in the same transaction as the order projection or command. */
export async function readCommissionCompletionDueAt(tx: PawketTransaction, order: Readonly<{ reviewEndsAt: Date; completionFloorAt: Date | null }>): Promise<Date | null> {
  const base = order.completionFloorAt && order.completionFloorAt > order.reviewEndsAt ? order.completionFloorAt : order.reviewEndsAt;
  const pauses = await tx.select({ startedAt: commissionFulfillmentPauses.startedAt, endedAt: commissionFulfillmentPauses.endedAt })
    .from(commissionFulfillmentPauses).where(or(isNull(commissionFulfillmentPauses.endedAt), gt(commissionFulfillmentPauses.endedAt, base)));
  return commissionCompletionDueAt(base, pauses);
}
function existingValid(command: ExistingCommand) {
  if (!commissionUuid(command.orderId)) commissionFail("invalid_request");
  commissionInteger(command.expectedVersion, 1, 2_147_483_646);
}
function submissionFileIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 || value.length > COMMISSION_FULFILLMENT_POLICY.maximumSubmissionFiles || Reflect.ownKeys(value).length !== value.length + 1) commissionFail("invalid_request");
  const fields = Object.getOwnPropertyDescriptors(value); const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = fields[String(index)];
    if (!field || !field.enumerable || !("value" in field) || !commissionUuid(field.value)) commissionFail("invalid_request");
    ids.push(field.value);
  }
  if (new Set(ids).size !== ids.length) commissionFail("invalid_request");
  return Object.freeze(ids);
}
const normalizeNote = (value: unknown, minimum = 0): string | null => commissionPlainText(value ?? "", minimum, COMMISSION_FULFILLMENT_POLICY.maximumNoteCodePoints) || null;

export function createCommissionFulfillmentService(kit: Kit, input: Input) {
  const holds = input.holds ?? noCommissionCompletionHolds;
  function enabled(): CommissionThreadPort {
    if (input.fulfillmentMode !== "enabled" || !input.thread) commissionFail("fulfillment_disabled");
    return input.thread;
  }
  const creator = (command: ExistingCommand) => async (tx: PawketTransaction) => (await kit.owned(tx, command.orderId, command.actor)).creatorUserId;
  const noteEnvelope = (id: string, note: string | null) => note === null ? null : encryptSensitiveField({ keyring: input.keyring, plaintext: note,
    binding: { recordType: "commission_submissions", recordId: id, fieldName: "note" } });
  const responseNoteEnvelope = (id: string, note: string | null) => note === null ? null : encryptSensitiveField({ keyring: input.keyring, plaintext: note,
    binding: { recordType: "commission_submissions", recordId: id, fieldName: "response_note" } });
  return {
    async submit(command: ExistingCommand & Readonly<{ kind: SubmissionKind; note: unknown; fileIds: unknown }>): Promise<string> {
      const thread = enabled(); existingValid(command);
      if (command.kind !== "draft" && command.kind !== "final") commissionFail("invalid_request");
      const note = normalizeNote(command.note); const fileIds = submissionFileIds(command.fileIds);
      return kit.mutate(command, "submit", [command.orderId, command.expectedVersion, command.kind, note, fileIds], creator(command), async (tx) => {
        const order = await kit.owned(tx, command.orderId, command.actor);
        if (order.creatorUserId !== command.actor.userId) commissionFail("not_authorized");
        if (order.version !== command.expectedVersion) commissionFail("version_conflict");
        if (order.state !== "in_progress") commissionFail("invalid_transition");
        if (await holds.hasOpenDispute(tx, order.id)) commissionFail("dispute_open");
        const [snapshot] = await tx.select().from(commissionTermsSnapshots).where(eq(commissionTermsSnapshots.orderId, order.id)).limit(1);
        if (!snapshot) commissionFail("dependency_unavailable");
        const at = kit.now(); const submissionId = kit.newId();
        await tx.update(commissionSubmissions).set({ response: "superseded", respondedAt: at })
          .where(and(eq(commissionSubmissions.orderId, order.id), eq(commissionSubmissions.kind, "draft"), isNull(commissionSubmissions.response)));
        await tx.insert(commissionSubmissions).values({ id: submissionId, orderId: order.id, kind: command.kind, noteEnvelope: noteEnvelope(submissionId, note),
          actorSessionId: command.actor.sessionId, requestId: command.requestId, submittedAt: at });
        const attached = await thread.attachOrderFiles(tx, { orderId: order.id, ownerUserId: order.creatorUserId, context: "submission",
          target: { kind: "submission", id: submissionId }, fileIds, at });
        if (attached === "disabled") commissionFail("fulfillment_disabled");
        if (attached !== "attached") commissionFail("invalid_attachment_files");
        const sequence = await thread.appendEntry(tx, { orderId: order.id, kind: "submission", entryId: submissionId, at });
        await insertOutboxEvent(tx, { eventType: "commission.submission_sent.v1", eventVersion: 1, aggregateType: "commission_order", aggregateId: order.id,
          payload: { orderId: order.id, submissionId, kind: command.kind, sequence, correlationId: command.requestId }, occurredAt: at });
        if (command.kind === "final") {
          requireCommissionTransition(order.state as CommissionState, "delivered");
          const [delivered] = await tx.update(commissionOrders).set({ state: "delivered", deliveredAt: at, reviewEndsAt: commissionReviewEndsAt(at, snapshot.reviewWindowDays),
            version: order.version + 1, updatedAt: at }).where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version))).returning();
          if (!delivered) commissionFail("version_conflict");
          await kit.record(tx, delivered, command.actor, command.requestId, null);
        }
        return { orderId: order.id, at };
      });
    },
    async respondToSubmission(command: ExistingCommand & Readonly<{ submissionId: string; response: "approve" | "request_changes" | "accept"; note: unknown }>): Promise<string> {
      enabled(); existingValid(command);
      if (!commissionUuid(command.submissionId) || !["approve", "request_changes", "accept"].includes(command.response)) commissionFail("invalid_request");
      const note = normalizeNote(command.note, command.response === "request_changes" ? 1 : 0);
      return kit.mutate(command, "respond-to-submission", [command.orderId, command.expectedVersion, command.submissionId, command.response, note], creator(command), async (tx) => {
        const order = await kit.owned(tx, command.orderId, command.actor);
        if (order.buyerUserId !== command.actor.userId) commissionFail("not_authorized");
        if (order.version !== command.expectedVersion) commissionFail("version_conflict");
        const [submission] = await tx.select().from(commissionSubmissions).where(and(eq(commissionSubmissions.orderId, order.id), eq(commissionSubmissions.id, command.submissionId))).limit(1);
        if (!submission || submission.response !== null ||
          (submission.kind === "draft" ? order.state !== "in_progress" || command.response === "accept" : order.state !== "delivered" || command.response === "approve")) commissionFail("invalid_transition");
        const at = kit.now(); let guardUntil: Date | undefined;
        if (submission.kind === "final") {
          if (!order.reviewEndsAt) commissionFail("invalid_transition");
          const due = await readCommissionCompletionDueAt(tx, { reviewEndsAt: order.reviewEndsAt, completionFloorAt: order.completionFloorAt });
          if (due === null) commissionFail("fulfillment_disabled");
          requireCommissionBeforeDeadline(at, due); guardUntil = due;
        }
        if (command.response === "accept") {
          if (await holds.hasActiveCompletionHold(tx, order.id)) commissionFail("completion_held");
          await input.completeCommissionOrder(tx, order, "buyer_accepted", command.actor, command.requestId, at);
          return { orderId: order.id, at, guardUntil };
        }
        if (await holds.hasOpenDispute(tx, order.id)) commissionFail("dispute_open");
        const [snapshot] = await tx.select().from(commissionTermsSnapshots).where(eq(commissionTermsSnapshots.orderId, order.id)).limit(1);
        if (!snapshot) commissionFail("dependency_unavailable");
        if (command.response === "request_changes" && order.revisionsUsed >= snapshot.revisionAllowance) commissionFail("revisions_exhausted");
        const response = command.response === "approve" ? "approved" : "changes_requested";
        await tx.update(commissionSubmissions).set({ response, respondedAt: at, responseSessionId: command.actor.sessionId, responseRequestId: command.requestId,
          responseNoteEnvelope: response === "changes_requested" ? responseNoteEnvelope(submission.id, note) : null })
          .where(and(eq(commissionSubmissions.id, submission.id), isNull(commissionSubmissions.response)));
        if (response === "changes_requested") {
          requireCommissionTransition(order.state as CommissionState, "in_progress");
          const [reopened] = await tx.update(commissionOrders).set({ state: "in_progress", revisionsUsed: order.revisionsUsed + 1, deliveredAt: null, reviewEndsAt: null, completionFloorAt: null,
            version: order.version + 1, updatedAt: at }).where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version))).returning();
          if (!reopened) commissionFail("version_conflict");
          await kit.record(tx, reopened, command.actor, command.requestId, submission.kind === "draft" ? "draft_changes_requested" : "final_changes_requested");
        }
        await insertOutboxEvent(tx, { eventType: "commission.submission_responded.v1", eventVersion: 1, aggregateType: "commission_order", aggregateId: order.id,
          payload: { orderId: order.id, submissionId: submission.id, response, correlationId: command.requestId }, occurredAt: at });
        return { orderId: order.id, at, guardUntil };
      });
    },
    async getThread(command: Readonly<{ actor: CommissionActor; orderId: string; beforeSequence?: number; limit?: number }>): Promise<CommissionThreadView> {
      const thread = input.thread; if (!thread) commissionFail("fulfillment_disabled");
      if (!command.actor || !commissionIdentifier(command.actor.userId) || !commissionIdentifier(command.actor.sessionId) || !commissionUuid(command.orderId)) commissionFail("not_authorized");
      const limit = commissionInteger(command.limit ?? 25, 1, 50);
      if (command.beforeSequence !== undefined) commissionInteger(command.beforeSequence, 1, 2_147_483_647);
      return kit.boundary(() => input.db.transaction(async (tx) => {
        const candidate = await kit.owned(tx, command.orderId, command.actor); await lockCommissionCreator(tx, candidate.creatorUserId);
        const proofExpiry = await kit.session(tx, command.actor); const order = await kit.owned(tx, command.orderId, command.actor);
        if (!["in_progress", "delivered", "completed"].includes(order.state)) commissionFail("invalid_transition");
        const entries = await thread.listEntries(tx, { orderId: order.id, beforeSequence: command.beforeSequence, limit }); const page = entries.slice(0, limit);
        const submissionIds = page.filter((entry) => entry.kind === "submission").map((entry) => entry.entryId);
        const submissions = submissionIds.length ? await tx.select().from(commissionSubmissions)
          .where(and(eq(commissionSubmissions.orderId, order.id), inArray(commissionSubmissions.id, submissionIds))) : [];
        const byId = new Map(submissions.map((submission) => [submission.id, submission]));
        const messages = await thread.describeMessages(tx, { orderId: order.id, messageIds: page.filter((entry) => entry.kind === "message").map((entry) => entry.entryId) });
        const files = await thread.describeAttachedFiles(tx, { orderId: order.id, targets: page.map((entry) => ({ kind: entry.kind, id: entry.entryId })) });
        const due = order.reviewEndsAt ? await readCommissionCompletionDueAt(tx, { reviewEndsAt: order.reviewEndsAt, completionFloorAt: order.completionFloorAt }) : null;
        const at = kit.now(); if (proofExpiry <= at) commissionFail("not_authorized");
        const items = page.map((entry): CommissionMessageItem | CommissionSubmissionItem => {
          const attached = files.get(entry.kind + ":" + entry.entryId) ?? [];
          if (entry.kind === "message") {
            const message = messages.get(entry.entryId); if (!message) commissionFail("dependency_unavailable");
            return { sequence: entry.sequence, kind: "message", id: entry.entryId, author: message.authorUserId === order.buyerUserId ? "buyer" : "creator",
              text: message.text, files: attached, createdAt: message.createdAt.toISOString() };
          }
          const submission = byId.get(entry.entryId); if (!submission) commissionFail("dependency_unavailable");
          const note = submission.noteEnvelope === null ? null : decryptSensitiveField({ keyring: input.keyring, envelope: submission.noteEnvelope,
            binding: { recordType: "commission_submissions", recordId: submission.id, fieldName: "note" } });
          const responseNote = submission.responseNoteEnvelope === null ? null : decryptSensitiveField({ keyring: input.keyring, envelope: submission.responseNoteEnvelope,
            binding: { recordType: "commission_submissions", recordId: submission.id, fieldName: "response_note" } });
          return { sequence: entry.sequence, kind: "submission", id: submission.id, submissionKind: submission.kind as SubmissionKind, note, files: attached,
            submittedAt: submission.submittedAt.toISOString(), late: submission.kind === "final" && !!order.dueAt && submission.submittedAt > order.dueAt,
            response: submission.response as SubmissionResponse | null, responseNote, respondedAt: submission.respondedAt?.toISOString() ?? null,
            actionable: input.fulfillmentMode === "enabled" && command.actor.userId === order.buyerUserId && submission.response === null &&
              (submission.kind === "draft" ? order.state === "in_progress" : order.state === "delivered" && due !== null && at < due) };
        });
        return { items, nextBeforeSequence: entries.length > limit ? items.at(-1)!.sequence : null,
          writable: input.fulfillmentMode === "enabled" && (order.state === "in_progress" || order.state === "delivered") };
      }));
    },
  };
}
