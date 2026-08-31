import { randomUUID } from "node:crypto";

import { createLookupHmac } from "@pawket/security";
import * as ipaddr from "ipaddr.js";

import {
  normalizeReportDetail,
  normalizeReportReason,
  normalizeReportTarget,
  readExactOwnDataRecord,
  validUuid,
} from "./report-policy.js";
import { PublicReportError, type SubmitReportCommand } from "./report-service.js";
import {
  TriageServiceError,
  type OwnerReportProjection,
  type OwnerTriageCommand,
} from "./triage-service.js";

const MAX_BODY_BYTES = 32 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROOF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CONTROL = /\p{Cc}/u;

type Session = Readonly<{
  userId: string;
  sessionId: string;
  primaryAuthenticatedAt: Date;
}>;

type ReportService = Readonly<{
  issueChallenge(command: Readonly<{ networkKeyHmac: string }>): Promise<Readonly<{
    token: string;
    difficulty: 18;
    expiresAt: string;
  }>>;
  submitReport(command: SubmitReportCommand): Promise<Readonly<{
    accepted: true;
    reportReference: string;
  }>>;
}>;

type TriageService = Readonly<{
  listQueue(): Promise<readonly OwnerReportProjection[]>;
  dismiss(command: OwnerTriageCommand): Promise<unknown>;
  hide(command: OwnerTriageCommand): Promise<unknown>;
  restore(command: OwnerTriageCommand & Readonly<{ holdId: string }>): Promise<unknown>;
}>;

type Input = Readonly<{
  appBaseUrl: string;
  lookupHmacKey: Uint8Array;
  optionalAuthoritativeSession(headers: Headers): Promise<Session | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  issueOwnerStepUpProof(input: Readonly<{
    userId: string;
    sessionId: string;
    actionClass: string;
    now: Date;
  }>): Promise<Readonly<{ id: string }>>;
  report: ReportService;
  triage: TriageService;
  now?: () => Date;
}>;

export type TrustHttpHandlers = Readonly<{
  challenge(request: Request): Promise<Response>;
  submitReport(request: Request): Promise<Response>;
  queue(request: Request): Promise<Response>;
  triage(request: Request, reportId: string): Promise<Response>;
}>;

type BodyResult =
  | Readonly<{ kind: "ok"; value: unknown }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "too_large" }>;

const privateHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: privateHeaders });
}

function publicFailure(status: number): Response {
  return json(status, { code: "REPORT_NOT_ACCEPTED" });
}

function publicErrorStatus(error: unknown): number {
  try {
    return error instanceof PublicReportError ? error.status : 503;
  } catch {
    return 503;
  }
}

function contentTypeAllowed(value: string | null): boolean {
  if (value === null) return false;
  const parts = value.split(";");
  if (parts.shift()!.trim().toLowerCase() !== "application/json") return false;
  let charsetSeen = false;
  for (const part of parts) {
    const match = /^\s*charset\s*=\s*([^\s;]+)\s*$/iu.exec(part);
    if (!match || charsetSeen || match[1]!.toLowerCase() !== "utf-8") return false;
    charsetSeen = true;
  }
  return true;
}

async function readBoundedJson(request: Request): Promise<BodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) return { kind: "invalid" };
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return { kind: "invalid" };
    if (parsed > MAX_BODY_BYTES) return { kind: "too_large" };
  }
  if (!request.body) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  } finally {
    try { reader.releaseLock(); } catch { /* already cancelled */ }
  }
}

function deriveTrustedNetworkKey(headers: Headers, key: Uint8Array): string | null {
  try {
    const value = headers.get("x-real-ip");
    if (value === null || value.length < 2 || value.length > 64 || value.trim() !== value || value.includes(",")) return null;
    const parsed = ipaddr.parse(value);
    const normalized = parsed.kind() === "ipv6"
      ? (parsed as ipaddr.IPv6).toNormalizedString()
      : parsed.toString();
    return createLookupHmac({
      value: normalized,
      context: "public-report-network",
      key,
    });
  } catch {
    return null;
  }
}

function exactOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get("origin") === appOrigin;
}

function requestId(request: Request): string {
  const value = request.headers.get("x-request-id");
  return value && REQUEST_ID.test(value) ? value : randomUUID();
}

function expectedVersion(request: Request): number | null {
  const value = request.headers.get("if-match");
  if (!value || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  return value && IDEMPOTENCY_KEY.test(value) ? value : null;
}

function parseReport(value: unknown, session: Session | null, networkKeyHmac: string | null): SubmitReportCommand | null {
  const shapes = session
    ? [["target", "reason"], ["target", "reason", "detail"]]
    : [["target", "reason", "challenge"], ["target", "reason", "detail", "challenge"]];
  const record = readExactOwnDataRecord(value, shapes);
  if (!record) return null;
  const target = normalizeReportTarget(record.target);
  const reason = normalizeReportReason(record.reason);
  const hasDetail = Object.prototype.hasOwnProperty.call(record, "detail");
  const detail = normalizeReportDetail(record.detail);
  if (!target || !reason || (hasDetail && record.detail !== null && record.detail !== undefined && detail === null)) return null;
  if (session) {
    return {
      requester: { kind: "authenticated", actorUserId: session.userId },
      target,
      reason,
      ...(hasDetail ? { detail } : {}),
    };
  }
  const challenge = readExactOwnDataRecord(record.challenge, [["token", "solution"]]);
  if (!networkKeyHmac || !challenge || typeof challenge.token !== "string" || challenge.token.length < 1 || challenge.token.length > 512 || !Number.isSafeInteger(challenge.solution) || (challenge.solution as number) < 0) return null;
  return {
    requester: { kind: "guest", networkKeyHmac },
    target,
    reason,
    ...(hasDetail ? { detail } : {}),
    challenge: { token: challenge.token, solution: challenge.solution as number },
  };
}

function normalizedTriageBody(value: unknown): Readonly<{
  action: "dismiss" | "hide" | "restore";
  reason: string;
  holdId: string | null;
}> | null {
  const base = readExactOwnDataRecord(value, [["action", "reason"], ["action", "reason", "holdId"]]);
  if (!base || (base.action !== "dismiss" && base.action !== "hide" && base.action !== "restore")) return null;
  if (typeof base.reason !== "string") return null;
  let reason: string;
  try { reason = base.reason.normalize("NFC"); } catch { return null; }
  if (reason.length < 1 || [...reason].length > 200 || CONTROL.test(reason)) return null;
  if (base.action === "restore") {
    if (!validUuid(base.holdId)) return null;
    return { action: base.action, reason, holdId: base.holdId };
  }
  if (Object.prototype.hasOwnProperty.call(base, "holdId")) return null;
  return { action: base.action, reason, holdId: null };
}

function triageFailure(error: unknown): Response {
  try {
    if (error instanceof TriageServiceError) {
      const mapping: Record<TriageServiceError["code"], { status: number; code: string }> = {
        OWNER_TOTP_REQUIRED: { status: 403, code: "OWNER_TOTP_REQUIRED" },
        VERSION_CONFLICT: { status: 409, code: "VERSION_CONFLICT" },
        IDEMPOTENCY_CONFLICT: { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        NOT_FOUND: { status: 404, code: "NOT_FOUND" },
        INVALID_STATE: { status: 409, code: "INVALID_STATE" },
        POLICY_VIOLATION: { status: 400, code: "INVALID_REQUEST" },
        TRIAGE_UNAVAILABLE: { status: 503, code: "TRIAGE_UNAVAILABLE" },
      };
      const mapped = mapping[error.code];
      return json(mapped.status, { code: mapped.code });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "OWNER_TOTP_REQUIRED") {
      return json(403, { code: "OWNER_TOTP_REQUIRED" });
    }
  } catch {
    return json(503, { code: "TRIAGE_UNAVAILABLE" });
  }
  return json(503, { code: "TRIAGE_UNAVAILABLE" });
}

function ownerQueueReport(report: OwnerReportProjection) {
  const target = {
    targetType: report.target.targetType,
    targetId: report.target.targetId,
    publicationRevisionId: report.target.publicationRevisionId,
  };
  return {
    reportId: report.reportId,
    target,
    reason: report.reason,
    detail: report.detail,
    state: report.state,
    version: report.version,
    snapshot: {
      target: {
        targetType: report.snapshot.target.targetType,
        targetId: report.snapshot.target.targetId,
        publicationRevisionId: report.snapshot.target.publicationRevisionId,
      },
      pageId: report.snapshot.pageId,
      canonicalHandle: report.snapshot.canonicalHandle,
      displayName: report.snapshot.displayName,
      showcaseTitle: report.snapshot.showcaseTitle,
    },
    activeHold: report.activeHold === null
      ? null
      : { holdId: report.activeHold.holdId, targetType: report.activeHold.targetType },
    priorActions: report.priorActions.map((fact) => ({
      action: fact.action,
      reason: fact.reason,
      beforeState: fact.beforeState,
      afterState: fact.afterState,
      resultingReportVersion: fact.resultingReportVersion,
      occurredAt: fact.occurredAt,
    })),
  };
}

export function createTrustHttpHandlers(input: Input): TrustHttpHandlers {
  const appOrigin = new URL(input.appBaseUrl).origin;
  const now = input.now ?? (() => new Date());

  async function optionalSession(request: Request): Promise<Session | Response | null> {
    try { return await input.optionalAuthoritativeSession(request.headers); }
    catch { return publicFailure(503); }
  }

  async function owner(request: Request): Promise<Session | Response> {
    try {
      const authorization = await input.authorizeOwner(request.headers);
      if (authorization !== "authorized") {
        return json(authorization === "unauthenticated" ? 401 : 403, {
          code: authorization === "unauthenticated" ? "AUTHENTICATION_REQUIRED" : "OWNER_REQUIRED",
        });
      }
      return (await input.optionalAuthoritativeSession(request.headers)) ?? json(401, { code: "AUTHENTICATION_REQUIRED" });
    } catch {
      return json(503, { code: "TRIAGE_UNAVAILABLE" });
    }
  }

  return {
    async challenge(request) {
      if (request.method !== "GET") return publicFailure(405);
      const networkKeyHmac = deriveTrustedNetworkKey(request.headers, input.lookupHmacKey);
      if (!networkKeyHmac) return publicFailure(400);
      try {
        const challenge = await input.report.issueChallenge({ networkKeyHmac });
        return json(200, {
          token: challenge.token,
          difficulty: challenge.difficulty,
          expiresAt: challenge.expiresAt,
        });
      } catch (error) {
        return publicFailure(publicErrorStatus(error));
      }
    },

    async submitReport(request) {
      if (request.method !== "POST") return publicFailure(405);
      if (!exactOrigin(request, appOrigin)) return publicFailure(403);
      if (!contentTypeAllowed(request.headers.get("content-type"))) return publicFailure(415);
      const body = await readBoundedJson(request);
      if (body.kind === "too_large") return publicFailure(413);
      if (body.kind !== "ok") return publicFailure(400);
      const session = await optionalSession(request);
      if (session instanceof Response) return session;
      const networkKeyHmac = session ? null : deriveTrustedNetworkKey(request.headers, input.lookupHmacKey);
      const command = parseReport(body.value, session, networkKeyHmac);
      if (!command) return publicFailure(400);
      try {
        return json(202, await input.report.submitReport(command));
      } catch (error) {
        return publicFailure(publicErrorStatus(error));
      }
    },

    async queue(request) {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      try { return json(200, { reports: (await input.triage.listQueue()).map(ownerQueueReport) }); }
      catch (error) { return triageFailure(error); }
    },

    async triage(request, reportId) {
      if (request.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" });
      if (!exactOrigin(request, appOrigin)) return json(403, { code: "UNTRUSTED_ORIGIN" });
      if (!validUuid(reportId)) return json(400, { code: "INVALID_REQUEST" });
      if (!contentTypeAllowed(request.headers.get("content-type"))) return json(415, { code: "UNSUPPORTED_MEDIA_TYPE" });
      const version = expectedVersion(request);
      const key = idempotencyKey(request);
      if (!version || !key) return json(400, { code: "INVALID_REQUEST" });
      const body = await readBoundedJson(request);
      if (body.kind === "too_large") return json(413, { code: "REQUEST_TOO_LARGE" });
      if (body.kind !== "ok") return json(400, { code: "INVALID_REQUEST" });
      const commandBody = normalizedTriageBody(body.value);
      if (!commandBody) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      try {
        const proof = await input.issueOwnerStepUpProof({
          userId: actor.userId,
          sessionId: actor.sessionId,
          actionClass: `owner.public_report_${commandBody.action}`,
          now: now(),
        });
        if (!proof || typeof proof.id !== "string" || !PROOF_ID.test(proof.id)) return json(503, { code: "TRIAGE_UNAVAILABLE" });
        const command: OwnerTriageCommand = {
          ownerUserId: actor.userId,
          ownerSessionId: actor.sessionId,
          stepUpProofId: proof.id,
          reportId,
          expectedVersion: version,
          reason: commandBody.reason,
          idempotencyKey: key,
          requestId: requestId(request),
        };
        const result = commandBody.action === "dismiss"
          ? await input.triage.dismiss(command)
          : commandBody.action === "hide"
            ? await input.triage.hide(command)
            : await input.triage.restore({ ...command, holdId: commandBody.holdId! });
        return json(200, { result });
      } catch (error) {
        return triageFailure(error);
      }
    },
  };
}
