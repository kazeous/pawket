import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand,
  platformTipPolicyCurrent, platformTipPolicyRevisions,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 2_147_483_647;

export type PlatformTipPolicySnapshot = Readonly<{
  revisionId: string; revisionNumber: number; minimumVnd: number; maximumVnd: number;
  allowedPresetsVnd: readonly number[]; effectiveAt: string;
}>;
export type PlatformTipPolicyPort = {
  readPolicy(tx: PawketTransaction): Promise<PlatformTipPolicySnapshot | null>;
};
export type PlatformTipPolicyHistoryEntry = PlatformTipPolicySnapshot & Readonly<{
  origin: "system_bootstrap" | "owner"; actorUserId: string | null; reason: string;
  previousPolicy: PlatformTipPolicySnapshot | null;
}>;
export type PlatformTipPolicyActor = Readonly<{ userId: string; sessionId: string }>;
export type PlatformTipPolicySaveCommand = Readonly<{
  actor: PlatformTipPolicyActor; expectedRevision: number;
  minimumVnd: number; maximumVnd: number; allowedPresetsVnd: unknown;
  reason: string; idempotencyKey: string; requestId: string;
}>;
export class PlatformTipPolicyError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "FORBIDDEN" | "OWNER_STEP_UP_REQUIRED" | "POLICY_UNAVAILABLE" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT") {
    super(code);
    this.name = "PlatformTipPolicyError";
  }
}
function fail(code: PlatformTipPolicyError["code"]): never { throw new PlatformTipPolicyError(code); }
function validateActor(actor: PlatformTipPolicyActor) {
  if (!actor || !identifier(actor.userId) || !identifier(actor.sessionId)) fail("INVALID_REQUEST");
}
function validAmounts(minimum: unknown, maximum: unknown, presets: unknown): presets is number[] {
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) &&
    (minimum as number) >= 10_000 && (maximum as number) <= 5_000_000 && (maximum as number) >= (minimum as number) &&
    Array.isArray(presets) && presets.length >= 3 && presets.length <= 10 && new Set(presets).size === presets.length &&
    presets.every((amount: unknown) => Number.isSafeInteger(amount) && (amount as number) >= (minimum as number) && (amount as number) <= (maximum as number));
}
const snapshotKeys = ["revisionId", "revisionNumber", "minimumVnd", "maximumVnd", "allowedPresetsVnd", "effectiveAt"] as const;
export function readPlatformTipPolicySnapshot(value: unknown): PlatformTipPolicySnapshot | null {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== snapshotKeys.length ||
    !snapshotKeys.every((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property && "value" in property;
    })) return null;
  const revision = value as Record<string, unknown>;
  const amounts = revision.allowedPresetsVnd;
  if (!Array.isArray(amounts) || amounts.length < 3 || amounts.length > 10 || Object.getPrototypeOf(amounts) !== Array.prototype ||
    Reflect.ownKeys(amounts).length !== amounts.length + 1 ||
    !Array.from({ length: amounts.length }, (_, i) => Object.getOwnPropertyDescriptor(amounts, String(i)))
      .every((property) => property && "value" in property)) return null;
  if (!isUuid(revision.revisionId) || !validRevision(revision.revisionNumber) ||
    !validAmounts(revision.minimumVnd, revision.maximumVnd, revision.allowedPresetsVnd) ||
    typeof revision.effectiveAt !== "string" || !Number.isFinite(Date.parse(revision.effectiveAt)) ||
    new Date(revision.effectiveAt).toISOString() !== revision.effectiveAt) return null;
  return Object.freeze({ revisionId: revision.revisionId, revisionNumber: revision.revisionNumber,
    minimumVnd: revision.minimumVnd as number, maximumVnd: revision.maximumVnd as number,
    allowedPresetsVnd: Object.freeze([...revision.allowedPresetsVnd]), effectiveAt: revision.effectiveAt });
}
function snapshot(revision: typeof platformTipPolicyRevisions.$inferSelect): PlatformTipPolicySnapshot | null {
  if (!(revision.effectiveAt instanceof Date) || !Number.isFinite(revision.effectiveAt.getTime())) return null;
  return readPlatformTipPolicySnapshot({ revisionId: revision.id, revisionNumber: revision.revisionNumber,
    minimumVnd: revision.minimumVnd, maximumVnd: revision.maximumVnd, allowedPresetsVnd: revision.allowedPresetsVnd,
    effectiveAt: revision.effectiveAt.toISOString() });
}
async function policy(tx: PawketTransaction, lock: "share" | "update"): Promise<PlatformTipPolicySnapshot | null> {
  // Fence precedes creator page/account/Identity locks in every new command.
  const [pointer] = await tx.select().from(platformTipPolicyCurrent).where(eq(platformTipPolicyCurrent.singleton, true)).limit(1).for(lock);
  if (!pointer) return null;
  const [revision] = await tx.select().from(platformTipPolicyRevisions).where(eq(platformTipPolicyRevisions.id, pointer.revisionId)).limit(1);
  return revision ? snapshot(revision) : null;
}
export function createPlatformTipPolicyReadPort(): PlatformTipPolicyPort {
  return { readPolicy: (tx) => policy(tx, "share") };
}

type Input = Readonly<{
  db: PawketDatabase; applicationRevision: string; commandFingerprintKey: Uint8Array;
  authorizeOwner(tx: PawketTransaction, actor: PlatformTipPolicyActor & { now: Date }): Promise<boolean>;
  requireOwnerStepUp(tx: PawketTransaction, actor: PlatformTipPolicyActor & { now: Date }): Promise<boolean>;
  now?: () => Date; idFactory?: () => string;
}>;

export function createPlatformTipPolicyService(input: Input) {
  if (!identifier(input.applicationRevision) || !(input.commandFingerprintKey instanceof Uint8Array) || input.commandFingerprintKey.length < 32) fail("INVALID_REQUEST");
  const clock = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;
  function now(): Date {
    const at = clock();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail("INVALID_REQUEST");
    return at;
  }
  async function authorize(tx: PawketTransaction, actor: PlatformTipPolicyActor, at: Date) {
    if (await input.authorizeOwner(tx, { ...actor, now: at }) !== true) fail("FORBIDDEN");
  }
  return {
    readPolicy(tx: PawketTransaction) { return policy(tx, "share"); },
    async getPolicy(command: { actor: PlatformTipPolicyActor }): Promise<PlatformTipPolicySnapshot | null> {
      validateActor(command.actor);
      return input.db.transaction(async (tx) => {
        const current = await policy(tx, "share");
        await authorize(tx, command.actor, now());
        return current;
      });
    },
    async getHistory(command: { actor: PlatformTipPolicyActor; beforeRevision?: number; limit?: number }): Promise<Readonly<{
      revisions: readonly PlatformTipPolicyHistoryEntry[]; nextBeforeRevision: number | null;
    }>> {
      validateActor(command.actor);
      const limit = command.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        (command.beforeRevision !== undefined && !validRevision(command.beforeRevision))) fail("INVALID_REQUEST");
      return input.db.transaction(async (tx) => {
        await policy(tx, "share");
        await authorize(tx, command.actor, now());
        const rows = await tx.select().from(platformTipPolicyRevisions)
          .where(command.beforeRevision === undefined ? undefined : lt(platformTipPolicyRevisions.revisionNumber, command.beforeRevision))
          .orderBy(desc(platformTipPolicyRevisions.revisionNumber)).limit(limit + 1);
        const entries: PlatformTipPolicyHistoryEntry[] = [];
        for (const row of rows.slice(0, limit)) {
          const value = snapshot(row);
          if (!value) fail("POLICY_UNAVAILABLE");
          const [previous] = row.previousRevisionId ? await tx.select().from(platformTipPolicyRevisions).where(eq(platformTipPolicyRevisions.id, row.previousRevisionId)).limit(1) : [];
          const previousPolicy = previous ? snapshot(previous) : null;
          if (row.previousRevisionId && !previousPolicy) fail("POLICY_UNAVAILABLE");
          entries.push(Object.freeze({ ...value, origin: row.origin, actorUserId: row.actorUserId, reason: row.reason, previousPolicy }));
        }
        return { revisions: Object.freeze(entries), nextBeforeRevision: rows.length > limit ? entries.at(-1)!.revisionNumber : null };
      });
    },
    async savePolicy(command: PlatformTipPolicySaveCommand): Promise<PlatformTipPolicySnapshot> {
      validateActor(command.actor);
      if (!validRevision(command.expectedRevision) || !identifier(command.requestId) ||
        typeof command.idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) ||
        typeof command.reason !== "string" || command.reason.trim() !== command.reason ||
        Array.from(command.reason).length < 3 || Array.from(command.reason).length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(command.reason) ||
        !validAmounts(command.minimumVnd, command.maximumVnd, command.allowedPresetsVnd)) fail("INVALID_REQUEST");
      const presets = [...command.allowedPresetsVnd];
      const actor = { ...command.actor };
      const { expectedRevision, minimumVnd, maximumVnd, reason, idempotencyKey, requestId } = command;
      return input.db.transaction(async (tx) => {
        const startedAt = now();
        // Command -> exclusive policy -> authoritative owner/proof fence.
        const started = await beginIdempotentCommand(tx, {
          actorUserId: actor.userId, commandScope: "catalog.platform_tip_policy.set",
          keyHash: createLookupHmac({ key: input.commandFingerprintKey, context: "platform-tip-policy-key", value: idempotencyKey }),
          requestFingerprint: createLookupHmac({ key: input.commandFingerprintKey, context: "platform-tip-policy-command",
            value: JSON.stringify([actor.userId, expectedRevision, minimumVnd, maximumVnd, presets, reason]) }),
          now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000),
        });
        if (started.kind === "replay") {
          await authorize(tx, actor, now());
          const revisionId = /^platform-tip-policy-v1:([0-9a-f-]{36})$/u.exec(started.resultReference)?.[1];
          if (!isUuid(revisionId)) fail("IDEMPOTENCY_CONFLICT");
          const [revision] = await tx.select().from(platformTipPolicyRevisions).where(and(eq(platformTipPolicyRevisions.id, revisionId), eq(platformTipPolicyRevisions.actorUserId, actor.userId))).limit(1);
          const result = revision ? snapshot(revision) : null;
          if (!result) fail("IDEMPOTENCY_CONFLICT");
          return result;
        }
        if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
        const current = await policy(tx, "update");
        const at = now();
        await authorize(tx, actor, at);
        if (!current) fail("POLICY_UNAVAILABLE");
        if (current.revisionNumber !== expectedRevision) fail("VERSION_CONFLICT");
        if (await input.requireOwnerStepUp(tx, { ...actor, now: at }) !== true) fail("OWNER_STEP_UP_REQUIRED");
        const revisionId = id();
        if (!isUuid(revisionId)) fail("INVALID_REQUEST");
        // Compare in PostgreSQL: converting the previous timestamp to a JS Date
        // truncates its microseconds and can move evidence backwards on skew.
        const effectiveAt = sql`greatest(${at.toISOString()}::timestamptz,
          (select ${platformTipPolicyRevisions.effectiveAt} from ${platformTipPolicyRevisions}
            where ${platformTipPolicyRevisions.id} = ${current.revisionId}))`;
        const [revision] = await tx.insert(platformTipPolicyRevisions).values({
          id: revisionId, revisionNumber: current.revisionNumber + 1, previousRevisionId: current.revisionId,
          minimumVnd, maximumVnd, allowedPresetsVnd: presets, origin: "owner", actorUserId: actor.userId,
          actorSessionId: actor.sessionId, requestId, reason, effectiveAt,
        }).returning();
        const result = revision ? snapshot(revision) : null;
        if (!result) fail("POLICY_UNAVAILABLE");
        await tx.update(platformTipPolicyCurrent).set({ revisionId,
          updatedAt: sql`(select ${platformTipPolicyRevisions.effectiveAt} from ${platformTipPolicyRevisions}
            where ${platformTipPolicyRevisions.id} = ${revisionId})`,
        }).where(eq(platformTipPolicyCurrent.singleton, true));
        await appendAdminAuditEvent(tx, {
          actorUserId: actor.userId, actorSessionId: actor.sessionId, subjectType: "platform_tip_policy", subjectId: revisionId,
          action: "platform.tip_policy.updated", outcome: "succeeded", reasonCode: "owner_policy_change",
          beforeState: { ...current }, afterState: { ...result }, assurance: { method: "owner_step_up" },
          applicationRevision: input.applicationRevision, requestId, occurredAt: at,
        });
        if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `platform-tip-policy-v1:${revisionId}`, completedAt: at })) fail("IDEMPOTENCY_CONFLICT");
        return result;
      });
    },
  };
}
