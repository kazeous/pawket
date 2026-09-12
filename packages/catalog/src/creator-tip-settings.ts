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
import { readExactOwnRecord } from "./runtime-boundary.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && value.trim() === value && UUID.test(value);

export type CreatorTipAmountPolicy = Readonly<{ minimumVnd: number; maximumVnd: number; allowedPresetsVnd: readonly number[] }>;
export type CreatorTipSettingsSnapshot = Readonly<{
  revisionId: string | null; revisionNumber: number; enabled: boolean;
  minimumVnd: number; maximumVnd: number; presetsVnd: readonly number[];
}>;
// Internal read port for the payment transaction, never the public JSON shape.
export type CreatorTipEligibility = Readonly<{
  creatorUserId: string; pageId: string; publicationRevisionId: string;
  canonicalHandle: string; displayName: string; settingRevisionId: string;
  minimumVnd: number; maximumVnd: number; presetsVnd: readonly number[];
  receivingAccountVersionId: string;
}>;
export type CreatorTipEligibilityPort = {
  getTipEligibility(tx: PawketTransaction, canonicalHandle: string): Promise<CreatorTipEligibility | null>;
};
export type CreatorTipReceivingAccountPort = {
  getCurrentTipReceivingAccount(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<Readonly<{ accountVersionId: string }> | null>;
};
export type CreatorTipAccountPort = {
  isActiveTipCreatorAccount(tx: PawketTransaction, userId: string): Promise<boolean>;
};
export class CreatorTipSettingsError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_AVAILABLE" | "PAYMENTS_DISABLED" | "RECENT_AUTH_REQUIRED" | "INVALID_REQUEST" | "INVALID_POLICY" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT") {
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
  amountPolicy: CreatorTipAmountPolicy; recentAuthMs: number; commandFingerprintKey: Uint8Array;
  now?: () => Date; idFactory?: () => string;
}>;

export function createCreatorTipSettingsService(input: Input) {
  if (!identifier(input.applicationRevision)) fail("INVALID_REQUEST");
  const { minimumVnd, maximumVnd } = input.amountPolicy;
  const allowedPresetsVnd = [...input.amountPolicy.allowedPresetsVnd];
  if (!Number.isSafeInteger(minimumVnd) || !Number.isSafeInteger(maximumVnd) || minimumVnd < 10_000 || maximumVnd > 5_000_000 || maximumVnd < minimumVnd ||
    allowedPresetsVnd.length < 3 || allowedPresetsVnd.length > 10 || new Set(allowedPresetsVnd).size !== allowedPresetsVnd.length ||
    allowedPresetsVnd.some((v) => !Number.isSafeInteger(v) || v < minimumVnd || v > maximumVnd) ||
    !Number.isSafeInteger(input.recentAuthMs) || input.recentAuthMs < 1 || input.recentAuthMs > 900_000) fail("INVALID_POLICY");
  const clock = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;
  const modesActive = () => input.paymentsMode === "manual_only" && input.publishingMode === "general_audience";
  const validPresets = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3 && new Set(value).size === 3 && value.every((v) => typeof v === "number" && allowedPresetsVnd.includes(v));
  const now = () => { const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail("INVALID_REQUEST"); return at; };

  async function current(tx: PawketTransaction, creatorUserId: string): Promise<CreatorTipSettingsSnapshot> {
    const [settings] = await tx.select().from(creatorTipSettings).where(eq(creatorTipSettings.creatorUserId, creatorUserId)).limit(1).for("update");
    if (!settings) return { revisionId: null, revisionNumber: 0, enabled: false, minimumVnd, maximumVnd, presetsVnd: allowedPresetsVnd.slice(0, 3) };
    const [revision] = await tx.select().from(creatorTipSettingRevisions).where(and(eq(creatorTipSettingRevisions.id, settings.revisionId), eq(creatorTipSettingRevisions.creatorUserId, creatorUserId))).limit(1);
    if (!revision) fail("NOT_AVAILABLE");
    return snapshot(revision);
  }
  function snapshot(revision: typeof creatorTipSettingRevisions.$inferSelect): CreatorTipSettingsSnapshot {
    return Object.freeze({ revisionId: revision.id, revisionNumber: revision.revisionNumber, enabled: revision.enabled,
      minimumVnd: revision.minimumVnd, maximumVnd: revision.maximumVnd, presetsVnd: Object.freeze([...revision.presetsVnd]) });
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

  const service = {
    async getSettings(command: { actorUserId: string; pageId: string }): Promise<CreatorTipSettingsSnapshot & Readonly<{ available: boolean }>> {
      return input.db.transaction(async (tx) => {
        const page = await ownedPage(tx, command.actorUserId, command.pageId);
        const visible = await visibleCreator(tx, page);
        const settings = await current(tx, page.userId);
        const receiving = visible ? await receivingVersion(tx, page.userId, now()) : null;
        return { ...settings, available: Boolean(visible && receiving) };
      });
    },
    async getTipEligibility(tx: PawketTransaction, canonicalHandle: string): Promise<CreatorTipEligibility | null> {
      if (!modesActive() || typeof canonicalHandle !== "string" || canonicalHandle.trim() !== canonicalHandle || canonicalHandle.length < 3 || canonicalHandle.length > 30 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(canonicalHandle)) return null;
      const [candidate] = await tx.select({ pageId: creatorHandleClaims.pageId }).from(creatorHandleClaims).where(and(eq(creatorHandleClaims.normalizedHandle, canonicalHandle), eq(creatorHandleClaims.kind, "canonical"))).limit(1);
      if (!candidate) return null;
      const [page] = await tx.select().from(creatorPages).where(eq(creatorPages.id, candidate.pageId)).limit(1).for("update");
      if (!page) return null;
      const visible = await visibleCreator(tx, page);
      if (!visible || visible.canonicalHandle !== canonicalHandle) return null;
      const settings = await current(tx, page.userId);
      if (!settings.enabled || !settings.revisionId || !validPresets(settings.presetsVnd)) return null;
      const minimum = Math.max(minimumVnd, settings.minimumVnd);
      const maximum = Math.min(maximumVnd, settings.maximumVnd);
      if (minimum > maximum || settings.presetsVnd.some((v) => v < minimum || v > maximum)) return null;
      const accountVersionId = await receivingVersion(tx, page.userId, now());
      if (!accountVersionId) return null;
      return Object.freeze({
        creatorUserId: page.userId, pageId: page.id, publicationRevisionId: page.publishedRevisionId!,
        ...visible, settingRevisionId: settings.revisionId, minimumVnd: minimum, maximumVnd: maximum,
        presetsVnd: settings.presetsVnd, receivingAccountVersionId: accountVersionId,
      });
    },
    async saveSettings(command: { actor: CatalogActor; pageId: string; expectedRevision: number; enabled: boolean; presetsVnd: unknown; idempotencyKey: string; requestId: string }): Promise<CreatorTipSettingsSnapshot> {
      if (!identifier(command.actor.userId) || !identifier(command.actor.sessionId) || !identifier(command.requestId) || !isUuid(command.pageId) ||
        typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim() !== command.idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) ||
        !Number.isInteger(command.expectedRevision) || command.expectedRevision < 0 || command.expectedRevision >= 2_147_483_647 || typeof command.enabled !== "boolean" || !validPresets(command.presetsVnd)) fail("INVALID_REQUEST");
      if (!modesActive()) fail("PAYMENTS_DISABLED");
      const presetsVnd = [...command.presetsVnd];
      return input.db.transaction(async (tx) => {
        const page = await ownedPage(tx, command.actor.userId, command.pageId);
        const at = now();
        const age = command.actor.primaryAuthenticatedAt instanceof Date ? at.getTime() - command.actor.primaryAuthenticatedAt.getTime() : NaN;
        if (!Number.isFinite(age) || age < 0 || age > input.recentAuthMs) fail("RECENT_AUTH_REQUIRED");
        if (!await visibleCreator(tx, page)) fail("NOT_AVAILABLE");
        const settings = await current(tx, page.userId);
        if (!await receivingVersion(tx, page.userId, at)) fail("NOT_AVAILABLE");
        const started = await beginIdempotentCommand(tx, {
          actorUserId: page.userId, commandScope: "catalog.tip_settings.set",
          keyHash: createLookupHmac({ key: input.commandFingerprintKey, context: "catalog-tip-command-key", value: command.idempotencyKey }),
          requestFingerprint: createLookupHmac({ key: input.commandFingerprintKey, context: "catalog-tip-command", value: JSON.stringify([page.userId, page.id, command.expectedRevision, command.enabled, presetsVnd]) }),
          now: at, expiresAt: new Date(at.getTime() + 86_400_000),
        });
        if (started.kind === "replay") {
          const match = /^creator-tip-settings-v1:([0-9a-f-]{36})$/u.exec(started.resultReference);
          const revisionId = match?.[1];
          if (!isUuid(revisionId)) fail("IDEMPOTENCY_CONFLICT");
          const [revision] = await tx.select().from(creatorTipSettingRevisions).where(and(eq(creatorTipSettingRevisions.id, revisionId), eq(creatorTipSettingRevisions.creatorUserId, page.userId))).limit(1);
          if (!revision) fail("IDEMPOTENCY_CONFLICT");
          return snapshot(revision);
        }
        if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
        if (settings.revisionNumber !== command.expectedRevision) fail("VERSION_CONFLICT");
        const revisionId = id();
        if (!isUuid(revisionId)) fail("INVALID_REQUEST");
        const [revision] = await tx.insert(creatorTipSettingRevisions).values({
          id: revisionId, creatorUserId: page.userId, revisionNumber: settings.revisionNumber + 1,
          enabled: command.enabled, minimumVnd, maximumVnd, presetsVnd,
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
        return snapshot(revision);
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
