import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, trustCases, trustReports,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, encryptSensitiveField, hashOpaqueToken, type EncryptionKeyring } from "@pawket/security";
import { createTrustCasePort } from "./case-port.js";
import { normalizeTrustText, TRUST_ENFORCEMENT_POLICY, TrustEnforcementError, trustFail, type TrustEnforcementMode } from "./enforcement-policy.js";
import type { TrustRestrictionPort } from "./penalty-port.js";
import { normalizeReportReason, readExactOwnDataRecord, validNetworkKeyHmac, validUuid, type PublicReportReason } from "./report-policy.js";
import { countAccepted, insertSecurityEvent, issueReportChallenge, lockRequester, PublicReportError, verifyReportChallengeToken } from "./report-service.js";
import { normalizeTrustReportTarget, type ResolvedReportTarget, type TrustReportTarget, type TrustReportTargetPort } from "./report-target-port.js";
import type { TrustPolicyService } from "./trust-policy-service.js";

export type PrivateReportCommand = Readonly<{
  requester: Readonly<{ kind: "authenticated"; actor: { userId: string; sessionId: string } }>
    | Readonly<{ kind: "guest"; networkKeyHmac: string; challenge: { token: string; solution: number } }>;
  target: TrustReportTarget; reason: PublicReportReason; detail: string | null; idempotencyKey: string; requestId: string;
}>;
type Input = Readonly<{ db: PawketDatabase; mode: TrustEnforcementMode; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  challengeKey: Uint8Array; targets: TrustReportTargetPort; restrictions: TrustRestrictionPort; policies: Pick<TrustPolicyService, "readCurrentIds">;
  authorizeCommand?(tx: PawketTransaction, actor: { userId: string; sessionId: string }): Promise<void>;
  now?(): Date; idFactory?(): string }>;
const CONTEXT = "trust-private-report-challenge";
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(v);

function normalizeCommand(value: unknown): PrivateReportCommand {
  const row = readExactOwnDataRecord(value, [["requester", "target", "reason", "detail", "idempotencyKey", "requestId"]]);
  if (!row || !identifier(row.idempotencyKey) || !identifier(row.requestId)) trustFail("invalid_request");
  const target = normalizeTrustReportTarget(row.target); const reason = normalizeReportReason(row.reason);
  if (!target || !reason) trustFail("invalid_request");
  const detail = row.detail === null ? null : normalizeTrustText(row.detail, 0, TRUST_ENFORCEMENT_POLICY.reportDetailMax, { multiline: true }) || null;
  const requester = readExactOwnDataRecord(row.requester, [["kind", "actor"], ["kind", "networkKeyHmac", "challenge"]]);
  if (!requester) trustFail("invalid_request");
  const common = { target, reason, detail, idempotencyKey: row.idempotencyKey, requestId: row.requestId };
  if (requester.kind === "authenticated") {
    const actor = readExactOwnDataRecord(requester.actor, [["userId", "sessionId"]]);
    if (!actor || !identifier(actor.userId) || !identifier(actor.sessionId)) trustFail("invalid_request");
    return { ...common, requester: { kind: "authenticated", actor: { userId: actor.userId, sessionId: actor.sessionId } } };
  }
  if (requester.kind !== "guest" || !validNetworkKeyHmac(requester.networkKeyHmac)) trustFail("invalid_request");
  if (target.kind !== "commission_package") trustFail("not_available");
  const challenge = readExactOwnDataRecord(requester.challenge, [["token", "solution"]]);
  if (!challenge || typeof challenge.token !== "string" || challenge.token.length > 512 || !Number.isSafeInteger(challenge.solution) || (challenge.solution as number) < 0) trustFail("invalid_request");
  return { ...common, requester: { kind: "guest", networkKeyHmac: requester.networkKeyHmac, challenge: { token: challenge.token, solution: challenge.solution as number } } };
}
function targetIdentity(target: TrustReportTarget) {
  return target.kind === "commission_package" ? target.packageId : target.kind === "commission_brief" ? target.orderId : target.kind === "commission_message" ? target.messageId : target.fileId;
}
function exactResolved(value: unknown, target: TrustReportTarget, reporterUserId: string | null): ResolvedReportTarget {
  const row = readExactOwnDataRecord(value, [["kind", "targetId", "orderId", "contentOwnerUserId", "packageRevisionId"]]);
  if (!row || row.kind !== target.kind || row.targetId !== targetIdentity(target) || !identifier(row.contentOwnerUserId) || row.contentOwnerUserId === reporterUserId
    || (target.kind === "commission_package" ? row.orderId !== null || row.packageRevisionId !== target.revisionId : row.orderId !== target.orderId || row.packageRevisionId !== null)) trustFail("not_available");
  return row as ResolvedReportTarget;
}

/** HTTP owns session authentication; target adapters own visibility/party authorization. All writes are atomic. */
export function createPrivateReportService(input: Input) {
  if (!["disabled", "enabled"].includes(input.mode) || input.lookupHmacKey.length < 32 || input.challengeKey.length < 32) trustFail("invalid_request");
  const lookupKey = new Uint8Array(input.lookupHmacKey); const challengeKey = new Uint8Array(input.challengeKey);
  const clock = input.now ?? (() => new Date()); const idFactory = input.idFactory ?? randomUUID;
  const now = () => { const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) trustFail("invalid_request"); return new Date(at); };
  const id = () => { const value = idFactory(); if (!validUuid(value)) trustFail("dependency_unavailable"); return value; };
  const cases = createTrustCasePort({ newId: id });
  const enabled = () => { if (input.mode !== "enabled") trustFail("enforcement_disabled"); };
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof TrustEnforcementError) throw error;
      if (error instanceof PublicReportError) trustFail(error.status === 429 ? "rate_limited" : "invalid_request");
      return trustFail("dependency_unavailable");
    }
  }
  const accepted = (row: { reportReference: string; caseId: string }) => ({ accepted: true as const, reportReference: row.reportReference, caseId: row.caseId });
  async function consumeChallenge(tx: PawketTransaction, requester: Extract<PrivateReportCommand["requester"], { kind: "guest" }>, at: Date): Promise<boolean> {
    if (!verifyReportChallengeToken(requester.challenge.token, requester.challenge.solution, at, challengeKey, CONTEXT)) return false;
    const rows = await tx.execute(sql`update public_report_challenges set consumed_at = ${at.toISOString()}::timestamptz
      where token_hash = ${hashOpaqueToken(requester.challenge.token, CONTEXT)} and network_key_hmac = ${requester.networkKeyHmac}
        and consumed_at is null and issued_at <= ${at.toISOString()}::timestamptz and expires_at > ${at.toISOString()}::timestamptz returning id`);
    return rows.length === 1;
  }
  return {
    async issueChallenge(command: { networkKeyHmac: string }) {
      enabled();
      const row = readExactOwnDataRecord(command, [["networkKeyHmac"]]); if (!row || !validNetworkKeyHmac(row.networkKeyHmac)) trustFail("invalid_request");
      return boundary(() => issueReportChallenge({ db: input.db, networkKeyHmac: row.networkKeyHmac as string, key: challengeKey,
        now: now(), nonce: randomBytes(24).toString("base64url"), context: CONTEXT }));
    },
    async submit(command: PrivateReportCommand): Promise<{ accepted: true; reportReference: string; caseId: string }> {
      enabled(); const c = normalizeCommand(command); const requester = c.requester;
      const securityRequester = requester.kind === "authenticated" ? { kind: "authenticated" as const, actorUserId: requester.actor.userId } : { kind: "guest" as const, networkKeyHmac: requester.networkKeyHmac };
      const hashes = { targetHash: hashOpaqueToken(`${c.target.kind}:${targetIdentity(c.target)}`, "trust-private-report-target"),
        revisionHash: hashOpaqueToken(c.target.kind === "commission_package" ? c.target.revisionId : targetIdentity(c.target), "trust-private-report-revision") };
      return boundary(async () => {
        if (requester.kind === "guest" && !verifyReportChallengeToken(
          requester.challenge.token, requester.challenge.solution, now(), challengeKey, CONTEXT,
        )) trustFail("invalid_request");
        const result = await input.db.transaction(async (tx) => {
          const startedAt = now(); let recordId: string | null = null;
          if (requester.kind === "authenticated") {
            const started = await beginIdempotentCommand(tx, { actorUserId: requester.actor.userId, commandScope: "trust.report_submit",
              keyHash: createLookupHmac({ key: lookupKey, context: "trust-report-command-key", value: c.idempotencyKey }),
              requestFingerprint: createLookupHmac({ key: lookupKey, context: "trust-report-command", value: JSON.stringify([c.target, c.reason, c.detail]) }),
              now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
            if (started.kind === "replay") {
              const [row] = await tx.select({ reportReference: trustReports.reportReference, caseId: trustReports.caseId }).from(trustReports)
                .where(and(eq(trustReports.id, started.resultReference), eq(trustReports.reporterUserId, requester.actor.userId))).limit(1);
              if (!row) trustFail("dependency_unavailable");
              await input.authorizeCommand?.(tx, requester.actor); return { value: accepted(row) };
            }
            if (started.kind !== "acquired") trustFail("idempotency_conflict"); recordId = started.recordId;
          }
          // Target resolution takes any commission, capability and page locks before the reporter's SHARE lock.
          const rawTarget = await input.targets.resolve(tx, c.target, requester.kind === "authenticated" ? { userId: requester.actor.userId } : null);
          await lockRequester(tx, securityRequester);
          const at = now();
          if (requester.kind === "guest" && !await consumeChallenge(tx, requester, at)) return { error: "invalid_request" as const };
          // Guest rejections commit challenge consumption; authenticated failures roll back the pending idempotency record.
          const reject = (code: "not_available" | "duplicate" | "rate_limited") => {
            if (requester.kind === "authenticated") trustFail(code); return { error: code };
          };
          const counts = await countAccepted(tx, securityRequester, hashes.targetHash, hashes.revisionHash, at);
          const limit = requester.kind === "guest" ? TRUST_ENFORCEMENT_POLICY.guestReportLimit : TRUST_ENFORCEMENT_POLICY.actorReportLimit;
          if (counts.requester >= limit) return reject("rate_limited");
          if (rawTarget === null) return reject("not_available");
          const resolved = exactResolved(rawTarget, c.target, requester.kind === "authenticated" ? requester.actor.userId : null);
          if (requester.kind === "authenticated") await input.restrictions.assertAllowed(tx, { userId: requester.actor.userId, restriction: "reporting", at });
          if (requester.kind === "authenticated") {
            const [duplicate] = await tx.select({ id: trustReports.id }).from(trustReports).where(and(eq(trustReports.targetKind, resolved.kind), eq(trustReports.targetId, resolved.targetId), eq(trustReports.reporterUserId, requester.actor.userId))).limit(1);
            if (duplicate) return reject("duplicate");
          } else {
            const [duplicate] = await tx.execute<{ present: boolean }>(sql`select exists(select 1 from public_report_security_events
              where outcome = 'accepted' and network_key_hmac = ${requester.networkKeyHmac} and target_hash = ${hashes.targetHash} and revision_hash = ${hashes.revisionHash}
                and created_at >= ${new Date(at.getTime() - 86_400_000).toISOString()}::timestamptz and expires_at > ${at.toISOString()}::timestamptz) as present`);
            if (duplicate?.present) return reject("duplicate");
          }
          // Serialize grouping independently of revision so later package revisions retain the open item case.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trust:report-case:${resolved.kind}:${resolved.targetId}`}, 0))`);
          const [existing] = await tx.select({ id: trustCases.id }).from(trustCases).where(and(eq(trustCases.kind, "report"), eq(trustCases.sourceType, resolved.kind), eq(trustCases.sourceId, resolved.targetId), eq(trustCases.state, "open"))).limit(1).for("update");
          const policyIds = existing ? null : await input.policies.readCurrentIds(tx);
          const caseId = existing?.id ?? (await cases.openCase(tx, { kind: "report", orderId: resolved.orderId, sourceType: resolved.kind, sourceId: resolved.targetId,
            policyRevisionId: null, communityPolicyRevisionId: policyIds!.communityRulesRevisionId, enforcementPolicyRevisionId: policyIds!.enforcementRevisionId, requestId: c.requestId, at })).caseId;
          const reportId = id(); const reportReference = `report:v2:${randomBytes(24).toString("base64url")}`;
          await tx.insert(trustReports).values({ id: reportId, reportReference, targetKind: resolved.kind, targetId: resolved.targetId, orderId: resolved.orderId,
            packageRevisionId: resolved.packageRevisionId, contentOwnerUserId: resolved.contentOwnerUserId,
            reporterUserId: requester.kind === "authenticated" ? requester.actor.userId : null, reporterNetworkHmac: requester.kind === "guest" ? requester.networkKeyHmac : null,
            reason: c.reason, detailEnvelope: c.detail === null ? null : encryptSensitiveField({ keyring: input.keyring, plaintext: c.detail, binding: { recordType: "trust_reports", recordId: reportId, fieldName: "detail" } }), caseId, createdAt: at });
          await cases.recordCaseEvent(tx, { caseId, action: "report_added", actor: null, reason: null, requestId: c.requestId, at });
          await insertSecurityEvent(tx, { requester: securityRequester, ...hashes, outcome: "accepted", category: "accepted", now: at });
          await insertOutboxEvent(tx, { eventType: "trust.report_received.v1", eventVersion: 1, aggregateType: "trust_report", aggregateId: reportId,
            payload: { reportId, caseId, targetKind: resolved.kind }, occurredAt: at });
          const completedAt = now(); if (completedAt < at || at < startedAt) trustFail("dependency_unavailable");
          if (recordId && !await completeIdempotentCommand(tx, { recordId, resultReference: reportId, completedAt })) trustFail("idempotency_conflict");
          // Commit-time check retains the identity SHARE lock through commit; never update this user afterward.
          if (requester.kind === "authenticated") {
            await input.authorizeCommand?.(tx, requester.actor);
            const commitAt = now(); if (commitAt < completedAt) trustFail("dependency_unavailable");
            await input.restrictions.assertAllowed(tx, { userId: requester.actor.userId, restriction: "reporting", at: commitAt });
          }
          return { value: accepted({ reportReference, caseId }) };
        });
        if (result.error) trustFail(result.error); return result.value!;
      });
    },
    async listFiledBy(userId: string): Promise<readonly { reportReference: string; targetKind: TrustReportTarget["kind"]; state: "received" | "closed"; createdAt: string }[]> {
      if (!identifier(userId)) trustFail("invalid_request");
      return boundary(async () => (await input.db.select({ reportReference: trustReports.reportReference, targetKind: trustReports.targetKind, state: trustReports.state, createdAt: trustReports.createdAt })
        .from(trustReports).where(eq(trustReports.reporterUserId, userId)).orderBy(desc(trustReports.createdAt), desc(trustReports.id)))
        .map((row) => ({ reportReference: row.reportReference, targetKind: row.targetKind, state: row.state === "open" ? "received" as const : "closed" as const, createdAt: row.createdAt.toISOString() })));
    },
  };
}
export type PrivateReportService = ReturnType<typeof createPrivateReportService>;
