import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type { CreatorTipEligibility, CreatorTipEligibilityPort } from "@pawket/catalog";
import { appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, tips, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { requireIntegerVnd, TipPaymentError, type TipCreationPaymentResult, type TipPaymentIntentPort } from "@pawket/payments";
import { createLookupHmac, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { and, eq } from "drizzle-orm";

import { normalizeTipGuestContent } from "./guest-content.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identifier = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && v.trim() === v && UUID.test(v);
const handle = (v: unknown): v is string => typeof v === "string" && v.length >= 3 && v.length <= 30 && v.trim() === v && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v);
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }

// Trust only the explicit Catalog contract; reject accessors and expanded ports.
function eligibility(value: unknown): CreatorTipEligibility | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = ["creatorUserId", "pageId", "publicationRevisionId", "canonicalHandle", "displayName", "settingRevisionId", "minimumVnd", "maximumVnd", "presetsVnd", "receivingAccountVersionId"];
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const safe: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key]; if (!field || !field.enumerable || !("value" in field)) return null;
    safe[key] = field.value;
  }
  if (!identifier(safe.creatorUserId) || !isUuid(safe.pageId) || !isUuid(safe.publicationRevisionId) || !isUuid(safe.settingRevisionId) || !isUuid(safe.receivingAccountVersionId) ||
    !handle(safe.canonicalHandle) || typeof safe.displayName !== "string" || Array.from(safe.displayName).length < 1 || Array.from(safe.displayName).length > 80 ||
    typeof safe.minimumVnd !== "number" || typeof safe.maximumVnd !== "number" || !Number.isSafeInteger(safe.minimumVnd) || !Number.isSafeInteger(safe.maximumVnd) || safe.minimumVnd < 10_000 || safe.maximumVnd > 5_000_000 || safe.minimumVnd > safe.maximumVnd ||
    !Array.isArray(safe.presetsVnd) || nodeTypes.isProxy(safe.presetsVnd) || safe.presetsVnd.length !== 3 || new Set(safe.presetsVnd).size !== 3 ||
    safe.presetsVnd.some((v) => !Number.isSafeInteger(v) || v < (safe.minimumVnd as number) || v > (safe.maximumVnd as number))) return null;
  return Object.freeze({ ...safe, presetsVnd: Object.freeze([...safe.presetsVnd]) }) as CreatorTipEligibility;
}

export type TipCreationPrincipal = Readonly<{ kind: "guest"; context: string }> | Readonly<{ kind: "buyer"; userId: string }>;
export type CreateTipCommand = Readonly<{
  principal: TipCreationPrincipal; canonicalHandle: string; amountVnd: unknown; name?: unknown; message?: unknown;
  abuseKeyHash: string; idempotencyKey: string; requestId: string;
}>;
type Input = Readonly<{
  db: PawketDatabase; creatorEligibility: CreatorTipEligibilityPort; payments: TipPaymentIntentPort;
  buyerAccounts: { isActiveTipBuyerAccount(tx: PawketTransaction, userId: string): Promise<boolean> };
  paymentsMode: "disabled" | "manual_only"; publishingMode: "disabled" | "general_audience";
  keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; idempotencyTtlMs: number;
  now?: () => Date; idFactory?: () => string;
}>;

export function createTipService(input: Input) {
  if (!Number.isSafeInteger(input.idempotencyTtlMs) || input.idempotencyTtlMs < 3_600_000 || input.idempotencyTtlMs > 2_592_000_000) fail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey);
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  const clock = input.now ?? (() => new Date()); const id = input.idFactory ?? randomUUID;
  const now = () => { const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail("dependency_unavailable"); return new Date(at); };
  return {
    async createTip(command: CreateTipCommand): Promise<TipCreationPaymentResult> {
      try {
        if (input.paymentsMode !== "manual_only" || input.publishingMode !== "general_audience") fail("payments_disabled");
        if (!handle(command.canonicalHandle) || !identifier(command.requestId) ||
          typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim() !== command.idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) ||
          typeof command.abuseKeyHash !== "string" || command.abuseKeyHash.trim() !== command.abuseKeyHash || !/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u.test(command.abuseKeyHash)) fail("invalid_request");
        const principal = command.principal;
        if (!principal || (principal.kind !== "guest" && principal.kind !== "buyer") ||
          (principal.kind === "guest" && (typeof principal.context !== "string" || principal.context.trim() !== principal.context || !/^[A-Za-z0-9_-]{43}$/u.test(principal.context))) ||
          (principal.kind === "buyer" && !identifier(principal.userId))) fail("not_authorized");
        const buyerUserId = principal.kind === "buyer" ? principal.userId : null;
        const guestContext = principal.kind === "guest" ? principal.context : null;
        const actor = `${principal.kind}:${digest("tip-create-actor", buyerUserId ?? guestContext!)}`;
        const amountVnd = requireIntegerVnd(command.amountVnd, { minimumVnd: 10_000, maximumVnd: 5_000_000 });
        const content = normalizeTipGuestContent(command);
        const canonicalHandle = command.canonicalHandle; const abuseKeyHash = command.abuseKeyHash; const requestId = command.requestId;
        const keyHash = digest("tip-create-command-key", command.idempotencyKey);
        const requestFingerprint = digest("tip-create-command", JSON.stringify([actor, canonicalHandle, amountVnd, content.name, content.message]));
        return await input.db.transaction(async (tx) => {
          const startedAt = now();
          const started = await beginIdempotentCommand(tx, { actorUserId: actor, commandScope: "tips.create", keyHash, requestFingerprint,
            expiresAt: new Date(startedAt.getTime() + input.idempotencyTtlMs), now: startedAt });
          if (started.kind !== "acquired" && started.kind !== "replay") fail("idempotency_conflict");
          await input.payments.lockCreationAbuseKey(tx, abuseKeyHash);
          const creator = eligibility(await input.creatorEligibility.getTipEligibility(tx, canonicalHandle));
          if (!creator || creator.canonicalHandle !== canonicalHandle) fail("not_available");
          if (buyerUserId && await input.buyerAccounts.isActiveTipBuyerAccount(tx, buyerUserId) !== true) fail("not_authorized");
          const at = now();
          if (at < startedAt) fail("dependency_unavailable");
          requireIntegerVnd(amountVnd, creator);
          if (started.kind === "replay") {
            const tipId = /^tip-created-v1:([0-9a-f-]{36})$/u.exec(started.resultReference)?.[1];
            if (!isUuid(tipId)) fail("idempotency_conflict");
            const [tip] = await tx.select().from(tips).where(and(eq(tips.id, tipId), eq(tips.creatorUserId, creator.creatorUserId))).limit(1);
            if (!tip || tip.buyerUserId !== buyerUserId || tip.amountVnd !== amountVnd) fail("idempotency_conflict");
            return input.payments.replayIntent(tx, { tipId, creatorUserId: creator.creatorUserId, accountVersionId: creator.receivingAccountVersionId, guestContext, at });
          }
          await input.payments.assertOpenCapacity(tx, { creatorUserId: creator.creatorUserId, abuseKeyHash, at });
          const tipId = id(); if (!isUuid(tipId)) fail("dependency_unavailable");
          await tx.insert(tips).values({ id: tipId, creatorUserId: creator.creatorUserId, buyerUserId, settingRevisionId: creator.settingRevisionId, amountVnd,
            guestContentEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: JSON.stringify(content), binding: { recordType: "tips", recordId: tipId, fieldName: "guest_content" } }),
            createdAt: at, updatedAt: at });
          const result = await input.payments.createIntent(tx, { tipId, creatorUserId: creator.creatorUserId, accountVersionId: creator.receivingAccountVersionId,
            amountVnd, creator: { displayName: creator.displayName, handle: creator.canonicalHandle }, guestContext, abuseKeyHash, requestId, at });
          await appendAdminAuditEvent(tx, { actorUserId: buyerUserId ?? "guest", subjectType: "tip", subjectId: tipId,
            action: "tip.created", outcome: "succeeded", afterState: { state: "awaiting_payment", creatorUserId: creator.creatorUserId },
            assurance: { method: buyerUserId ? "buyer_session" : "guest_context" }, applicationRevision: "increment-4", requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: "tip.created.v1", eventVersion: 1, aggregateType: "tip", aggregateId: tipId,
            payload: { tipId, creatorUserId: creator.creatorUserId, correlationId: requestId }, occurredAt: at });
          if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `tip-created-v1:${tipId}`, completedAt: at })) fail("idempotency_conflict");
          return result;
        });
      } catch (error) {
        if (error instanceof TipPaymentError) throw error;
        // Database errors may include query parameters. Never expose their message
        // or cause to HTTP/log adapters; the stable code is the only boundary.
        return fail("dependency_unavailable");
      }
    },
  };
}
