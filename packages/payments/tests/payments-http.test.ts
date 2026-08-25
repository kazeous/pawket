import { describe, expect, test, vi } from "vitest";

import * as payments from "../src/index.js";

type PaymentsHttpHandlers = {
  getReceivingAccount(request: Request): Promise<Response>;
  proposeReceivingAccount(request: Request): Promise<Response>;
  getDepositStatus(request: Request): Promise<Response>;
  reportDepositSent(request: Request): Promise<Response>;
  issueChallenge(request: Request, applicationId: string): Promise<Response>;
  reconcileDeposit(request: Request): Promise<Response>;
  revealRefundDestination(request: Request, obligationId: string): Promise<Response>;
  recordRefund(request: Request, obligationId: string): Promise<Response>;
};

type PaymentsExports = {
  createPaymentsHttpHandlers(input: Record<string, unknown>): PaymentsHttpHandlers;
};

const api = payments as unknown as Partial<PaymentsExports>;
const origin = "https://pawket.example";
const session = {
  userId: "applicant-user",
  sessionId: "authoritative-session",
  primaryAuthenticatedAt: new Date("2026-08-25T02:00:00.000Z"),
};

function request(path: string, input?: { body?: unknown; headers?: Record<string, string> }) {
  return new Request(`${origin}${path}`, {
    method: input?.body === undefined ? "GET" : "POST",
    headers: {
      ...(input?.body === undefined ? {} : { "content-type": "application/json" }),
      ...input?.headers,
    },
    body: input?.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

function fixture(input?: {
  authenticated?: boolean;
  owner?: boolean;
  serviceError?: Error;
  stepUpError?: Error & { code: string };
}) {
  const accounts = {
    getCurrentForApplicant: vi.fn(async () => ({ referenceId: "account-version" })),
    propose: vi.fn(async (command: Record<string, unknown>) => {
      if (input?.serviceError) throw input.serviceError;
      return { referenceId: "account-version", command };
    }),
  };
  const deposits = {
    getApplicantStatus: vi.fn(async () => ({ proofState: "unverified", refundState: null })),
    reportSent: vi.fn(async () => ({ state: "sent_reported" })),
    issueChallenge: vi.fn(async (command: Record<string, unknown>) => ({
      id: "challenge-id",
      reference: "PV-ONE-TIME-REFERENCE-1234567890",
      command,
    })),
    reconcile: vi.fn(async (command: Record<string, unknown>) => ({ kind: "unmatched", command })),
    revealRefundDestination: vi.fn(async (command: Record<string, unknown>) => ({
      bankBin: "970436",
      accountNumber: "001234567890",
      accountHolderLabel: "NGUYEN VAN A",
      command,
    })),
    recordRefund: vi.fn(async (command: Record<string, unknown>) => ({ state: "sent", command })),
  };
  const issueOwnerStepUpProof = vi.fn(async (proof: { actionClass: string }) => {
    if (input?.stepUpError) throw input.stepUpError;
    return { id: `server-proof:${proof.actionClass}` };
  });
  expect(typeof api.createPaymentsHttpHandlers).toBe("function");
  const handlers = api.createPaymentsHttpHandlers!({
    trustedOrigins: [origin],
    authenticate: vi.fn(async () => (input?.authenticated === false ? null : session)),
    authorizeOwner: vi.fn(async () => (input?.owner ? "authorized" : "forbidden")),
    issueOwnerStepUpProof,
    accounts,
    deposits,
    now: () => new Date("2026-08-25T02:05:00.000Z"),
  });
  return { handlers, accounts, deposits, issueOwnerStepUpProof };
}

describe("Payments HTTP boundary", () => {
  test("maps only the typed stale owner assurance error to stable TOTP guidance", async () => {
    const stepUpError = Object.assign(new Error("do not reflect this"), { code: "OWNER_TOTP_REQUIRED" });
    const { handlers } = fixture({ owner: true, stepUpError });
    const response = await handlers.issueChallenge(
      request("/admin/challenge", {
        body: { revisionId: "10000000-0000-4000-8000-000000000002", accountVersionId: "10000000-0000-4000-8000-000000000003" },
        headers: { origin, "idempotency-key": "challenge-step-up" },
      }),
      "10000000-0000-4000-8000-000000000001",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "OWNER_TOTP_REQUIRED" });
  });

  test("requires same-origin authentication and derives account command authority server-side", async () => {
    // Break caught: CSRF or trusting client-supplied applicant/session/recent-auth facts.
    const { handlers, accounts } = fixture();
    const payload = {
      userId: "attacker-user",
      sessionId: "attacker-session",
      primaryAuthenticatedAt: "2099-01-01T00:00:00.000Z",
      bankBin: "970436",
      accountNumber: "001234567890",
      accountHolderLabel: "NGUYEN VAN A",
    };
    const untrusted = await handlers.proposeReceivingAccount(
      request("/api/v1/creator-application/receiving-account", {
        body: payload,
        headers: { origin: "https://evil.example", "idempotency-key": "account-command-one" },
      }),
    );
    expect(untrusted.status).toBe(403);

    const response = await handlers.proposeReceivingAccount(
      request("/api/v1/creator-application/receiving-account", {
        body: payload,
        headers: { origin, "idempotency-key": "account-command-one" },
      }),
    );
    expect(response.status).toBe(200);
    expect(accounts.propose).toHaveBeenCalledWith({
      applicantUserId: "applicant-user",
      sessionId: "authoritative-session",
      primaryAuthenticatedAt: session.primaryAuthenticatedAt,
      idempotencyKey: "account-command-one",
      bankBin: "970436",
      accountNumber: "001234567890",
      accountHolderLabel: "NGUYEN VAN A",
    });
  });

  test("scopes applicant account, sent report, and refund status reads to the session user", async () => {
    const { handlers, accounts, deposits } = fixture();
    expect((await handlers.getReceivingAccount(request("/account"))).status).toBe(200);
    expect(accounts.getCurrentForApplicant).toHaveBeenCalledWith({
      applicantUserId: "applicant-user",
    });
    const status = await handlers.getDepositStatus(
      request("/deposit?applicationId=10000000-0000-4000-8000-000000000001"),
    );
    expect(status.status).toBe(200);
    expect(deposits.getApplicantStatus).toHaveBeenCalledWith({
      applicantUserId: "applicant-user",
      applicationId: "10000000-0000-4000-8000-000000000001",
    });
    const report = await handlers.reportDepositSent(
      request("/deposit/report", {
        body: {
          applicantUserId: "attacker-user",
          challengeId: "10000000-0000-4000-8000-000000000010",
          reportedSentAt: "2026-08-25T02:00:00.000Z",
        },
        headers: { origin, "idempotency-key": "deposit-report-one" },
      }),
    );
    expect(report.status).toBe(200);
    expect(deposits.reportSent).toHaveBeenCalledWith({
      applicantUserId: "applicant-user",
      challengeId: "10000000-0000-4000-8000-000000000010",
      reportedSentAt: new Date("2026-08-25T02:00:00.000Z"),
      idempotencyKey: "deposit-report-one",
    });
  });

  test("creates action-bound owner proof server-side for challenge and reconciliation", async () => {
    // Break caught: accepting a client proof ID or allowing a non-owner to issue/reconcile.
    const forbidden = fixture({ owner: false });
    const denied = await forbidden.handlers.issueChallenge(
      request("/admin/challenge", {
        body: {
          revisionId: "10000000-0000-4000-8000-000000000002",
          accountVersionId: "10000000-0000-4000-8000-000000000003",
        },
        headers: { origin, "idempotency-key": "challenge-issue-one" },
      }),
      "10000000-0000-4000-8000-000000000001",
    );
    expect(denied.status).toBe(403);

    const { handlers, deposits, issueOwnerStepUpProof } = fixture({ owner: true });
    const issued = await handlers.issueChallenge(
      request("/admin/challenge", {
        body: {
          stepUpProofId: "client-controlled-proof",
          revisionId: "10000000-0000-4000-8000-000000000002",
          accountVersionId: "10000000-0000-4000-8000-000000000003",
        },
        headers: {
          origin,
          "idempotency-key": "challenge-issue-one",
          "x-request-id": "request.challenge.issue",
        },
      }),
      "10000000-0000-4000-8000-000000000001",
    );
    expect(issued.status).toBe(200);
    expect(issueOwnerStepUpProof).toHaveBeenCalledWith({
      userId: "applicant-user",
      sessionId: "authoritative-session",
      actionClass: "owner.verification_deposit_challenge",
      now: new Date("2026-08-25T02:05:00.000Z"),
    });
    expect(deposits.issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "applicant-user",
        ownerSessionId: "authoritative-session",
        stepUpProofId: "server-proof:owner.verification_deposit_challenge",
      }),
    );

    const reconciled = await handlers.reconcileDeposit(
      request("/admin/reconcile", {
        body: {
          bankTransactionReference: "BANK-TXN-123",
          actualAmountVnd: 20_000,
          actualTransferReference: "PV-REFERENCE",
          receivedAt: "2026-08-25T02:00:00.000Z",
          sourceBankBin: "970436",
          sourceAccountNumber: "001234567890",
          privateNote: "matched against ledger",
        },
        headers: { origin, "idempotency-key": "reconcile-one" },
      }),
    );
    expect(reconciled.status).toBe(200);
    expect(deposits.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        stepUpProofId: "server-proof:owner.verification_deposit_reconciliation",
      }),
    );
  });

  test("uses distinct fresh proofs for private destination reveal and refund recording", async () => {
    const { handlers, deposits, issueOwnerStepUpProof } = fixture({ owner: true });
    const obligationId = "10000000-0000-4000-8000-000000000020";
    const reveal = await handlers.revealRefundDestination(
      request("/admin/reveal", { body: {}, headers: { origin } }),
      obligationId,
    );
    expect(reveal.status).toBe(200);
    expect(deposits.revealRefundDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        stepUpProofId: "server-proof:owner.refund_destination_reveal",
      }),
    );

    const refund = await handlers.recordRefund(
      request("/admin/refund", {
        body: {
          outcome: "sent",
          actualAmountVnd: 20_000,
          outboundBankReference: "OUTBOUND-REFERENCE",
          sentAt: "2026-09-07T03:00:00.000Z",
        },
        headers: { origin, "idempotency-key": "refund-record-one" },
      }),
      obligationId,
    );
    expect(refund.status).toBe(200);
    expect(deposits.recordRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        obligationId,
        stepUpProofId: "server-proof:owner.refund",
      }),
    );
    expect(issueOwnerStepUpProof).toHaveBeenCalledTimes(2);
  });

  test("returns stable safe errors without reflecting bank data", async () => {
    const leaked = "001234567890";
    const { handlers } = fixture({ serviceError: new Error(`failed for ${leaked}`) });
    const response = await handlers.proposeReceivingAccount(
      request("/account", {
        body: {
          bankBin: "970436",
          accountNumber: leaked,
          accountHolderLabel: "NGUYEN VAN A",
        },
        headers: { origin, "idempotency-key": "account-command-error" },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"code":"PAYMENTS_UNAVAILABLE"}');
  });
});
