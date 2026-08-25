import { randomUUID } from "node:crypto";

import { ReceivingAccountPolicyError } from "./receiving-account-policy.js";
import { ReceivingAccountServiceError } from "./receiving-account-service.js";
import { VerificationDepositServiceError } from "./verification-deposit-service.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type Session = {
  userId: string;
  sessionId: string;
  primaryAuthenticatedAt: Date;
};

type AccountsService = {
  getCurrentForApplicant(input: { applicantUserId: string }): Promise<unknown>;
  propose(input: {
    applicantUserId: string;
    sessionId: string;
    primaryAuthenticatedAt: Date;
    idempotencyKey: string;
    bankBin: string;
    accountNumber: string;
    accountHolderLabel: string;
  }): Promise<unknown>;
};

type DepositsService = {
  listRefundObligations(): Promise<unknown>;
  getApplicantStatus(input: { applicantUserId: string; applicationId: string }): Promise<unknown>;
  reportSent(input: {
    applicantUserId: string;
    challengeId: string;
    reportedSentAt: Date;
    idempotencyKey: string;
  }): Promise<unknown>;
  issueChallenge(input: Record<string, unknown>): Promise<unknown>;
  reconcile(input: Record<string, unknown>): Promise<unknown>;
  revealRefundDestination(input: Record<string, unknown>): Promise<unknown>;
  recordRefund(input: Record<string, unknown>): Promise<unknown>;
};

type PaymentsHttpInput = {
  trustedOrigins: readonly string[];
  authenticate(headers: Headers): Promise<Session | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  issueOwnerStepUpProof(input: {
    userId: string;
    sessionId: string;
    actionClass: string;
    now: Date;
  }): Promise<{ id: string }>;
  accounts: AccountsService;
  deposits: DepositsService;
  now?: () => Date;
};

function json(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return null;
  }
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isTrustedOrigin(request: Request, trustedOrigins: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const normalized = new URL(origin).origin;
    return trustedOrigins.some((trusted) => {
      try {
        return new URL(trusted).origin === normalized;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function asString(value: unknown, minimum = 1, maximum = 1_000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function idempotencyKey(request: Request): string | null {
  return asString(request.headers.get("idempotency-key"), 8, 200);
}

function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id");
  return candidate && requestIdPattern.test(candidate) ? candidate : randomUUID();
}

function failure(error: unknown): Response {
  if (error && typeof error === "object" && "code" in error && error.code === "OWNER_TOTP_REQUIRED") {
    return json(403, { code: "OWNER_TOTP_REQUIRED" });
  }
  return error instanceof ReceivingAccountPolicyError ||
    error instanceof ReceivingAccountServiceError ||
    error instanceof VerificationDepositServiceError
    ? json(422, { code: "PAYMENTS_POLICY_REJECTED" })
    : json(503, { code: "PAYMENTS_UNAVAILABLE" });
}

export function createPaymentsHttpHandlers(input: PaymentsHttpInput) {
  const now = input.now ?? (() => new Date());

  async function applicant(request: Request): Promise<Session | Response> {
    try {
      return (await input.authenticate(request.headers)) ?? json(401, { code: "AUTHENTICATION_REQUIRED" });
    } catch {
      return json(503, { code: "PAYMENTS_UNAVAILABLE" });
    }
  }

  async function owner(request: Request): Promise<Session | Response> {
    try {
      const authorization = await input.authorizeOwner(request.headers);
      if (authorization !== "authorized") {
        return json(authorization === "unauthenticated" ? 401 : 403, {
          code: authorization === "unauthenticated" ? "AUTHENTICATION_REQUIRED" : "OWNER_REQUIRED",
        });
      }
      return (await input.authenticate(request.headers)) ?? json(401, { code: "AUTHENTICATION_REQUIRED" });
    } catch {
      return json(503, { code: "PAYMENTS_UNAVAILABLE" });
    }
  }

  async function ownerProof(actor: Session, actionClass: string) {
    return input.issueOwnerStepUpProof({
      userId: actor.userId,
      sessionId: actor.sessionId,
      actionClass,
      now: now(),
    });
  }

  function rejectMutation(request: Request): Response | null {
    if (request.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" });
    if (!isTrustedOrigin(request, input.trustedOrigins)) {
      return json(403, { code: "UNTRUSTED_ORIGIN" });
    }
    return null;
  }

  return {
    async listRefundObligations(request: Request): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      try { return json(200, { obligations: await input.deposits.listRefundObligations() }); } catch (error) { return failure(error); }
    },
    async getReceivingAccount(request: Request): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const actor = await applicant(request);
      if (actor instanceof Response) return actor;
      try {
        return json(200, {
          account: await input.accounts.getCurrentForApplicant({
            applicantUserId: actor.userId,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async proposeReceivingAccount(request: Request): Promise<Response> {
      const rejected = rejectMutation(request);
      if (rejected) return rejected;
      const actor = await applicant(request);
      if (actor instanceof Response) return actor;
      const payload = await parseBody(request);
      const key = idempotencyKey(request);
      const bankBin = asString(payload?.bankBin, 6, 6);
      const accountNumber = asString(payload?.accountNumber, 6, 20);
      const accountHolderLabel = asString(payload?.accountHolderLabel, 2, 100);
      if (!payload || !key || !bankBin || !accountNumber || !accountHolderLabel) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      try {
        return json(200, {
          account: await input.accounts.propose({
            applicantUserId: actor.userId,
            sessionId: actor.sessionId,
            primaryAuthenticatedAt: actor.primaryAuthenticatedAt,
            idempotencyKey: key,
            bankBin,
            accountNumber,
            accountHolderLabel,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async getDepositStatus(request: Request): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const actor = await applicant(request);
      if (actor instanceof Response) return actor;
      const applicationId = new URL(request.url).searchParams.get("applicationId");
      if (!applicationId || !uuidPattern.test(applicationId)) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      try {
        return json(200, {
          deposit: await input.deposits.getApplicantStatus({
            applicantUserId: actor.userId,
            applicationId,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async reportDepositSent(request: Request): Promise<Response> {
      const rejected = rejectMutation(request);
      if (rejected) return rejected;
      const actor = await applicant(request);
      if (actor instanceof Response) return actor;
      const payload = await parseBody(request);
      const key = idempotencyKey(request);
      const challengeId = asString(payload?.challengeId, 36, 36);
      const reportedSentAt = asDate(payload?.reportedSentAt);
      if (!payload || !key || !challengeId || !uuidPattern.test(challengeId) || !reportedSentAt) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      try {
        return json(200, {
          deposit: await input.deposits.reportSent({
            applicantUserId: actor.userId,
            challengeId,
            reportedSentAt,
            idempotencyKey: key,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async issueChallenge(request: Request, applicationId: string): Promise<Response> {
      const rejected = rejectMutation(request);
      if (rejected) return rejected;
      if (!uuidPattern.test(applicationId)) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      const payload = await parseBody(request);
      const key = idempotencyKey(request);
      const revisionId = asString(payload?.revisionId, 36, 36);
      const accountVersionId = asString(payload?.accountVersionId, 36, 36);
      if (
        !payload ||
        !key ||
        !revisionId ||
        !accountVersionId ||
        !uuidPattern.test(revisionId) ||
        !uuidPattern.test(accountVersionId)
      ) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      try {
        const proof = await ownerProof(actor, "owner.verification_deposit_challenge");
        return json(200, {
          challenge: await input.deposits.issueChallenge({
            ownerUserId: actor.userId,
            ownerSessionId: actor.sessionId,
            stepUpProofId: proof.id,
            applicationId,
            revisionId,
            accountVersionId,
            idempotencyKey: key,
            requestId: requestId(request),
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async reconcileDeposit(request: Request): Promise<Response> {
      const rejected = rejectMutation(request);
      if (rejected) return rejected;
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      const payload = await parseBody(request);
      const key = idempotencyKey(request);
      const bankTransactionReference = asString(payload?.bankTransactionReference, 6, 200);
      const actualTransferReference = asString(payload?.actualTransferReference, 1, 200);
      const receivedAt = asDate(payload?.receivedAt);
      const privateNote = asString(payload?.privateNote, 1, 1_000);
      if (
        !payload ||
        !key ||
        !bankTransactionReference ||
        !Number.isSafeInteger(payload.actualAmountVnd) ||
        !actualTransferReference ||
        !receivedAt ||
        !privateNote
      ) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      try {
        const proof = await ownerProof(actor, "owner.verification_deposit_reconciliation");
        return json(200, {
          reconciliation: await input.deposits.reconcile({
            ownerUserId: actor.userId,
            ownerSessionId: actor.sessionId,
            stepUpProofId: proof.id,
            idempotencyKey: key,
            requestId: requestId(request),
            bankTransactionReference,
            actualAmountVnd: payload.actualAmountVnd,
            actualTransferReference,
            receivedAt,
            sourceBankBin: asString(payload.sourceBankBin, 6, 6) ?? undefined,
            sourceAccountNumber: asString(payload.sourceAccountNumber, 6, 20) ?? undefined,
            privateNote,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async revealRefundDestination(request: Request, obligationId: string): Promise<Response> {
      const rejected = rejectMutation(request);
      if (rejected) return rejected;
      if (!uuidPattern.test(obligationId)) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      try {
        const proof = await ownerProof(actor, "owner.refund_destination_reveal");
        return json(200, {
          destination: await input.deposits.revealRefundDestination({
            ownerUserId: actor.userId,
            ownerSessionId: actor.sessionId,
            stepUpProofId: proof.id,
            obligationId,
            requestId: requestId(request),
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },

    async recordRefund(request: Request, obligationId: string): Promise<Response> {
      const rejected = rejectMutation(request);
      if (rejected) return rejected;
      if (!uuidPattern.test(obligationId)) return json(400, { code: "INVALID_REQUEST" });
      const actor = await owner(request);
      if (actor instanceof Response) return actor;
      const payload = await parseBody(request);
      const key = idempotencyKey(request);
      const outcome = payload?.outcome;
      if (!payload || !key || (outcome !== "sent" && outcome !== "attention_required")) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      if (
        (outcome === "sent" && !Number.isSafeInteger(payload.actualAmountVnd)) ||
        (outcome === "attention_required" && payload.actualAmountVnd !== undefined)
      ) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      const sentAt = payload.sentAt === undefined ? undefined : asDate(payload.sentAt);
      if (payload.sentAt !== undefined && !sentAt) return json(400, { code: "INVALID_REQUEST" });
      try {
        const proof = await ownerProof(actor, "owner.refund");
        return json(200, {
          refund: await input.deposits.recordRefund({
            ownerUserId: actor.userId,
            ownerSessionId: actor.sessionId,
            stepUpProofId: proof.id,
            obligationId,
            idempotencyKey: key,
            requestId: requestId(request),
            outcome,
            actualAmountVnd:
              Number.isSafeInteger(payload.actualAmountVnd)
                ? (payload.actualAmountVnd as number)
                : undefined,
            outboundBankReference: asString(payload.outboundBankReference, 6, 200) ?? undefined,
            sentAt,
            attentionReason: asString(payload.attentionReason, 1, 500) ?? undefined,
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
