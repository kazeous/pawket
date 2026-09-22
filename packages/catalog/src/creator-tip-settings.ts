import { randomUUID } from "node:crypto";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, creatorHandleClaims,
  creatorPages, creatorTipSettings, creatorTipSettingRevisions, insertOutboxEvent,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";
import { and, eq } from "drizzle-orm";

import type { CatalogActor } from "./catalog-service.js";
import type { createPublicCatalogQuery } from "./public-catalog-query.js";
import { readPlatformTipPolicySnapshot, type PlatformTipPolicySnapshot, type PlatformTipPolicyPort } from "./platform-tip-policy.js";
import { readExactOwnRecord } from "./runtime-boundary.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && value.trim() === value && UUID.test(value);

export type CreatorTipAmountPolicy = Readonly<{ minimumVnd: number; maximumVnd: number; allowedPresetsVnd: readonly number[] }>;
export type CreatorTipSettingsSnapshot = Readonly<{
  revisionId: string | null; revisionNumber: number; enabled: boolean;
  minimumVnd: number; maximumVnd: number; presetsVnd: readonly number[];
  platformPolicyRevisionId: string | null; effectivePolicy: PlatformTipPolicySnapshot | null;
  effectivePresetsVnd: readonly number[]; presetsFallback: boolean;
}>;
// Internal read port for the payment transaction, never the public JSON shape.
export type ExistingCreatorTipEligibility = Readonly<{
  creatorUserId: string; pageId: string; publicationRevisionId: string;
  canonicalHandle: string; displayName: string; settingRevisionId: string;
  receivingAccountVersionId: string;
}>;
export type CreatorTipEligibility = ExistingCreatorTipEligibility & Readonly<{
  minimumVnd: number; maximumVnd: number; presetsVnd: readonly number[];
  platformPolicyRevisionId: string;
}>;
export type CreatorTipEligibilityPort = {
  getTipEligibility(tx: PawketTransaction, canonicalHandle: string): Promise<CreatorTipEligibility | null>;
  getExistingTipEligibility(tx: PawketTransaction, canonicalHandle: string): Promise<ExistingCreatorTipEligibility | null>;
};
export type CreatorTipReceivingAccountPort = {
  getCurrentTipReceivingAccount(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<Readonly<{ accountVersionId: string }> | null>;
};
export type CreatorTipAccountPort = {
  isActiveTipCreatorAccount(tx: PawketTransaction, userId: string): Promise<boolean>;
};
export class CreatorTipSettingsError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_AVAILABLE" | "PAYMENTS_DISABLED" | "RECENT_AUTH_REQUIRED" | "INVALID_REQUEST" | "INVALID_POLICY" | "POLICY_CHANGED" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT") {
    super(code);
    this.name = "CreatorTipSettingsError";
  }
}
function fail(code: CreatorTipSettingsError["code"]): never { throw new CreatorTipSettingsError(code); }
type Input = Readonly<{
  applicationRevision: string;
  db: PawketDatabase; visibility: Pick<ReturnType<typeof createPublicCatalogQuery>, "resolveVisibleReportTarget">;
  creatorAccount: CreatorTipAccountPort; receivingAccount: CreatorTipReceivingAccountPort;
  paymentsMode: "disabled" | "manual_only"; publishingMode: "disabled" | "general_audience";
  platformPolicy: PlatformTipPolicyPort; recentAuthMs: number; commandFingerprintKey: Uint8Array;
  now?: () => Date; idFactory?: () => string;
}>;

export function createCreatorTipSettingsService(input: Input) {
  if (!identifier(input.applicationRevision)) fail("INVALID_REQUEST");
  if (!Number.isSafeInteger(input.recentAuthMs) || input.recentAuthMs < 1 || input.recentAuthMs > 900_000) fail("INVALID_POLICY");
  const clock = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;
  const modesActive = () => input.paymentsMode === "manual_only" && input.publishingMode === "general_audience";
  const readPolicy = async (tx: PawketTransaction) => readPlatformTipPolicySnapshot(await input.platformPolicy.readPolicy(tx));
  const validTriple = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3 && new Set(value).size === 3 && value.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 10_000 && v <= 5_000_000);
  const validPresets = (value: unknown, policy: PlatformTipPolicySnapshot): value is number[] => validTriple(value) && value.every((v) => policy.allowedPresetsVnd.includes(v));
  const now = () => { const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail("INVALID_REQUEST"); return at; };

  async function current(tx: PawketTransaction, creatorUserId: string) {
    const [settings] = await tx.select().from(creatorTipSettings).where(eq(creatorTipSettings.creatorUserId, creatorUserId)).limit(1).for("update");
    if (!settings) return null;
    const [revision] = await tx.select().from(creatorTipSettingRevisions).where(and(eq(creatorTipSettingRevisions.id, settings.revisionId), eq(creatorTipSettingRevisions.creatorUserId, creatorUserId))).limit(1);
    if (!revision) fail("NOT_AVAILABLE");
    return revision;
  }
  function snapshot(revision: typeof creatorTipSettingRevisions.$inferSelect | null, policy: PlatformTipPolicySnapshot | null): CreatorTipSettingsSnapshot {
    if (!revision && !policy) fail("INVALID_POLICY");
    const presetsVnd = revision?.presetsVnd ?? policy!.allowedPresetsVnd.slice(0, 3);
    const presetsFallback = Boolean(revision && policy && !validPresets(presetsVnd, policy));
    const effectivePresetsVnd = policy ? (presetsFallback ? policy.allowedPresetsVnd.slice(0, 3) : presetsVnd) : [];
    return Object.freeze({ revisionId: revision?.id ?? null, revisionNumber: revision?.revisionNumber ?? 0, enabled: revision?.enabled ?? false,
      minimumVnd: revision?.minimumVnd ?? policy!.minimumVnd, maximumVnd: revision?.maximumVnd ?? policy!.maximumVnd,
      presetsVnd: Object.freeze([...presetsVnd]), platformPolicyRevisionId: revision?.platformPolicyRevisionId ?? null,
      effectivePolicy: policy, effectivePresetsVnd: Object.freeze([...effectivePresetsVnd]), presetsFallback });
  }
  async function ownedPage(tx: PawketTransaction, userId: string, pageId: string) {
    if (!identifier(userId) || !isUuid(pageId)) fail("NOT_FOUND");
    const [page] = await tx.select().from(creatorPages).where(and(eq(creatorPages.id, pageId), eq(creatorPages.userId, userId))).limit(1).for("update");
    if (!page) fail("NOT_FOUND");
    return page;
  }
  async function visibleCreator(tx: PawketTransaction, page: typeof creatorPages.$inferSelect) {
    if (!modesActive() || !page.publishedRevisionId) return null;
    const visible = readExactOwnRecord(await input.visibility.resolveVisibleReportTarget(tx, {
      targetType: "page", targetId: page.id, publicationRevisionId: page.publishedRevisionId,
    }), ["target", "pageId", "creatorUserId", "canonicalHandle", "displayName", "showcaseTitle", "mediaAssetIds"]);
    const target = readExactOwnRecord(visible?.target, ["targetType", "targetId", "publicationRevisionId"]);
    if (!visible || !target || target.targetType !== "page" || target.targetId !== page.id || target.publicationRevisionId !== page.publishedRevisionId ||
      visible.pageId !== page.id || visible.creatorUserId !== page.userId || visible.showcaseTitle !== null ||
      typeof visible.displayName !== "string" || Array.from(visible.displayName).length < 1 || Array.from(visible.displayName).length > 80 ||
      typeof visible.canonicalHandle !== "string" || visible.canonicalHandle.trim() !== visible.canonicalHandle ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(visible.canonicalHandle) || visible.canonicalHandle.length < 3 || visible.canonicalHandle.length > 30 ||
      !Array.isArray(visible.mediaAssetIds) || !visible.mediaAssetIds.every(isUuid)) return null;
    if (await input.creatorAccount.isActiveTipCreatorAccount(tx, page.userId) !== true) return null;
    return { canonicalHandle: visible.canonicalHandle, displayName: visible.displayName };
  }
  async function receivingVersion(tx: PawketTransaction, creatorUserId: string, at: Date) {
    const result = readExactOwnRecord(await input.receivingAccount.getCurrentTipReceivingAccount(tx, creatorUserId, at), ["accountVersionId"]);
    return result && isUuid(result.accountVersionId) ? result.accountVersionId : null;
  }

  // Existing instructions retain security and opt-in gates without consulting a
  // newer amount policy. This port cannot authorize a new tip amount.
  async function existingEligibility(tx: PawketTransaction, canonicalHandle: string): Promise<ExistingCreatorTipEligibility | null> {
    if (!modesActive() || typeof canonicalHandle !== "string" || canonicalHandle.trim() !== canonicalHandle || canonicalHandle.length < 3 || canonicalHandle.length > 30 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(canonicalHandle)) return null;
    const [candidate] = await tx.select({ pageId: creatorHandleClaims.pageId }).from(creatorHandleClaims).where(and(eq(creatorHandleClaims.normalizedHandle, canonicalHandle), eq(creatorHandleClaims.kind, "canonical"))).limit(1);
    if (!candidate) return null;
    const [page] = await tx.select().from(creatorPages).where(eq(creatorPages.id, candidate.pageId)).limit(1).for("update");
    if (!page) return null;
    const visible = await visibleCreator(tx, page);
    if (!visible || visible.canonicalHandle !== canonicalHandle) return null;
    const settings = await current(tx, page.userId);
    if (!settings?.enabled) return null;
    const accountVersionId = await receivingVersion(tx, page.userId, now());
    if (!accountVersionId) return null;
    return Object.freeze({ creatorUserId: page.userId, pageId: page.id, publicationRevisionId: page.publishedRevisionId!,
      ...visible, settingRevisionId: settings.id, receivingAccountVersionId: accountVersionId });
  }
  const service = {
    async getSettings(command: { actorUserId: string; pageId: string }): Promise<CreatorTipSettingsSnapshot & Readonly<{ available: boolean }>> {
      return input.db.transaction(async (tx) => {
        const policy = await readPolicy(tx);
        const page = await ownedPage(tx, command.actorUserId, command.pageId);
        const visible = await visibleCreator(tx, page);
        const settings = snapshot(await current(tx, page.userId), policy);
        const receiving = visible ? await receivingVersion(tx, page.userId, now()) : null;
        return { ...settings, available: Boolean(policy && visible && receiving) };
      });
    },
    getExistingTipEligibility: existingEligibility,
    async getTipEligibility(tx: PawketTransaction, canonicalHandle: string): Promise<CreatorTipEligibility | null> {
      // Lock policy before page/account; owner edits never acquire page locks.
      const policy = await readPolicy(tx);
      if (!policy) return null;
      const creator = await existingEligibility(tx, canonicalHandle);
      if (!creator) return null;
      const settings = snapshot(await current(tx, creator.creatorUserId), policy);
      return Object.freeze({ ...creator, minimumVnd: policy.minimumVnd, maximumVnd: policy.maximumVnd,
        presetsVnd: settings.effectivePresetsVnd, platformPolicyRevisionId: policy.revisionId });
    },
    async saveSettings(command: { actor: CatalogActor; pageId: string; expectedRevision: number; expectedPolicyRevision: number; enabled: boolean; presetsVnd: unknown; idempotencyKey: string; requestId: string }): Promise<CreatorTipSettingsSnapshot> {
      if (!identifier(command.actor.userId) || !identifier(command.actor.sessionId) || !identifier(command.requestId) || !isUuid(command.pageId) ||
        typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim() !== command.idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) ||
        !Number.isInteger(command.expectedRevision) || command.expectedRevision < 0 || command.expectedRevision >= 2_147_483_647 || typeof command.enabled !== "boolean" || !validTriple(command.presetsVnd) || !Number.isInteger(command.expectedPolicyRevision) || command.expectedPolicyRevision < 1 || command.expectedPolicyRevision > 2_147_483_647) fail("INVALID_REQUEST");
      if (!modesActive()) fail("PAYMENTS_DISABLED");
      const presetsVnd = [...command.presetsVnd];
      return input.db.transaction(async (tx) => {
        const at = now();
        const age = command.actor.primaryAuthenticatedAt instanceof Date ? at.getTime() - command.actor.primaryAuthenticatedAt.getTime() : NaN;
        if (!Number.isFinite(age) || age < 0 || age > input.recentAuthMs) fail("RECENT_AUTH_REQUIRED");
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.actor.userId, commandScope: "catalog.tip_settings.set",
          keyHash: createLookupHmac({ key: input.commandFingerprintKey, context: "catalog-tip-command-key", value: command.idempotencyKey }),
          requestFingerprint: createLookupHmac({ key: input.commandFingerprintKey, context: "catalog-tip-command", value: JSON.stringify([command.actor.userId, command.pageId, command.expectedRevision, command.expectedPolicyRevision, command.enabled, presetsVnd]) }),
          now: at, expiresAt: new Date(at.getTime() + 86_400_000),
        });
        if (started.kind !== "acquired" && started.kind !== "replay") fail("IDEMPOTENCY_CONFLICT");
        const policy = await readPolicy(tx);
        const page = await ownedPage(tx, command.actor.userId, command.pageId);
        if (!await visibleCreator(tx, page)) fail("NOT_AVAILABLE");
        const settings = snapshot(await current(tx, page.userId), policy);
        if (!await receivingVersion(tx, page.userId, at)) fail("NOT_AVAILABLE");
        if (started.kind === "replay") {
          const match = /^creator-tip-settings-v1:([0-9a-f-]{36})$/u.exec(started.resultReference);
          const revisionId = match?.[1];
          if (!isUuid(revisionId)) fail("IDEMPOTENCY_CONFLICT");
          const [revision] = await tx.select().from(creatorTipSettingRevisions).where(and(eq(creatorTipSettingRevisions.id, revisionId), eq(creatorTipSettingRevisions.creatorUserId, page.userId))).limit(1);
          if (!revision) fail("IDEMPOTENCY_CONFLICT");
          return snapshot(revision, policy);
        }
        if (!policy) fail("INVALID_POLICY");
        if (policy.revisionNumber !== command.expectedPolicyRevision) fail("POLICY_CHANGED");
        if (!validPresets(presetsVnd, policy)) fail("INVALID_REQUEST");
        if (settings.revisionNumber !== command.expectedRevision) fail("VERSION_CONFLICT");
        const revisionId = id();
        if (!isUuid(revisionId)) fail("INVALID_REQUEST");
        const [revision] = await tx.insert(creatorTipSettingRevisions).values({
          id: revisionId, creatorUserId: page.userId, revisionNumber: settings.revisionNumber + 1,
          enabled: command.enabled, minimumVnd: policy.minimumVnd, maximumVnd: policy.maximumVnd, presetsVnd, platformPolicyRevisionId: policy.revisionId,
          actorSessionId: command.actor.sessionId, requestId: command.requestId, createdAt: at,
        }).returning();
        if (!revision) fail("NOT_AVAILABLE");
        if (settings.revisionId) await tx.update(creatorTipSettings).set({ revisionId, updatedAt: at }).where(eq(creatorTipSettings.creatorUserId, page.userId));
        else await tx.insert(creatorTipSettings).values({ creatorUserId: page.userId, revisionId, createdAt: at, updatedAt: at });
        await appendAdminAuditEvent(tx, {
          actorUserId: page.userId, actorSessionId: command.actor.sessionId, subjectType: "creator_tip_settings", subjectId: page.userId,
          action: "creator.tip_settings.updated", outcome: "succeeded",
          beforeState: { enabled: settings.enabled, version: settings.revisionNumber }, afterState: { enabled: revision.enabled, version: revision.revisionNumber },
          assurance: { method: "recent_primary_auth" }, applicationRevision: input.applicationRevision, requestId: command.requestId, occurredAt: at,
        });
        await insertOutboxEvent(tx, { eventType: "creator.tip_settings_updated.v1", eventVersion: 1, aggregateType: "creator_tip_settings", aggregateId: page.userId,
          payload: { creatorUserId: page.userId, revisionId, enabled: revision.enabled, correlationId: command.requestId }, occurredAt: at });
        if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `creator-tip-settings-v1:${revisionId}`, completedAt: at })) fail("IDEMPOTENCY_CONFLICT");
        return snapshot(revision, policy);
      });
    },
  };
  async function ownPageId(userId: string): Promise<string | null> {
    if (!identifier(userId)) fail("NOT_FOUND");
    const [page] = await input.db.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, userId)).limit(1);
    return page?.id ?? null;
  }
  return {
    ...service,
    async getOwnSettings(actorUserId: string) {
      const pageId = await ownPageId(actorUserId);
      return pageId ? service.getSettings({ actorUserId, pageId }) : null;
    },
    async saveOwnSettings(command: Omit<Parameters<typeof service.saveSettings>[0], "pageId">) {
      const pageId = await ownPageId(command.actor.userId);
      if (!pageId) fail("NOT_FOUND");
      return service.saveSettings({ ...command, pageId });
    },
  };
}
