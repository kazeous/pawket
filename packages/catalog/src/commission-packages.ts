import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, commissionPackageRevisions, commissionPackages,
  commissionReservations, creatorCommissionSettings, creatorHandleClaims, creatorPages, creatorPublicationShowcases, type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";
import {
  COMMISSION_POLICY, CommissionError, commissionFail, commissionIdentifier, commissionIdempotencyKey, commissionInteger,
  commissionCommandFingerprint,
  commissionText, commissionTime, commissionUuid, lockCommissionCreator, normalizeCommissionTerms, readCommissionRecord,
  requireCommissionPolicy, type CommissionActor, type CommissionPackageDraft, type CommissionPolicyReadPort,
} from "@pawket/orders";
import { DISCIPLINES } from "./catalog-policy.js";
import type { createPublicCatalogQuery } from "./public-catalog-query.js";

type Package = typeof commissionPackages.$inferSelect;
type Revision = typeof commissionPackageRevisions.$inferSelect;
type Command = Readonly<{ actor: CommissionActor; idempotencyKey: string; requestId: string }>;
type Input = Readonly<{
  db: PawketDatabase; applicationRevision: string; lookupHmacKey: Uint8Array;
  intakeMode: "disabled" | "enabled"; paymentsMode: "disabled" | "manual_only" | "sepay_optional";
  publishingMode: "disabled" | "general_audience";
  identity: { lockCreator(tx: PawketTransaction, actor: CommissionActor, at: Date): Promise<{ sessionExpiresAt: Date } | null> };
  policy: CommissionPolicyReadPort;
  visibility: Pick<ReturnType<typeof createPublicCatalogQuery>, "resolveVisibleReportTarget">;
  receivingAccount: { getCurrentTipReceivingAccount(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<{ accountVersionId: string } | null> };
  now?: () => Date; idFactory?: () => string;
}>;
export function normalizeCommissionPackageDraft(value: unknown): CommissionPackageDraft {
  const row = readCommissionRecord(value, ["title", "description", "discipline", "route", "briefInstructions", "terms", "showcaseId"]);
  if (!row || !DISCIPLINES.includes(row.discipline as typeof DISCIPLINES[number]) ||
    (row.route !== "fixed_immediate" && row.route !== "fixed_approval" && row.route !== "custom_quote") ||
    (row.showcaseId !== null && !commissionUuid(row.showcaseId))) commissionFail("invalid_request");
  if (row.route === "custom_quote" && row.terms !== null) commissionFail("invalid_terms");
  return Object.freeze({ title: commissionText(row.title, 1, 100), description: commissionText(row.description, 0, 2_000),
    discipline: row.discipline as string, route: row.route, briefInstructions: commissionText(row.briefInstructions, 0, 2_000),
    terms: row.route === "custom_quote" ? null : normalizeCommissionTerms(row.terms), showcaseId: row.showcaseId });
}
function actorValid(actor: CommissionActor) {
  if (!actor || !commissionIdentifier(actor.userId) || !commissionIdentifier(actor.sessionId)) commissionFail("not_authorized");
}

export function createCommissionPackageService(input: Input) {
  if (!commissionIdentifier(input.applicationRevision) || input.lookupHmacKey.length < 32) commissionFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date()); const id = input.idFactory ?? randomUUID;
  const now = () => { const at = clock(); commissionTime(at); return new Date(at); };
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  const newId = () => { const value = id(); if (!commissionUuid(value)) commissionFail("dependency_unavailable"); return value; };
  async function authorize(tx: PawketTransaction, actor: CommissionActor) {
    const at = now(); const proof = await input.identity.lockCreator(tx, actor, at);
    if (!proof || !(proof.sessionExpiresAt instanceof Date) || proof.sessionExpiresAt <= at) commissionFail("not_authorized");
    return proof.sessionExpiresAt;
  }
  async function owned(tx: PawketTransaction, creatorUserId: string, packageId: string): Promise<Package> {
    const [row] = await tx.select().from(commissionPackages).where(and(eq(commissionPackages.id, packageId), eq(commissionPackages.creatorUserId, creatorUserId))).limit(1).for("update");
    if (!row) commissionFail("not_authorized"); return row;
  }
  async function mutate(command: Command, scope: string, payload: unknown, apply: (tx: PawketTransaction, at: Date, replay: string | null) => Promise<string>) {
    actorValid(command.actor);
    if (!commissionIdempotencyKey(command.idempotencyKey) || !commissionIdentifier(command.requestId)) commissionFail("invalid_request");
    try {
      return await input.db.transaction(async (tx) => {
        const startedAt = now();
        const started = await beginIdempotentCommand(tx, { actorUserId: command.actor.userId, commandScope: `catalog.commission.${scope}`,
          keyHash: digest("commission-catalog-command-key", command.idempotencyKey), requestFingerprint: commissionCommandFingerprint(key, "commission-catalog-command", [scope, command.actor.userId, payload]),
          now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
        if (started.kind !== "acquired" && started.kind !== "replay") commissionFail("idempotency_conflict");
        await lockCommissionCreator(tx, command.actor.userId);
        const expiresAt = await authorize(tx, command.actor);
        const at = now(); if (expiresAt <= at || at < startedAt) commissionFail("not_authorized");
        const result = await apply(tx, at, started.kind === "replay" ? started.resultReference : null);
        if (started.kind === "acquired") {
          await appendAdminAuditEvent(tx, { actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId,
            subjectType: "commission_catalog", subjectId: result, action: `commission.${scope}`, outcome: "succeeded",
            beforeState: null, afterState: { reference: result }, assurance: { method: "current_session" }, applicationRevision: input.applicationRevision,
            requestId: command.requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: `commission.catalog.${scope}.v1`, eventVersion: 1, aggregateType: "commission_catalog", aggregateId: result,
            payload: { reference: result, actorUserId: command.actor.userId, correlationId: command.requestId }, occurredAt: at });
          if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: result, completedAt: at })) commissionFail("idempotency_conflict");
        }
        return result;
      });
    } catch (error) { if (error instanceof CommissionError) throw error; return commissionFail("dependency_unavailable"); }
  }
  async function visible(tx: PawketTransaction, pageId: string, creatorUserId: string, showcaseId: string | null) {
    const [page] = await tx.select().from(creatorPages).where(and(eq(creatorPages.id, pageId), eq(creatorPages.userId, creatorUserId))).limit(1).for("update");
    if (!page?.publishedRevisionId || input.publishingMode !== "general_audience") return null;
    const result = await input.visibility.resolveVisibleReportTarget(tx, { targetType: "page", targetId: page.id, publicationRevisionId: page.publishedRevisionId });
    if (!result || result.creatorUserId !== creatorUserId || result.pageId !== page.id || result.target.publicationRevisionId !== page.publishedRevisionId) return null;
    const showcase = showcaseId ? await input.visibility.resolveVisibleReportTarget(tx, { targetType: "showcase", targetId: showcaseId, publicationRevisionId: page.publishedRevisionId }) : null;
    return { displayName: result.displayName, canonicalHandle: result.canonicalHandle,
      showcaseId: showcase?.creatorUserId === creatorUserId && showcase.pageId === page.id ? showcaseId : null };
  }
  async function usage(tx: PawketTransaction, creatorUserId: string) {
    const [used] = await tx.select({ count: count() }).from(commissionReservations).where(and(eq(commissionReservations.creatorUserId, creatorUserId), inArray(commissionReservations.state, ["reserved", "occupied"])));
    return used?.count ?? 0;
  }
  return {
    async findPackageIdentity(tx: PawketTransaction, packageId: string) {
      if (!commissionUuid(packageId)) return null;
      const [row] = await tx.select({ creatorUserId: commissionPackages.creatorUserId, route: commissionPackageRevisions.route }).from(commissionPackages)
        .innerJoin(commissionPackageRevisions, eq(commissionPackageRevisions.id, commissionPackages.publishedRevisionId)).where(eq(commissionPackages.id, packageId)).limit(1);
      return row ?? null;
    },
    async saveDraft(command: Command & { packageId: string | null; pageId: string; expectedVersion: number; draft: unknown }) {
      if (!commissionUuid(command.pageId) || (command.packageId !== null && !commissionUuid(command.packageId))) commissionFail("invalid_request");
      commissionInteger(command.expectedVersion, 0, 2_147_483_646); const draft = normalizeCommissionPackageDraft(command.draft);
      return mutate(command, "draft_saved", [command.packageId, command.pageId, command.expectedVersion, draft], async (tx, at, replay) => {
        if (replay) { await owned(tx, command.actor.userId, replay); return replay; }
        const [page] = await tx.select().from(creatorPages).where(and(eq(creatorPages.id, command.pageId), eq(creatorPages.userId, command.actor.userId))).limit(1).for("update");
        if (!page) commissionFail("not_authorized");
        if (command.packageId === null) {
          if (command.expectedVersion !== 0) commissionFail("version_conflict");
          const [total] = await tx.select({ count: count() }).from(commissionPackages).where(and(eq(commissionPackages.creatorUserId, command.actor.userId), ne(commissionPackages.state, "archived")));
          if ((total?.count ?? 0) >= COMMISSION_POLICY.maximumPackages) commissionFail("capacity_full");
          const packageId = newId();
          await tx.insert(commissionPackages).values({ id: packageId, pageId: page.id, creatorUserId: command.actor.userId, draft, createdAt: at, updatedAt: at });
          return packageId;
        }
        const row = await owned(tx, command.actor.userId, command.packageId);
        if (row.pageId !== page.id) commissionFail("not_authorized");
        if (row.version !== command.expectedVersion) commissionFail("version_conflict");
        if (row.state === "archived") commissionFail("invalid_transition");
        await tx.update(commissionPackages).set({ draft, version: row.version + 1, updatedAt: at }).where(eq(commissionPackages.id, row.id));
        return row.id;
      });
    },
    async changePackage(command: Command & { packageId: string; expectedVersion: number; action: "publish" | "pause" | "archive"; policyRevisionId: string }) {
      if (!commissionUuid(command.packageId) || !commissionUuid(command.policyRevisionId) || !["publish", "pause", "archive"].includes(command.action)) commissionFail("invalid_request");
      commissionInteger(command.expectedVersion, 1, 2_147_483_646);
      return mutate(command, command.action, [command.packageId, command.expectedVersion, command.action, command.policyRevisionId], async (tx, at, replay) => {
        if (replay) { await owned(tx, command.actor.userId, replay); return replay; }
        const policy = await input.policy.readCurrent(tx, at);
        const row = await owned(tx, command.actor.userId, command.packageId);
        if (row.version !== command.expectedVersion) commissionFail("version_conflict");
        if (row.state === "archived" || (command.action === "pause" && row.state !== "open")) commissionFail("invalid_transition");
        let revisionId = row.publishedRevisionId;
        if (command.action === "publish") {
          if (!policy || policy.revisionId !== command.policyRevisionId) commissionFail("policy_changed");
          const draft = normalizeCommissionPackageDraft(row.draft);
          if (draft.terms && draft.terms.policyRevisionId !== policy.revisionId) commissionFail("policy_changed");
          const creator = await visible(tx, row.pageId, row.creatorUserId, draft.showcaseId);
          if (!creator || (draft.showcaseId && creator.showcaseId !== draft.showcaseId)) commissionFail("not_available");
          const [last] = await tx.select().from(commissionPackageRevisions).where(eq(commissionPackageRevisions.packageId, row.id)).orderBy(desc(commissionPackageRevisions.revisionNumber)).limit(1);
          revisionId = newId();
          await tx.insert(commissionPackageRevisions).values({ id: revisionId, packageId: row.id, creatorUserId: row.creatorUserId, revisionNumber: (last?.revisionNumber ?? 0) + 1,
            ...draft, policyRevisionId: policy.revisionId, actorSessionId: command.actor.sessionId, requestId: command.requestId, publishedAt: at });
        }
        await tx.update(commissionPackages).set({ state: command.action === "publish" ? "open" : command.action === "pause" ? "paused" : "archived",
          publishedRevisionId: revisionId, version: row.version + 1, updatedAt: at }).where(eq(commissionPackages.id, row.id));
        return row.id;
      });
    },
    async saveSettings(command: Command & { expectedVersion: number; enabled: boolean; capacityLimit: number }) {
      commissionInteger(command.expectedVersion, 0, 2_147_483_646); commissionInteger(command.capacityLimit, 1, 20);
      if (typeof command.enabled !== "boolean") commissionFail("invalid_request");
      return mutate(command, "settings_saved", [command.expectedVersion, command.enabled, command.capacityLimit], async (tx, at, replay) => {
        if (replay) return command.actor.userId;
        const [current] = await tx.select().from(creatorCommissionSettings).where(eq(creatorCommissionSettings.creatorUserId, command.actor.userId)).limit(1).for("update");
        if ((current?.version ?? 0) !== command.expectedVersion) commissionFail("version_conflict");
        if (current) await tx.update(creatorCommissionSettings).set({ enabled: command.enabled, capacityLimit: command.capacityLimit, version: current.version + 1, updatedAt: at }).where(eq(creatorCommissionSettings.creatorUserId, command.actor.userId));
        else await tx.insert(creatorCommissionSettings).values({ creatorUserId: command.actor.userId, enabled: command.enabled, capacityLimit: command.capacityLimit, createdAt: at, updatedAt: at });
        return command.actor.userId;
      });
    },
    async getWorkspace(actor: CommissionActor) {
      actorValid(actor);
      return input.db.transaction(async (tx) => {
        await lockCommissionCreator(tx, actor.userId); await authorize(tx, actor);
        const [settings] = await tx.select().from(creatorCommissionSettings).where(eq(creatorCommissionSettings.creatorUserId, actor.userId)).limit(1);
        const packages = await tx.select().from(commissionPackages).where(and(eq(commissionPackages.creatorUserId, actor.userId), ne(commissionPackages.state, "archived"))).orderBy(desc(commissionPackages.createdAt), desc(commissionPackages.id)).limit(12);
        const [page] = await tx.select({ id: creatorPages.id, publishedRevisionId: creatorPages.publishedRevisionId }).from(creatorPages).where(eq(creatorPages.userId, actor.userId)).limit(1);
        const showcases = page?.publishedRevisionId ? await tx.select({ id: creatorPublicationShowcases.sourceShowcaseId, title: creatorPublicationShowcases.title })
          .from(creatorPublicationShowcases).where(eq(creatorPublicationShowcases.revisionId, page.publishedRevisionId)).orderBy(asc(creatorPublicationShowcases.position)).limit(12) : [];
        const availableShowcases = [];
        for (const showcase of showcases) if ((await visible(tx, page!.id, actor.userId, showcase.id))?.showcaseId === showcase.id) availableShowcases.push(showcase);
        const policy = await input.policy.readCurrent(tx, now());
        return { pageId: page?.id ?? null, showcases: availableShowcases, policy: policy ? { revisionId: policy.revisionId, document: policy.document, acceptsOrders: policy.acceptsOrders } : null,
          settings: { version: settings?.version ?? 0, enabled: settings?.enabled ?? false, capacityLimit: settings?.capacityLimit ?? 3, used: await usage(tx, actor.userId) }, packages };
      });
    },
    /** Orders calls after its participant assurance; old fixed requests can retain a prior revision. */
    async getIntakePackage(tx: PawketTransaction, command: { packageId: string; revisionId: string; allowPreviousRevision: boolean; requirePayment?: boolean; at: Date }) {
      if (!commissionUuid(command.packageId) || !commissionUuid(command.revisionId)) commissionFail("invalid_request");
      if (input.intakeMode !== "enabled") commissionFail("intake_disabled");
      if (command.requirePayment !== false && input.paymentsMode === "disabled") commissionFail("payments_disabled");
      const [candidate] = await tx.select().from(commissionPackages).where(eq(commissionPackages.id, command.packageId)).limit(1);
      if (!candidate) commissionFail("not_available");
      await lockCommissionCreator(tx, candidate.creatorUserId);
      const policy = await input.policy.readCurrent(tx, command.at);
      const row = await owned(tx, candidate.creatorUserId, candidate.id);
      if (row.state !== "open") commissionFail("not_available");
      if (!command.allowPreviousRevision && row.publishedRevisionId !== command.revisionId) commissionFail("version_conflict");
      const [revision] = await tx.select().from(commissionPackageRevisions).where(and(eq(commissionPackageRevisions.id, command.revisionId), eq(commissionPackageRevisions.packageId, row.id))).limit(1);
      if (!revision) commissionFail("not_available");
      requireCommissionPolicy(policy, revision.policyRevisionId);
      const [settings] = await tx.select().from(creatorCommissionSettings).where(eq(creatorCommissionSettings.creatorUserId, row.creatorUserId)).limit(1);
      const creator = await visible(tx, row.pageId, row.creatorUserId, revision.showcaseId);
      if (!settings?.enabled || !creator) commissionFail("not_available");
      const receiving = command.requirePayment === false ? null : await input.receivingAccount.getCurrentTipReceivingAccount(tx, row.creatorUserId, command.at);
      if (command.requirePayment !== false && (!receiving || !commissionUuid(receiving.accountVersionId))) commissionFail("not_available");
      return { package: row, revision, creator, accountVersionId: receiving?.accountVersionId ?? null, capacityLimit: settings.capacityLimit, policy: policy! };
    },
    async listPublic(handle: string) {
      if (input.intakeMode !== "enabled" || input.publishingMode !== "general_audience" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(handle) || handle.length < 3 || handle.length > 30) return [];
      return input.db.transaction(async (tx) => {
        const [claim] = await tx.select().from(creatorHandleClaims).where(and(eq(creatorHandleClaims.normalizedHandle, handle), eq(creatorHandleClaims.kind, "canonical"))).limit(1);
        if (!claim) return [];
        const [page] = await tx.select().from(creatorPages).where(eq(creatorPages.id, claim.pageId)).limit(1);
        if (!page) return [];
        await lockCommissionCreator(tx, page.userId);
        const policy = await input.policy.readCurrent(tx, now());
        const creator = await visible(tx, page.id, page.userId, null); if (!creator || creator.canonicalHandle !== handle) return [];
        const [settings] = await tx.select().from(creatorCommissionSettings).where(eq(creatorCommissionSettings.creatorUserId, page.userId)).limit(1);
        const packages = await tx.select({ package: commissionPackages, revision: commissionPackageRevisions }).from(commissionPackages)
          .innerJoin(commissionPackageRevisions, eq(commissionPackageRevisions.id, commissionPackages.publishedRevisionId))
          .where(and(eq(commissionPackages.creatorUserId, page.userId), inArray(commissionPackages.state, ["open", "paused"]))).orderBy(asc(commissionPackages.createdAt), asc(commissionPackages.id)).limit(12);
        const used = await usage(tx, page.userId);
        const receiving = input.paymentsMode === "disabled" ? null : await input.receivingAccount.getCurrentTipReceivingAccount(tx, page.userId, now());
        const result = [];
        for (const entry of packages) {
          const linked = entry.revision.showcaseId ? await visible(tx, page.id, page.userId, entry.revision.showcaseId) : null;
          const revision: Revision = entry.revision;
          result.push({ id: entry.package.id, revisionId: revision.id, title: revision.title, description: revision.description, discipline: revision.discipline,
            route: revision.route, briefInstructions: revision.briefInstructions, terms: revision.terms, showcaseId: linked?.showcaseId ?? null,
            policy: policy?.revisionId === revision.policyRevisionId ? { revisionId: policy.revisionId, document: policy.document, checksum: policy.checksum } : null,
            accepting: entry.package.state === "open" && !!settings?.enabled && !!policy?.acceptsOrders && policy.revisionId === revision.policyRevisionId &&
              (revision.route !== "fixed_immediate" || !!receiving),
            capacityAvailable: !!settings && used < settings.capacityLimit });
        }
        return result;
      });
    },
  };
}
export type CommissionPackageService = ReturnType<typeof createCommissionPackageService>;
