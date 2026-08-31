import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  acquirePublicMediaRetentionFences,
  appendAdminAuditEvent,
  beginIdempotentCommand,
  completeIdempotentCommand,
  creatorPages,
  insertOutboxEvent,
  publicContentReports,
  publicContentTriageEvents,
  publicVisibilityHolds,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  normalizeReportReason,
  readExactOwnDataRecord,
  unicodeCodePointLength,
  validActorUserId,
  validUuid,
  type PublicReportReason,
} from "./report-policy.js";
import type {
  CatalogModerationSnapshotPort,
  ModerationTargetSnapshot,
  ReportTarget,
} from "./trust-ports.js";

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60_000;
const CONTROL = /\p{Cc}/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;

export type OwnerTriageCommand = Readonly<{
  ownerUserId: string;
  ownerSessionId: string;
  stepUpProofId: string;
  reportId: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
  requestId: string;
}>;

export type OwnerReportProjection = Readonly<{
  reportId: string;
  target: ReportTarget;
  reason: PublicReportReason;
  detail: string | null;
  state: "open" | "dismissed" | "held" | "closed";
  version: number;
  authenticatedReporter: boolean;
  snapshot: ModerationTargetSnapshot;
  activeHold: { holdId: string; targetType: "page" | "showcase" } | null;
}>;

export type CreatorEnforcementProjection = Readonly<{
  targetType: "page" | "showcase";
  targetId: string;
  held: boolean;
  explanation: string;
  occurredAt: string;
}>;

export type TriageResult = Readonly<{
  reportId: string;
  reportState: "dismissed" | "held" | "closed";
  reportVersion: number;
  holdId: string | null;
  holdVersion: number | null;
}>;

type StepUpInput = Readonly<{
  proofId: string;
  sessionId: string;
  userId: string;
  actionClass: string;
  now: Date;
}>;

type FactoryInput = Readonly<{
  db: PawketDatabase;
  catalogModeration: CatalogModerationSnapshotPort;
  commandFingerprintKey: Uint8Array;
  consumeStepUpProof: (tx: PawketTransaction, input: StepUpInput) => Promise<boolean>;
  clock?: () => Date;
  idFactory?: () => string;
}>;

type Action = "dismiss" | "hide" | "restore";
type SafeCommand = OwnerTriageCommand & Readonly<{ holdId: string | null }>;
type ReportRow = typeof publicContentReports.$inferSelect;

export class TriageServiceError extends Error {
  constructor(readonly code: "OWNER_TOTP_REQUIRED" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "INVALID_STATE" | "POLICY_VIOLATION" | "TRIAGE_UNAVAILABLE") {
    super(code);
    this.name = "TriageServiceError";
  }
}

function fail(code: TriageServiceError["code"]): never {
  throw new TriageServiceError(code);
}

function normalizedReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const normalized = value.normalize("NFC");
    return unicodeCodePointLength(normalized) >= 1 && unicodeCodePointLength(normalized) <= 200 && !CONTROL.test(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function normalizeCommand(value: unknown, action: Action): SafeCommand {
  const shapes = action === "restore"
    ? [["ownerUserId", "ownerSessionId", "stepUpProofId", "reportId", "expectedVersion", "reason", "idempotencyKey", "requestId", "holdId"]]
    : [["ownerUserId", "ownerSessionId", "stepUpProofId", "reportId", "expectedVersion", "reason", "idempotencyKey", "requestId"]];
  const command = readExactOwnDataRecord(value, shapes);
  const reason = normalizedReason(command?.reason);
  if (!command || !validActorUserId(command.ownerUserId) || !COMMAND_ID.test(command.ownerUserId)
    || typeof command.ownerSessionId !== "string" || !COMMAND_ID.test(command.ownerSessionId)
    || typeof command.stepUpProofId !== "string" || !COMMAND_ID.test(command.stepUpProofId)
    || !validUuid(command.reportId) || !Number.isInteger(command.expectedVersion) || (command.expectedVersion as number) < 1
    || !reason || typeof command.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || typeof command.requestId !== "string" || !COMMAND_ID.test(command.requestId)
    || (action === "restore" && !validUuid(command.holdId))) fail("POLICY_VIOLATION");
  return {
    ownerUserId: command.ownerUserId,
    ownerSessionId: command.ownerSessionId,
    stepUpProofId: command.stepUpProofId,
    reportId: command.reportId,
    expectedVersion: command.expectedVersion as number,
    reason,
    idempotencyKey: command.idempotencyKey,
    requestId: command.requestId,
    holdId: action === "restore" ? command.holdId as string : null,
  };
}

function safeDate(clock: () => Date): Date {
  try {
    const value = clock();
    if (!(value instanceof Date) || isProxy(value) || Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0 || Number.isNaN(value.getTime())) fail("TRIAGE_UNAVAILABLE");
    return new Date(value.getTime());
  } catch (error) {
    if (error instanceof TriageServiceError) throw error;
    fail("TRIAGE_UNAVAILABLE");
  }
}

function exactStringArray(value: unknown, maximum: number): readonly string[] | null {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true || !validUuid(descriptor.value)) return null;
      result.push(descriptor.value);
    }
    return new Set(result).size === result.length ? result : null;
  } catch {
    return null;
  }
}

function exactSnapshot(value: unknown, expected: ReportTarget): ModerationTargetSnapshot | null {
  const snapshot = readExactOwnDataRecord(value, [["target", "pageId", "creatorUserId", "canonicalHandle", "displayName", "showcaseTitle", "mediaAssetIds"]]);
  const target = readExactOwnDataRecord(snapshot?.target, [["targetType", "targetId", "publicationRevisionId"]]);
  const mediaAssetIds = exactStringArray(snapshot?.mediaAssetIds, 50);
  if (!snapshot || !target || target.targetType !== expected.targetType || target.targetId !== expected.targetId
    || target.publicationRevisionId !== expected.publicationRevisionId || !validUuid(snapshot.pageId)
    || !validActorUserId(snapshot.creatorUserId) || typeof snapshot.canonicalHandle !== "string"
    || typeof snapshot.displayName !== "string" || (expected.targetType === "page" ? snapshot.showcaseTitle !== null : typeof snapshot.showcaseTitle !== "string")
    || !mediaAssetIds) return null;
  return {
    target: expected,
    pageId: snapshot.pageId,
    creatorUserId: snapshot.creatorUserId,
    canonicalHandle: snapshot.canonicalHandle,
    displayName: snapshot.displayName,
    showcaseTitle: snapshot.showcaseTitle as string | null,
    mediaAssetIds,
  };
}

function reportTarget(report: ReportRow): ReportTarget | null {
  if ((report.targetType !== "page" && report.targetType !== "showcase") || !validUuid(report.targetId) || !validUuid(report.publicationRevisionId)) return null;
  return { targetType: report.targetType, targetId: report.targetId, publicationRevisionId: report.publicationRevisionId };
}

function fingerprint(input: FactoryInput, command: SafeCommand, action: Action) {
  try {
    return {
      keyHash: createLookupHmac({ value: command.idempotencyKey, context: "trust-triage-command-key", key: input.commandFingerprintKey }),
      requestFingerprint: createLookupHmac({
        value: JSON.stringify({ action, reportId: command.reportId, expectedVersion: command.expectedVersion, reason: command.reason, holdId: command.holdId }),
        context: "trust-triage-command",
        key: input.commandFingerprintKey,
      }),
    };
  } catch {
    fail("POLICY_VIOLATION");
  }
}

function resultReference(result: TriageResult): string {
  return `trust-triage-v1:${result.reportState}:${result.reportId}:${result.reportVersion}:${result.holdId ?? "none"}:${result.holdVersion ?? "none"}`;
}

function parseResultReference(value: string): TriageResult | null {
  const match = /^trust-triage-v1:(dismissed|held|closed):([0-9a-f-]{36}):([1-9][0-9]*):(none|[0-9a-f-]{36}):(none|[1-9][0-9]*)$/iu.exec(value);
  if (!match || !validUuid(match[2])) return null;
  const reportVersion = Number(match[3]);
  const holdId = match[4] === "none" ? null : match[4]!;
  const holdVersion = match[5] === "none" ? null : Number(match[5]);
  if (!Number.isSafeInteger(reportVersion) || (holdId === null) !== (holdVersion === null) || (holdId !== null && !validUuid(holdId))) return null;
  return { reportId: match[2]!, reportState: match[1] as TriageResult["reportState"], reportVersion, holdId, holdVersion };
}

function snapshotOwnMethod(value: unknown, name: string): { receiver: object; method: (...arguments_: never[]) => unknown } | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value) || Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) return null;
    return { receiver: value, method: descriptor.value as (...arguments_: never[]) => unknown };
  } catch {
    return null;
  }
}

function snapshotFactoryInput(value: unknown): FactoryInput {
  const record = readExactOwnDataRecord(value, [
    ["db", "catalogModeration", "commandFingerprintKey", "consumeStepUpProof"],
    ["db", "catalogModeration", "commandFingerprintKey", "consumeStepUpProof", "clock"],
    ["db", "catalogModeration", "commandFingerprintKey", "consumeStepUpProof", "idFactory"],
    ["db", "catalogModeration", "commandFingerprintKey", "consumeStepUpProof", "clock", "idFactory"],
  ]);
  const resolveVisible = snapshotOwnMethod(record?.catalogModeration, "resolveVisibleReportTarget");
  const readRevision = snapshotOwnMethod(record?.catalogModeration, "readRevisionTarget");
  if (!record || record.db === null || typeof record.db !== "object" || isProxy(record.db)
    || !(record.commandFingerprintKey instanceof Uint8Array) || isProxy(record.commandFingerprintKey) || record.commandFingerprintKey.byteLength < 32 || record.commandFingerprintKey.byteLength > 128
    || typeof record.consumeStepUpProof !== "function" || isProxy(record.consumeStepUpProof)
    || !resolveVisible || !readRevision
    || (record.clock !== undefined && (typeof record.clock !== "function" || isProxy(record.clock)))
    || (record.idFactory !== undefined && (typeof record.idFactory !== "function" || isProxy(record.idFactory)))) fail("TRIAGE_UNAVAILABLE");
  return {
    db: record.db as PawketDatabase,
    commandFingerprintKey: Uint8Array.from(record.commandFingerprintKey),
    consumeStepUpProof: record.consumeStepUpProof as FactoryInput["consumeStepUpProof"],
    catalogModeration: {
      resolveVisibleReportTarget: (database, target) => Reflect.apply(resolveVisible.method, resolveVisible.receiver, [database, target]) as ReturnType<CatalogModerationSnapshotPort["resolveVisibleReportTarget"]>,
      readRevisionTarget: (database, target) => Reflect.apply(readRevision.method, readRevision.receiver, [database, target]) as ReturnType<CatalogModerationSnapshotPort["readRevisionTarget"]>,
    },
    ...(record.clock === undefined ? {} : { clock: record.clock as () => Date }),
    ...(record.idFactory === undefined ? {} : { idFactory: record.idFactory as () => string }),
  };
}

async function transitionReport(tx: PawketTransaction, reportId: string, expectedVersion: number, nextState: TriageResult["reportState"], at: Date) {
  const rows = await tx.execute<{ report_id: string; report_state: string; report_version: number }>(sql`
    select report_id, report_state, report_version
    from trust_transition_public_content_report(${reportId}::uuid, ${expectedVersion}, ${nextState}, ${at.toISOString()}::timestamptz)
  `);
  const row = rows[0];
  if (!row || row.report_state !== nextState || row.report_version !== expectedVersion + 1) fail("VERSION_CONFLICT");
  return row;
}

async function protectedAssetIds(database: PawketDatabase | PawketTransaction, assetIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (!Array.isArray(assetIds) || assetIds.length > 500 || assetIds.some((assetId) => !validUuid(assetId))) return new Set();
  const candidates = [...new Set(assetIds)];
  if (candidates.length === 0) return new Set();
  const candidateValues = sql.join(candidates.map((assetId) => sql`(${assetId}::uuid)`), sql`, `);
  const rows = await database.execute<{ asset_id: string }>(sql`
    with candidate_ids(asset_id) as (values ${candidateValues}),
    report_targets as (
      select target_type, target_id, publication_revision_id
      from public_content_reports
      where state = 'open'
      union all
      select target_type, target_id, publication_revision_id
      from public_visibility_holds
      where released_at is null
    ), target_assets as (
      select revision.avatar_asset_id as asset_id
      from report_targets target
      join creator_publication_revisions revision on revision.id = target.publication_revision_id
      where target.target_type = 'page' and target.target_id = revision.page_id and revision.avatar_asset_id is not null
      union
      select revision.cover_asset_id as asset_id
      from report_targets target
      join creator_publication_revisions revision on revision.id = target.publication_revision_id
      where target.target_type = 'page' and target.target_id = revision.page_id and revision.cover_asset_id is not null
      union
      select media.asset_id
      from report_targets target
      join creator_publication_showcases showcase on showcase.revision_id = target.publication_revision_id
        and (target.target_type = 'page' or (target.target_type = 'showcase' and target.target_id = showcase.source_showcase_id))
      join creator_publication_media media on media.publication_showcase_id = showcase.id
    ), held_owners as (
      select distinct hold.subject_id as owner_user_id
      from system_retention_holds hold
      where hold.released_at is null and hold.reason_category in ('incident', 'legal') and hold.subject_type = 'user'
      union
      select distinct application.user_id
      from system_retention_holds hold
      join creator_applications application on hold.subject_type = 'creator_application' and hold.subject_id = application.id::text
      where hold.released_at is null and hold.reason_category in ('incident', 'legal')
    )
    select candidate.asset_id::text as asset_id
    from candidate_ids candidate
    where exists (select 1 from target_assets target where target.asset_id = candidate.asset_id)
       or exists (
         select 1 from public_media_assets asset
         join held_owners owner on owner.owner_user_id = asset.owner_user_id
         where asset.id = candidate.asset_id
       )
  `);
  return new Set(rows.map((row) => row.asset_id));
}

export function createTriageService(value: FactoryInput) {
  const input = snapshotFactoryInput(value);
  const clock = input.clock ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;

  async function readRevisionSnapshot(database: PawketDatabase | PawketTransaction, target: ReportTarget): Promise<ModerationTargetSnapshot> {
    try {
      const snapshot = exactSnapshot(await input.catalogModeration.readRevisionTarget(database, target), target);
      if (!snapshot) fail("NOT_FOUND");
      return snapshot;
    } catch (error) {
      if (error instanceof TriageServiceError) throw error;
      fail("TRIAGE_UNAVAILABLE");
    }
  }

  async function action(value: unknown, actionName: Action): Promise<TriageResult> {
    const command = normalizeCommand(value, actionName);
    const at = safeDate(clock);
    const hashes = fingerprint(input, command, actionName);
    return input.db.transaction(async (tx) => {
      const [unlockedReport] = await tx.select().from(publicContentReports).where(eq(publicContentReports.id, command.reportId)).limit(1);
      const unlockedTarget = unlockedReport ? reportTarget(unlockedReport) : null;
      if (!unlockedTarget) fail("NOT_FOUND");
      const initialSnapshot = await readRevisionSnapshot(tx, unlockedTarget);
      const [page] = await tx.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.id, initialSnapshot.pageId)).limit(1).for("update");
      if (!page) fail("NOT_FOUND");
      const snapshot = await readRevisionSnapshot(tx, unlockedTarget);
      if (snapshot.pageId !== page.id) fail("NOT_FOUND");
      const [report] = await tx.select().from(publicContentReports).where(eq(publicContentReports.id, command.reportId)).limit(1).for("update");
      const target = report ? reportTarget(report) : null;
      if (!report || !target || JSON.stringify(target) !== JSON.stringify(unlockedTarget)) fail("NOT_FOUND");

      const started = await beginIdempotentCommand(tx, {
        actorUserId: command.ownerUserId,
        commandScope: `trust.public_report.${actionName}`,
        ...hashes,
        now: at,
        expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS),
      });
      if (started.kind === "replay") {
        const replay = parseResultReference(started.resultReference);
        if (!replay || replay.reportId !== report.id) fail("IDEMPOTENCY_CONFLICT");
        return replay;
      }
      if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");

      let proofAccepted = false;
      try {
        proofAccepted = await input.consumeStepUpProof(tx, {
          proofId: command.stepUpProofId,
          sessionId: command.ownerSessionId,
          userId: command.ownerUserId,
          actionClass: `owner.public_report_${actionName}`,
          now: at,
        });
      } catch {
        fail("OWNER_TOTP_REQUIRED");
      }
      if (!proofAccepted) fail("OWNER_TOTP_REQUIRED");
      if (report.version !== command.expectedVersion) fail("VERSION_CONFLICT");
      const expectedState = actionName === "restore" ? "held" : "open";
      if (report.state !== expectedState) fail("INVALID_STATE");

      if (actionName === "hide" && snapshot.mediaAssetIds.length > 0) {
        await acquirePublicMediaRetentionFences(tx, snapshot.mediaAssetIds);
        const revalidated = await readRevisionSnapshot(tx, target);
        if (JSON.stringify(revalidated.mediaAssetIds) !== JSON.stringify(snapshot.mediaAssetIds)) fail("TRIAGE_UNAVAILABLE");
      }

      const nextState = actionName === "dismiss" ? "dismissed" : actionName === "hide" ? "held" : "closed";
      const transitioned = await transitionReport(tx, report.id, report.version, nextState, at);
      let holdId: string | null = null;
      let holdVersion: number | null = null;
      if (actionName === "hide") {
        holdId = id();
        if (!validUuid(holdId)) fail("TRIAGE_UNAVAILABLE");
        const [hold] = await tx.insert(publicVisibilityHolds).values({
          id: holdId,
          reportId: report.id,
          targetType: target.targetType,
          targetId: target.targetId,
          publicationRevisionId: target.publicationRevisionId,
          reason: command.reason,
          actorUserId: command.ownerUserId,
          actorSessionId: command.ownerSessionId,
          requestId: command.requestId,
          version: 1,
          createdAt: at,
        }).returning({ id: publicVisibilityHolds.id, version: publicVisibilityHolds.version });
        if (!hold) fail("TRIAGE_UNAVAILABLE");
        holdVersion = hold.version;
      } else if (actionName === "restore") {
        const [hold] = await tx.select().from(publicVisibilityHolds).where(and(
          eq(publicVisibilityHolds.id, command.holdId!),
          eq(publicVisibilityHolds.reportId, report.id),
        )).limit(1).for("update");
        if (!hold || hold.releasedAt !== null || hold.targetType !== target.targetType || hold.targetId !== target.targetId) fail("INVALID_STATE");
        const [released] = await tx.update(publicVisibilityHolds).set({
          releasedAt: at,
          releasedByUserId: command.ownerUserId,
          releasedBySessionId: command.ownerSessionId,
          releaseReason: command.reason,
          releaseRequestId: command.requestId,
          version: hold.version + 1,
        }).where(and(eq(publicVisibilityHolds.id, hold.id), isNull(publicVisibilityHolds.releasedAt), eq(publicVisibilityHolds.version, hold.version))).returning({ id: publicVisibilityHolds.id, version: publicVisibilityHolds.version });
        if (!released) fail("VERSION_CONFLICT");
        holdId = released.id;
        holdVersion = released.version;
      }

      await tx.insert(publicContentTriageEvents).values({
        id: id(),
        reportId: report.id,
        holdId,
        action: actionName,
        actorUserId: command.ownerUserId,
        actorSessionId: command.ownerSessionId,
        reason: command.reason,
        requestId: command.requestId,
        expectedReportVersion: report.version,
        resultingReportVersion: transitioned.report_version,
        beforeState: report.state,
        afterState: nextState,
        occurredAt: at,
      });
      await appendAdminAuditEvent(tx, {
        actorUserId: command.ownerUserId,
        actorSessionId: command.ownerSessionId,
        subjectType: "public_content_report",
        subjectId: report.id,
        action: `trust.public_report.${actionName}`,
        outcome: "succeeded",
        beforeState: { reportId: report.id, state: report.state, version: report.version, holdId: actionName === "restore" ? holdId : null },
        afterState: { reportId: report.id, state: nextState, version: transitioned.report_version, holdId },
        assurance: { method: "totp", actionClass: `owner.public_report_${actionName}` },
        applicationRevision: target.publicationRevisionId,
        requestId: command.requestId,
        occurredAt: at,
      });
      await insertOutboxEvent(tx, {
        eventType: "trust.public_report_triaged.v1",
        eventVersion: 1,
        aggregateType: "public_content_report",
        aggregateId: report.id,
        payload: {
          reportId: report.id,
          targetType: target.targetType,
          targetId: target.targetId,
          publicationRevisionId: target.publicationRevisionId,
          action: actionName,
          state: nextState,
          holdId,
          correlationId: command.requestId,
        },
        occurredAt: at,
      });
      const result: TriageResult = { reportId: report.id, reportState: nextState, reportVersion: transitioned.report_version, holdId, holdVersion };
      if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: resultReference(result), completedAt: at })) fail("IDEMPOTENCY_CONFLICT");
      return result;
    });
  }

  async function project(report: ReportRow): Promise<OwnerReportProjection> {
    const target = reportTarget(report);
    const reason = normalizeReportReason(report.reason);
    if (!target || !reason) fail("TRIAGE_UNAVAILABLE");
    const snapshot = await readRevisionSnapshot(input.db, target);
    const [hold] = await input.db.select({ id: publicVisibilityHolds.id, targetType: publicVisibilityHolds.targetType }).from(publicVisibilityHolds).where(and(
      eq(publicVisibilityHolds.reportId, report.id),
      isNull(publicVisibilityHolds.releasedAt),
    )).limit(1);
    return {
      reportId: report.id,
      target,
      reason,
      detail: report.detail,
      state: report.state as OwnerReportProjection["state"],
      version: report.version,
      authenticatedReporter: report.reporterUserId !== null,
      snapshot,
      activeHold: hold ? { holdId: hold.id, targetType: hold.targetType as "page" | "showcase" } : null,
    };
  }

  async function readHolds(database: PawketDatabase | PawketTransaction, pageId: string, revisionId: string, showcaseIds: readonly string[]) {
    if (!validUuid(pageId) || !validUuid(revisionId) || !Array.isArray(showcaseIds) || showcaseIds.length > 12 || showcaseIds.some((item) => !validUuid(item))) return { pageHeld: true, heldShowcaseIds: new Set<string>() };
    const targetIds = [pageId, ...showcaseIds];
    const rows = await database.select({ targetType: publicVisibilityHolds.targetType, targetId: publicVisibilityHolds.targetId }).from(publicVisibilityHolds).where(and(
      isNull(publicVisibilityHolds.releasedAt),
      inArray(publicVisibilityHolds.targetId, targetIds),
    ));
    return {
      pageHeld: rows.some((row) => row.targetType === "page" && row.targetId === pageId),
      heldShowcaseIds: new Set(rows.filter((row) => row.targetType === "showcase" && showcaseIds.includes(row.targetId)).map((row) => row.targetId)),
    };
  }

  const visibilityReadPort = {
    readHolds,
    async readHoldsBatch(database: PawketDatabase | PawketTransaction, requests: readonly Readonly<{ pageId: string; revisionId: string; showcaseIds: readonly string[] }>[]) {
      if (!Array.isArray(requests) || requests.length > 48) return new Map<string, { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }>();
      if (requests.some((request) => !validUuid(request.pageId) || !validUuid(request.revisionId) || !Array.isArray(request.showcaseIds) || request.showcaseIds.length > 12 || request.showcaseIds.some((id: unknown) => !validUuid(id)))) return new Map();
      const targetIds = [...new Set(requests.flatMap((request) => [request.pageId, ...request.showcaseIds]))];
      const rows = targetIds.length === 0 ? [] : await database.select({ targetType: publicVisibilityHolds.targetType, targetId: publicVisibilityHolds.targetId }).from(publicVisibilityHolds).where(and(
        isNull(publicVisibilityHolds.releasedAt),
        inArray(publicVisibilityHolds.targetId, targetIds),
      ));
      const result = new Map<string, { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }>();
      for (const request of requests) result.set(request.pageId, {
        pageHeld: rows.some((row) => row.targetType === "page" && row.targetId === request.pageId),
        heldShowcaseIds: new Set(rows.filter((row) => row.targetType === "showcase" && request.showcaseIds.includes(row.targetId)).map((row) => row.targetId)),
      });
      return result;
    },
  };

  const publicMediaRetentionHoldPort = { protectedAssetIds };

  return {
    async listQueue(): Promise<readonly OwnerReportProjection[]> {
      const reports = await input.db.select().from(publicContentReports).where(or(
        eq(publicContentReports.state, "open"),
        eq(publicContentReports.state, "held"),
      )).orderBy(asc(publicContentReports.createdAt), asc(publicContentReports.id)).limit(100);
      return Promise.all(reports.map(project));
    },
    async getDetail(reportId: string): Promise<OwnerReportProjection> {
      if (!validUuid(reportId)) fail("POLICY_VIOLATION");
      const [report] = await input.db.select().from(publicContentReports).where(eq(publicContentReports.id, reportId)).limit(1);
      if (!report) fail("NOT_FOUND");
      return project(report);
    },
    async listCreatorEnforcements(creatorUserId: string): Promise<readonly CreatorEnforcementProjection[]> {
      if (!validActorUserId(creatorUserId)) fail("POLICY_VIOLATION");
      const rows = await input.db.execute<{ target_type: "page" | "showcase"; target_id: string; held: boolean; explanation: string; occurred_at: Date | string }>(sql`
        select hold.target_type, hold.target_id,
          (hold.released_at is null) as held,
          case when hold.released_at is null then hold.reason else hold.release_reason end as explanation,
          coalesce(hold.released_at, hold.created_at) as occurred_at
        from public_visibility_holds hold
        join creator_publication_revisions revision on revision.id = hold.publication_revision_id
        join creator_pages page on page.id = revision.page_id
        where page.user_id = ${creatorUserId}
        order by coalesce(hold.released_at, hold.created_at), hold.id
        limit 100
      `);
      return rows.map((row) => ({ targetType: row.target_type, targetId: row.target_id, held: row.held, explanation: row.explanation, occurredAt: (row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at)).toISOString() }));
    },
    async dismiss(command: OwnerTriageCommand) {
      try { return await action(command, "dismiss"); }
      catch (error) { if (error instanceof TriageServiceError) throw error; fail("TRIAGE_UNAVAILABLE"); }
    },
    async hide(command: OwnerTriageCommand) {
      try { return await action(command, "hide"); }
      catch (error) { if (error instanceof TriageServiceError) throw error; fail("TRIAGE_UNAVAILABLE"); }
    },
    async restore(command: OwnerTriageCommand & Readonly<{ holdId: string }>) {
      try { return await action(command, "restore"); }
      catch (error) { if (error instanceof TriageServiceError) throw error; fail("TRIAGE_UNAVAILABLE"); }
    },
    readActiveStableTargetHolds: readHolds,
    findAssetsProtectedByReportsOrHolds: protectedAssetIds,
    visibilityReadPort,
    publicMediaRetentionHoldPort,
  };
}
