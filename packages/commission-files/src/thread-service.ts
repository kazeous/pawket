import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { and, eq } from "drizzle-orm";
import { beginIdempotentCommand, commissionMessages, commissionThreadEntries, completeIdempotentCommand, insertOutboxEvent,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";

import { COMMISSION_FILE_POLICY, CommissionFileError, commissionFileFail, commissionFileUuid } from "./file-policy.js";
import { normalizeCommissionMessageText } from "./message-text.js";
import type { CommissionFileActor, CommissionFileOrderAccessPort, CommissionFileSessionPort } from "./ports.js";
import { createCommissionThreadPort } from "./thread-port.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; filesMode: "disabled" | "enabled"; fulfillmentMode: "disabled" | "enabled";
  sessions: CommissionFileSessionPort; orders: Pick<CommissionFileOrderAccessPort, "lockFulfillmentOrder">; now?: () => Date; idFactory?: () => string;
}>;

function messageFileIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > COMMISSION_FILE_POLICY.maxMessageFiles || Reflect.ownKeys(value).length !== value.length + 1) commissionFileFail("invalid_request");
  const fields = Object.getOwnPropertyDescriptors(value); const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = fields[String(index)];
    if (!field || !field.enumerable || !("value" in field) || !commissionFileUuid(field.value)) commissionFileFail("invalid_request");
    ids.push(field.value);
  }
  return ids;
}

export function createCommissionThreadService(input: Input) {
  if (input.lookupHmacKey.byteLength < 32) throw new Error("Commission thread service requires a 32-byte lookup key");
  const key = new Uint8Array(input.lookupHmacKey); const now = input.now ?? (() => new Date()); const newId = input.idFactory ?? randomUUID;
  const thread = createCommissionThreadPort({ keyring: input.keyring, mode: input.filesMode });
  async function session(tx: PawketTransaction, actor: CommissionFileActor): Promise<Date> {
    const at = now(); const proof = await input.sessions.getTipSessionAssurance(tx, actor, at);
    if (!proof || !(proof.sessionExpiresAt instanceof Date) || !(proof.sessionExpiresAt > at)) commissionFileFail("not_authorized");
    return proof.sessionExpiresAt;
  }
  return {
    async sendMessage(command: Readonly<{ actor: CommissionFileActor; orderId: string; text: unknown; fileIds: unknown; idempotencyKey: string; requestId: string }>): Promise<Readonly<{ messageId: string; sequence: number }>> {
      const actor = command.actor;
      if (!actor || typeof actor.userId !== "string" || !IDENTIFIER.test(actor.userId) || typeof actor.sessionId !== "string" || !IDENTIFIER.test(actor.sessionId)) commissionFileFail("not_authorized");
      if (!commissionFileUuid(command.orderId) || typeof command.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(command.idempotencyKey) ||
        typeof command.requestId !== "string" || !IDENTIFIER.test(command.requestId)) commissionFileFail("invalid_request");
      const text = normalizeCommissionMessageText(command.text); const fileIds = messageFileIds(command.fileIds);
      if (input.fulfillmentMode !== "enabled" || input.filesMode !== "enabled") commissionFileFail("fulfillment_disabled");
      try {
        return await input.db.transaction(async (tx) => {
          const startedAt = now();
          const started = await beginIdempotentCommand(tx, { actorUserId: actor.userId, commandScope: "commission-files.message",
            keyHash: createLookupHmac({ key, context: "commission-file-command-key", value: command.idempotencyKey }),
            requestFingerprint: createLookupHmac({ key, context: "commission-file-command", value: JSON.stringify([command.orderId, text, fileIds]) }),
            now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
          if (started.kind !== "acquired" && started.kind !== "replay") commissionFileFail("idempotency_conflict");
          const order = await input.orders.lockFulfillmentOrder(tx, { orderId: command.orderId, actorUserId: actor.userId });
          if (!order) commissionFileFail("not_available");
          const sessionExpiresAt = await session(tx, actor);
          if (started.kind === "replay") {
            const [recorded] = await tx.select({ messageId: commissionMessages.id, sequence: commissionThreadEntries.sequence }).from(commissionMessages)
              .innerJoin(commissionThreadEntries, and(eq(commissionThreadEntries.entryId, commissionMessages.id), eq(commissionThreadEntries.kind, "message"), eq(commissionThreadEntries.orderId, commissionMessages.orderId)))
              .where(and(eq(commissionMessages.id, started.resultReference), eq(commissionMessages.orderId, command.orderId), eq(commissionMessages.authorUserId, actor.userId))).limit(1);
            if (!recorded) commissionFileFail("dependency_unavailable");
            if (!(sessionExpiresAt > now())) commissionFileFail("not_authorized");
            return recorded;
          }
          if (order.state !== "in_progress" && order.state !== "delivered") commissionFileFail("invalid_state");
          if (text === null && fileIds.length === 0) commissionFileFail("invalid_request");
          const messageId = newId(); if (!commissionFileUuid(messageId)) commissionFileFail("dependency_unavailable");
          const at = now();
          await tx.insert(commissionMessages).values({ id: messageId, orderId: command.orderId, authorUserId: actor.userId, authorSessionId: actor.sessionId,
            textEnvelope: text === null ? null : encryptSensitiveField({ keyring: input.keyring, plaintext: text, binding: { recordType: "commission_messages", recordId: messageId, fieldName: "text" } }),
            requestId: command.requestId, createdAt: at });
          const attached = await thread.attachOrderFiles(tx, { orderId: command.orderId, ownerUserId: actor.userId, context: "thread",
            target: { kind: "message", id: messageId }, fileIds, at });
          if (attached === "disabled") commissionFileFail("fulfillment_disabled");
          if (attached !== "attached") commissionFileFail("invalid_attachment_files");
          const sequence = await thread.appendEntry(tx, { orderId: command.orderId, kind: "message", entryId: messageId, at });
          await insertOutboxEvent(tx, { eventType: "commission.message_sent.v1", eventVersion: 1, aggregateType: "commission_order", aggregateId: command.orderId,
            payload: { orderId: command.orderId, messageId, sequence, correlationId: command.requestId }, occurredAt: at });
          const completedAt = now();
          if (completedAt < startedAt || completedAt < at || !(sessionExpiresAt > completedAt)) commissionFileFail("not_authorized");
          if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: messageId, completedAt })) commissionFileFail("idempotency_conflict");
          return { messageId, sequence };
        });
      } catch (error) {
        if (error instanceof CommissionFileError) throw error;
        return commissionFileFail("dependency_unavailable");
      }
    },
  };
}
export type CommissionThreadService = ReturnType<typeof createCommissionThreadService>;
