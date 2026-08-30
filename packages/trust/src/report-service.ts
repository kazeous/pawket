import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  insertOutboxEvent,
  publicContentReports,
  publicReportChallenges,
  publicReportSecurityEvents,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { constantTimeEqual, hashOpaqueToken } from "@pawket/security";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import {
  normalizeReportDetail,
  normalizeReportReason,
  normalizeReportTarget,
  readExactOwnDataRecord,
  unicodeCodePointLength,
  validActorUserId,
  validNetworkKeyHmac,
  validUuid,
  type PublicReportReason,
} from "./report-policy.js";
import type {
  CatalogModerationSnapshotPort,
  ModerationTargetSnapshot,
  ReportTarget,
} from "./trust-ports.js";

export type ReportChallenge = Readonly<{
  token: string;
  difficulty: 18;
  expiresAt: string;
}>;

export type GuestReportCommand = Readonly<{
  requester: Readonly<{ kind: "guest"; networkKeyHmac: string }>;
  target: ReportTarget;
  reason: PublicReportReason;
  detail?: string | null;
  challenge: Readonly<{ token: string; solution: number }>;
}>;

export type AuthenticatedReportCommand = Readonly<{
  requester: Readonly<{ kind: "authenticated"; actorUserId: string }>;
  target: ReportTarget;
  reason: PublicReportReason;
  detail?: string | null;
}>;

export type SubmitReportCommand = GuestReportCommand | AuthenticatedReportCommand;

type SafeRequester =
  | Readonly<{ kind: "guest"; networkKeyHmac: string }>
  | Readonly<{ kind: "authenticated"; actorUserId: string }>;
type SafeCommand = Readonly<{
  requester: SafeRequester;
  target: ReportTarget;
  reason: PublicReportReason;
  detail: string | null;
  challenge: Readonly<{ token: string; solution: number }> | null;
}>;
type RejectCategory = "invalid_target" | "invalid_challenge" | "rate_limited" | "duplicate";

const CHALLENGE_LIFETIME_MS = 10 * 60_000;
const SECURITY_RETENTION_MS = 24 * 60 * 60_000;
const REQUESTER_WINDOW_MS = 15 * 60_000;
const GUEST_REQUESTER_LIMIT = 5;
const ACTOR_REQUESTER_LIMIT = 10;
const TARGET_REVISION_LIMIT = 3;
const ACTIVE_CHALLENGE_LIMIT = 5;
const CHALLENGE_CLEANUP_LIMIT = 20;
const GUEST_REJECTION_LIMIT = 5;
const ACTOR_REJECTION_LIMIT = 10;
const CHALLENGE_DIFFICULTY = 18 as const;
const TOKEN = /^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]{43}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const dateGetTime = Date.prototype.getTime;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const arrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const arrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const arrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const TRANSACTION_ISSUED = Object.freeze({ issued: true });
const TRANSACTION_CAPPED = Object.freeze({ capped: true });
const TRANSACTION_ACCEPTED = Object.freeze({ accepted: true });
const TRANSACTION_REJECTED = Object.freeze({ rejected: true });
const TRANSACTION_EXHAUSTED = Object.freeze({ exhausted: true });

export class PublicReportError extends Error {
  readonly code = "REPORT_NOT_ACCEPTED" as const;
  constructor(readonly status: 400 | 429 = 400) {
    super("REPORT_NOT_ACCEPTED");
    this.name = "PublicReportError";
  }
}

function fail(status: 400 | 429 = 400): never {
  throw new PublicReportError(status);
}

function snapshotKey(value: Uint8Array): Buffer {
  try {
    if (!ArrayBuffer.isView(value) || isProxy(value) || !arrayBufferGetter || !arrayByteOffsetGetter || !arrayByteLengthGetter) fail();
    const sourceBuffer = Reflect.apply(arrayBufferGetter, value, []) as ArrayBufferLike;
    const byteOffset = Reflect.apply(arrayByteOffsetGetter, value, []) as number;
    const byteLength = Reflect.apply(arrayByteLengthGetter, value, []) as number;
    if (sourceBuffer instanceof SharedArrayBuffer || byteLength < 32 || byteLength > 128) fail();
    const copy = Buffer.alloc(byteLength);
    Uint8Array.prototype.set.call(copy, new Uint8Array(sourceBuffer, byteOffset, byteLength));
    return copy;
  } catch {
    fail();
  }
}

function safeNow(clock: () => Date): Date {
  try {
    const value = clock();
    if (value === null || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0) fail();
    const time = Reflect.apply(dateGetTime, value, []) as number;
    if (!Number.isFinite(time) || !Number.isInteger(time)) fail();
    return new Date(time);
  } catch {
    fail();
  }
}

function safeNonce(provider: () => string): string {
  try {
    const value = provider();
    if (typeof value !== "string" || !NONCE.test(value)) fail();
    return value;
  } catch {
    fail();
  }
}

function signPayload(payload: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

function issueToken(now: Date, nonce: string, key: Uint8Array): ReportChallenge {
  const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS);
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    nonce,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }), "utf8").toString("base64url");
  return { token: `${payload}.${signPayload(payload, key)}`, difficulty: CHALLENGE_DIFFICULTY, expiresAt: expiresAt.toISOString() };
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || value.length !== 24) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return date.toISOString() === value ? date : null;
}

function verifySignedToken(token: string, solution: number, now: Date, key: Uint8Array): boolean {
  try {
    if (token.length > 512 || !TOKEN.test(token) || !Number.isSafeInteger(solution) || solution < 0) return false;
    const separator = token.indexOf(".");
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = signPayload(payload, key);
    if (!constantTimeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) return false;
    const decodedText = Buffer.from(payload, "base64url").toString("utf8");
    const decoded = readExactOwnDataRecord(JSON.parse(decodedText) as unknown, [["version", "nonce", "issuedAt", "expiresAt"]]);
    if (!decoded || decoded.version !== 1 || typeof decoded.nonce !== "string" || !NONCE.test(decoded.nonce)) return false;
    const issuedAt = parseIso(decoded.issuedAt);
    const expiresAt = parseIso(decoded.expiresAt);
    if (!issuedAt || !expiresAt || expiresAt.getTime() - issuedAt.getTime() !== CHALLENGE_LIFETIME_MS
      || now.getTime() < issuedAt.getTime() || now.getTime() >= expiresAt.getTime()) return false;
    const canonical = Buffer.from(JSON.stringify({ version: 1, nonce: decoded.nonce, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() }), "utf8").toString("base64url");
    if (!constantTimeEqual(Buffer.from(payload, "utf8"), Buffer.from(canonical, "utf8"))) return false;
    return leadingZeroBits(createHash("sha256").update(`${token}.${solution}`, "utf8").digest()) >= CHALLENGE_DIFFICULTY;
  } catch {
    return false;
  }
}

function leadingZeroBits(value: Uint8Array): number {
  let bits = 0;
  for (const byte of value) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function exactArray(value: unknown, maximum: number): string[] | null {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length !== value.length + 1 || !keys.includes("length")) return null;
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

function exactModerationSnapshot(value: unknown, expected: ReportTarget): ModerationTargetSnapshot | null {
  const record = readExactOwnDataRecord(value, [["target", "pageId", "creatorUserId", "canonicalHandle", "displayName", "showcaseTitle", "mediaAssetIds"]]);
  if (!record) return null;
  const target = normalizeReportTarget(record.target);
  if (!target || target.targetType !== expected.targetType || target.targetId !== expected.targetId || target.publicationRevisionId !== expected.publicationRevisionId
    || !validUuid(record.pageId) || !validActorUserId(record.creatorUserId)
    || (target.targetType === "page" && record.pageId !== target.targetId)
    || typeof record.canonicalHandle !== "string" || record.canonicalHandle.length < 3 || record.canonicalHandle.length > 30 || !HANDLE.test(record.canonicalHandle)
    || typeof record.displayName !== "string" || unicodeCodePointLength(record.displayName) < 1 || unicodeCodePointLength(record.displayName) > 80
    || (target.targetType === "page" ? record.showcaseTitle !== null : typeof record.showcaseTitle !== "string" || unicodeCodePointLength(record.showcaseTitle) < 1 || unicodeCodePointLength(record.showcaseTitle) > 100)) return null;
  const mediaAssetIds = exactArray(record.mediaAssetIds, 50);
  if (!mediaAssetIds) return null;
  return {
    target,
    pageId: record.pageId,
    creatorUserId: record.creatorUserId,
    canonicalHandle: record.canonicalHandle,
    displayName: record.displayName,
    showcaseTitle: record.showcaseTitle as string | null,
    mediaAssetIds,
  };
}

function normalizeIssueCommand(value: unknown): { networkKeyHmac: string } | null {
  const record = readExactOwnDataRecord(value, [["networkKeyHmac"]]);
  return record && validNetworkKeyHmac(record.networkKeyHmac) ? { networkKeyHmac: record.networkKeyHmac } : null;
}

function normalizeSubmitCommand(value: unknown): SafeCommand | null {
  const record = readExactOwnDataRecord(value, [
    ["requester", "target", "reason", "challenge"],
    ["requester", "target", "reason", "detail", "challenge"],
    ["requester", "target", "reason"],
    ["requester", "target", "reason", "detail"],
  ]);
  if (!record) return null;
  const target = normalizeReportTarget(record.target);
  const reason = normalizeReportReason(record.reason);
  const hasDetail = Object.prototype.hasOwnProperty.call(record, "detail");
  const detail = normalizeReportDetail(record.detail);
  if (!target || !reason || (hasDetail && record.detail !== null && record.detail !== undefined && (typeof record.detail !== "string" || detail === null))) return null;
  const requester = readExactOwnDataRecord(record.requester, [["kind", "networkKeyHmac"], ["kind", "actorUserId"]]);
  if (!requester) return null;
  if (requester.kind === "guest" && validNetworkKeyHmac(requester.networkKeyHmac)) {
    const challenge = readExactOwnDataRecord(record.challenge, [["token", "solution"]]);
    if (!challenge || typeof challenge.token !== "string" || challenge.token.length > 512 || !Number.isSafeInteger(challenge.solution) || (challenge.solution as number) < 0) return null;
    return { requester: { kind: "guest", networkKeyHmac: requester.networkKeyHmac }, target, reason, detail, challenge: { token: challenge.token, solution: challenge.solution as number } };
  }
  if (requester.kind === "authenticated" && validActorUserId(requester.actorUserId) && record.challenge === undefined) {
    return { requester: { kind: "authenticated", actorUserId: requester.actorUserId }, target, reason, detail, challenge: null };
  }
  return null;
}

function targetHashes(target: ReportTarget) {
  return {
    targetHash: hashOpaqueToken(`${target.targetType}:${target.targetId}`, "public-report-target"),
    revisionHash: hashOpaqueToken(target.publicationRevisionId, "public-report-revision"),
  };
}

async function lockRequester(tx: PawketTransaction, requester: SafeRequester) {
  const requesterKey = requester.kind === "guest" ? requester.networkKeyHmac : requester.actorUserId;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pawket.trust.requester.${requester.kind}.${requesterKey}`}, 0))`);
}

async function lockAbuseKeys(tx: PawketTransaction, requester: SafeRequester, targetHash: string, revisionHash: string) {
  await lockRequester(tx, requester);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pawket.trust.target.${targetHash}.${revisionHash}`}, 0))`);
}

async function insertSecurityEvent(
  tx: PawketTransaction,
  input: { requester: SafeRequester; targetHash: string; revisionHash: string; outcome: "accepted" | "rejected"; category: "accepted" | RejectCategory; now: Date },
) {
  await tx.insert(publicReportSecurityEvents).values({
    id: randomUUID(),
    requesterKind: input.requester.kind,
    networkKeyHmac: input.requester.kind === "guest" ? input.requester.networkKeyHmac : null,
    actorUserId: input.requester.kind === "authenticated" ? input.requester.actorUserId : null,
    targetHash: input.targetHash,
    revisionHash: input.revisionHash,
    outcome: input.outcome,
    outcomeCategory: input.category,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + SECURITY_RETENTION_MS),
  });
}

async function insertRejectedSecurityEventIfAllowed(
  tx: PawketTransaction,
  input: { requester: SafeRequester; targetHash: string; revisionHash: string; category: RejectCategory; now: Date },
) {
  const cutoff = new Date(input.now.getTime() - REQUESTER_WINDOW_MS);
  const rows = input.requester.kind === "guest"
    ? await tx.execute<{ count: number }>(sql`select count(*)::int as count from public_report_security_events where outcome = 'rejected' and network_key_hmac = ${input.requester.networkKeyHmac} and created_at >= ${cutoff.toISOString()}::timestamptz and expires_at > ${input.now.toISOString()}::timestamptz`)
    : await tx.execute<{ count: number }>(sql`select count(*)::int as count from public_report_security_events where outcome = 'rejected' and actor_user_id = ${input.requester.actorUserId} and created_at >= ${cutoff.toISOString()}::timestamptz and expires_at > ${input.now.toISOString()}::timestamptz`);
  const limit = input.requester.kind === "guest" ? GUEST_REJECTION_LIMIT : ACTOR_REJECTION_LIMIT;
  if ((rows[0]?.count ?? 0) < limit) {
    await insertSecurityEvent(tx, { ...input, outcome: "rejected" });
  }
}

async function countAccepted(tx: PawketTransaction, requester: SafeRequester, targetHash: string, revisionHash: string, now: Date) {
  const requesterCutoff = new Date(now.getTime() - REQUESTER_WINDOW_MS);
  const targetCutoff = new Date(now.getTime() - SECURITY_RETENTION_MS);
  const requesterRows = requester.kind === "guest"
    ? await tx.execute<{ count: number }>(sql`select count(*)::int as count from public_report_security_events where outcome = 'accepted' and network_key_hmac = ${requester.networkKeyHmac} and created_at >= ${requesterCutoff.toISOString()}::timestamptz and expires_at > ${now.toISOString()}::timestamptz`)
    : await tx.execute<{ count: number }>(sql`select count(*)::int as count from public_report_security_events where outcome = 'accepted' and actor_user_id = ${requester.actorUserId} and created_at >= ${requesterCutoff.toISOString()}::timestamptz and expires_at > ${now.toISOString()}::timestamptz`);
  const targetRows = await tx.execute<{ count: number }>(sql`select count(*)::int as count from public_report_security_events where outcome = 'accepted' and target_hash = ${targetHash} and revision_hash = ${revisionHash} and created_at >= ${targetCutoff.toISOString()}::timestamptz and expires_at > ${now.toISOString()}::timestamptz`);
  return { requester: requesterRows[0]?.count ?? 0, target: targetRows[0]?.count ?? 0 };
}

async function duplicateExists(tx: PawketTransaction, requester: SafeRequester, target: ReportTarget, targetHash: string, revisionHash: string, now: Date) {
  if (requester.kind === "authenticated") {
    const rows = await tx.select({ id: publicContentReports.id }).from(publicContentReports).where(and(
      eq(publicContentReports.targetType, target.targetType),
      eq(publicContentReports.targetId, target.targetId),
      eq(publicContentReports.publicationRevisionId, target.publicationRevisionId),
      eq(publicContentReports.reporterUserId, requester.actorUserId),
    )).limit(1);
    return rows.length > 0;
  }
  const rows = await tx.execute<{ present: boolean }>(sql`select exists(
    select 1 from public_report_security_events
    where outcome = 'accepted' and network_key_hmac = ${requester.networkKeyHmac}
      and target_hash = ${targetHash} and revision_hash = ${revisionHash}
      and expires_at > ${now.toISOString()}::timestamptz
  ) as present`);
  return rows[0]?.present === true;
}

type ReportServiceFactoryInput = Readonly<{
  db: PawketDatabase;
  catalogModeration: CatalogModerationSnapshotPort;
  lookupHmacKey: Uint8Array;
  clock?: () => Date;
  nonce?: () => string;
}>;

function snapshotOwnMethod(value: unknown, name: string): { receiver: object; method: (...arguments_: never[]) => unknown } | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) return null;
    return { receiver: value, method: descriptor.value as (...arguments_: never[]) => unknown };
  } catch {
    return null;
  }
}

function snapshotInheritedMethod(value: unknown, name: string): { receiver: object; method: (...arguments_: never[]) => unknown } | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    let owner: object | null = value;
    for (let depth = 0; owner && depth < 8; depth += 1) {
      if (isProxy(owner)) return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) return null;
        return { receiver: value, method: descriptor.value as (...arguments_: never[]) => unknown };
      }
      owner = Reflect.getPrototypeOf(owner);
    }
    return null;
  } catch {
    return null;
  }
}

function snapshotCallable(value: unknown): ((...arguments_: never[]) => unknown) | null {
  try {
    return typeof value === "function" && !isProxy(value) ? value as (...arguments_: never[]) => unknown : null;
  } catch {
    return null;
  }
}

function snapshotFactory(input: unknown) {
  try {
    const record = readExactOwnDataRecord(input, [
      ["db", "catalogModeration", "lookupHmacKey"],
      ["db", "catalogModeration", "lookupHmacKey", "clock"],
      ["db", "catalogModeration", "lookupHmacKey", "nonce"],
      ["db", "catalogModeration", "lookupHmacKey", "clock", "nonce"],
    ]);
    if (!record) fail();
    const transaction = snapshotInheritedMethod(record.db, "transaction");
    const resolveVisible = snapshotOwnMethod(record.catalogModeration, "resolveVisibleReportTarget");
    const readRevision = snapshotOwnMethod(record.catalogModeration, "readRevisionTarget");
    const clock = record.clock === undefined ? (() => new Date()) : snapshotCallable(record.clock);
    const nonce = record.nonce === undefined ? (() => randomBytes(24).toString("base64url")) : snapshotCallable(record.nonce);
    if (!transaction || !resolveVisible || !readRevision || !clock || !nonce) fail();
    return {
      key: snapshotKey(record.lookupHmacKey as Uint8Array),
      clock: clock as () => Date,
      nonce: nonce as () => string,
      runTransaction: <T>(callback: (tx: PawketTransaction) => Promise<T>) => Reflect.apply(
        transaction.method,
        transaction.receiver,
        [callback],
      ) as Promise<T>,
      resolveVisible: (tx: PawketTransaction, target: ReportTarget) => Reflect.apply(
        resolveVisible.method,
        resolveVisible.receiver,
        [tx, target],
      ) as Promise<unknown>,
    };
  } catch {
    fail();
  }
}

export function createReportService(input: ReportServiceFactoryInput) {
  const { key, clock, nonce, runTransaction, resolveVisible } = snapshotFactory(input);

  return {
    async issueChallenge(command: Readonly<{ networkKeyHmac: string }>): Promise<ReportChallenge> {
      const normalized = normalizeIssueCommand(command);
      if (!normalized) fail();
      const now = safeNow(clock);
      let challenge: ReportChallenge;
      try {
        challenge = issueToken(now, safeNonce(nonce), key);
      } catch {
        fail();
      }
      let result: unknown;
      try {
        result = await runTransaction(async (tx) => {
          const requester = { kind: "guest", networkKeyHmac: normalized.networkKeyHmac } as const;
          await lockRequester(tx, requester);
          await tx.execute(sql`
            with expired as (
              select id
              from public_report_challenges
              where network_key_hmac = ${normalized.networkKeyHmac}
                and expires_at <= ${now.toISOString()}::timestamptz
              order by expires_at, id
              limit ${CHALLENGE_CLEANUP_LIMIT}
            )
            delete from public_report_challenges as challenge
            using expired
            where challenge.id = expired.id
          `);
          const active = await tx.execute<{ count: number }>(sql`
            select count(*)::int as count
            from public_report_challenges
            where network_key_hmac = ${normalized.networkKeyHmac}
              and consumed_at is null
              and expires_at > ${now.toISOString()}::timestamptz
          `);
          if ((active[0]?.count ?? 0) >= ACTIVE_CHALLENGE_LIMIT) return TRANSACTION_CAPPED;
          await tx.insert(publicReportChallenges).values({
            id: randomUUID(),
            tokenHash: hashOpaqueToken(challenge.token, "public-report-challenge"),
            networkKeyHmac: normalized.networkKeyHmac,
            issuedAt: now,
            expiresAt: new Date(Date.parse(challenge.expiresAt)),
            consumedAt: null,
          });
          return TRANSACTION_ISSUED;
        });
      } catch {
        fail();
      }
      if (result === TRANSACTION_CAPPED) fail(429);
      if (result !== TRANSACTION_ISSUED) fail();
      return challenge;
    },

    async submitReport(command: SubmitReportCommand): Promise<Readonly<{ accepted: true; reportReference: string }>> {
      const normalized = normalizeSubmitCommand(command);
      if (!normalized) fail();
      const now = safeNow(clock);
      const hashes = targetHashes(normalized.target);
      let result: unknown;
      let acceptedReportReference: string | null = null;
      try {
        result = await runTransaction(async (tx) => {
          let rawSnapshot: unknown;
          try { rawSnapshot = await resolveVisible(tx, normalized.target); } catch { rawSnapshot = null; }
          const snapshot = exactModerationSnapshot(rawSnapshot, normalized.target);
          await lockAbuseKeys(tx, normalized.requester, hashes.targetHash, hashes.revisionHash);
          if (normalized.requester.kind === "guest") {
            if (!normalized.challenge || !verifySignedToken(normalized.challenge.token, normalized.challenge.solution, now, key)) {
              return TRANSACTION_REJECTED;
            }
            const consumed = await tx.update(publicReportChallenges).set({ consumedAt: now }).where(and(
              eq(publicReportChallenges.tokenHash, hashOpaqueToken(normalized.challenge.token, "public-report-challenge")),
              eq(publicReportChallenges.networkKeyHmac, normalized.requester.networkKeyHmac),
              isNull(publicReportChallenges.consumedAt),
              lte(publicReportChallenges.issuedAt, now),
              gt(publicReportChallenges.expiresAt, now),
            )).returning({ id: publicReportChallenges.id });
            if (consumed.length !== 1) {
              return TRANSACTION_REJECTED;
            }
          }

          const counts = await countAccepted(tx, normalized.requester, hashes.targetHash, hashes.revisionHash, now);
          const requesterLimit = normalized.requester.kind === "guest" ? GUEST_REQUESTER_LIMIT : ACTOR_REQUESTER_LIMIT;
          if (counts.requester >= requesterLimit) {
            await insertRejectedSecurityEventIfAllowed(tx, { requester: normalized.requester, ...hashes, category: "rate_limited", now });
            return TRANSACTION_EXHAUSTED;
          }
          if (!snapshot) {
            await insertRejectedSecurityEventIfAllowed(tx, { requester: normalized.requester, ...hashes, category: "invalid_target", now });
            return TRANSACTION_REJECTED;
          }
          if (counts.target >= TARGET_REVISION_LIMIT) {
            await insertRejectedSecurityEventIfAllowed(tx, { requester: normalized.requester, ...hashes, category: "rate_limited", now });
            return TRANSACTION_REJECTED;
          }
          if (await duplicateExists(tx, normalized.requester, normalized.target, hashes.targetHash, hashes.revisionHash, now)) {
            await insertRejectedSecurityEventIfAllowed(tx, { requester: normalized.requester, ...hashes, category: "duplicate", now });
            return TRANSACTION_REJECTED;
          }

          const reportId = randomUUID();
          const reportReference = `report:v1:${randomBytes(18).toString("base64url")}`;
          await tx.insert(publicContentReports).values({
            id: reportId,
            reportReference,
            targetType: normalized.target.targetType,
            targetId: normalized.target.targetId,
            publicationRevisionId: normalized.target.publicationRevisionId,
            reason: normalized.reason,
            detail: normalized.detail,
            reporterUserId: normalized.requester.kind === "authenticated" ? normalized.requester.actorUserId : null,
            state: "open",
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
          await insertSecurityEvent(tx, { requester: normalized.requester, ...hashes, outcome: "accepted", category: "accepted", now });
          await insertOutboxEvent(tx, {
            eventType: "trust.public_content_reported.v1",
            eventVersion: 1,
            aggregateType: "public_content_report",
            aggregateId: reportId,
            payload: { reportId, targetType: normalized.target.targetType, reason: normalized.reason },
            occurredAt: now,
          });
          acceptedReportReference = reportReference;
          return TRANSACTION_ACCEPTED;
        });
      } catch {
        fail();
      }
      if (result === TRANSACTION_EXHAUSTED) fail(429);
      if (result !== TRANSACTION_ACCEPTED || acceptedReportReference === null) fail();
      return { accepted: true, reportReference: acceptedReportReference };
    },
  };
}
