import { randomBytes, randomUUID } from "node:crypto";

import {
  appendAdminAuditEvent,
  beginIdempotentCommand,
  calculateStoredReceiptBusinessDayWindow,
  completeIdempotentCommand,
  creatorApplicationRevisions,
  creatorApplications,
  insertOutboxEvent,
  paymentsReceivingAccountOnboarding,
  paymentsUnmatchedDeposits,
  paymentsVerificationDepositChallenges,
  paymentsVerificationDepositReceipts,
  paymentsVerificationDepositRefundObligations,
  paymentsVerificationDepositRefunds,
  paymentsVerificationDepositReports,
  vietnamDateFromInstant,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import {
  createLookupHmac,
  decryptSensitiveField,
  encryptSensitiveField,
  hashOpaqueToken,
  type EncryptionEnvelope,
  type EncryptionKeyring,
} from "@pawket/security";
import { and, asc, desc, eq, gte, isNull, ne, or, sql } from "drizzle-orm";

import { fingerprintReceivingAccount } from "./receiving-account-policy.js";

const CHALLENGE_LIFETIME_MS = 72 * 60 * 60_000;
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const commandKeyPattern = /^[A-Za-z0-9._-]{8,200}$/u;
const bankBinPattern = /^\d{6}$/u;
const accountNumberPattern = /^\d{6,20}$/u;

type StepUpInput = {
  proofId: string;
  sessionId: string;
  userId: string;
  actionClass: string;
  now: Date;
};

type VerificationDepositServiceInput = {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
  lookupHmacKey: Uint8Array;
  supportedBanks: Readonly<Record<string, string>>;
  depositAmountVnd: number;
  operatingAccount: {
    bankBin: string;
    bankName: string;
    accountNumber: string;
    accountHolderLabel: string;
  };
  calendarVersion: string;
  consumeStepUpProof: (tx: PawketTransaction, input: StepUpInput) => Promise<boolean>;
  idFactory?: () => string;
  challengeTokenFactory?: () => string;
  now?: () => Date;
};

export type VerificationDepositChallengeProjection = Readonly<{
  id: string;
  amountVnd: number;
  reference: string | null;
  expiresAt: Date;
  replayed: boolean;
  operatingAccount: {
    bankBin: string;
    bankName: string;
    accountNumber: string;
    accountHolderLabel: string;
  };
}>;

export type VerificationDepositReconciliationProjection =
  | Readonly<{ kind: "matched"; receiptId: string; obligationId: string }>
  | Readonly<{ kind: "unmatched"; unmatchedId: string; reason: string }>;

export class VerificationDepositServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationDepositServiceError";
  }
}

function requireValidDate(value: Date, message: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new VerificationDepositServiceError(message);
  }
}

function requireBoundedText(value: string, minimum: number, maximum: number, message: string): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new VerificationDepositServiceError(message);
  }
  return normalized;
}

function assertCommandKey(value: string): void {
  if (!commandKeyPattern.test(value)) {
    throw new VerificationDepositServiceError("Idempotency key is invalid");
  }
}

function challengeReplayReference(id: string): string {
  return `payments-challenge-v1:${id}`;
}

function parseChallengeReplayReference(value: string): string | null {
  const match = /^payments-challenge-v1:([0-9a-f-]{36})$/u.exec(value);
  return match?.[1] ?? null;
}

function reconciliationReplayReference(kind: "receipt" | "unmatched", id: string): string {
  return `payments-reconciliation-v1:${kind}:${id}`;
}

function parseReconciliationReplayReference(
  value: string,
): { kind: "receipt" | "unmatched"; id: string } | null {
  const match = /^payments-reconciliation-v1:(receipt|unmatched):([0-9a-f-]{36})$/u.exec(value);
  return match ? { kind: match[1] as "receipt" | "unmatched", id: match[2]! } : null;
}

function refundReplayReference(id: string): string {
  return `payments-refund-v1:${id}`;
}

function parseRefundReplayReference(value: string): string | null {
  return /^payments-refund-v1:([0-9a-f-]{36})$/u.exec(value)?.[1] ?? null;
}

function idempotencyValues(input: {
  key: string;
  fingerprint: unknown;
  lookupHmacKey: Uint8Array;
}) {
  assertCommandKey(input.key);
  return {
    keyHash: createLookupHmac({
      value: input.key,
      context: "payments-command-key",
      key: input.lookupHmacKey,
    }),
    requestFingerprint: createLookupHmac({
      value: JSON.stringify(input.fingerprint),
      context: "payments-command",
      key: input.lookupHmacKey,
    }),
  };
}

function referenceMask(value: string): string {
  const normalized = value.trim();
  return `•••• ${normalized.slice(-8)}`;
}

function asAccountNumberEnvelope(
  value: unknown,
): EncryptionEnvelope<"payments_receiving_account", "account_number"> {
  return value as EncryptionEnvelope<"payments_receiving_account", "account_number">;
}

function asHolderEnvelope(
  value: unknown,
): EncryptionEnvelope<"payments_receiving_account", "account_holder_label"> {
  return value as EncryptionEnvelope<"payments_receiving_account", "account_holder_label">;
}

async function requireOwnerStepUp(
  input: VerificationDepositServiceInput,
  tx: PawketTransaction,
  proof: Omit<StepUpInput, "now">,
  at: Date,
): Promise<void> {
  if (!(await input.consumeStepUpProof(tx, { ...proof, now: at }))) {
    throw new VerificationDepositServiceError("Owner TOTP step-up required");
  }
}

function assertConfiguredInput(input: VerificationDepositServiceInput): void {
  if (
    !Number.isSafeInteger(input.depositAmountVnd) ||
    input.depositAmountVnd < 1_000 ||
    input.depositAmountVnd > 50_000
  ) {
    throw new VerificationDepositServiceError("Verification deposit configuration is invalid");
  }
  const expectedBankName = input.supportedBanks[input.operatingAccount.bankBin];
  if (
    !bankBinPattern.test(input.operatingAccount.bankBin) ||
    !expectedBankName ||
    expectedBankName !== input.operatingAccount.bankName ||
    !accountNumberPattern.test(input.operatingAccount.accountNumber) ||
    input.operatingAccount.accountHolderLabel.trim().length < 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.calendarVersion)
  ) {
    throw new VerificationDepositServiceError("Verification deposit configuration is invalid");
  }
}

export function createVerificationDepositService(input: VerificationDepositServiceInput) {
  assertConfiguredInput(input);
  const now = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;
  const challengeToken =
    input.challengeTokenFactory ??
    (() => `PV-${randomBytes(20).toString("hex").toUpperCase()}`);

  async function completeCommand(
    tx: PawketTransaction,
    recordId: string,
    resultReference: string,
    completedAt: Date,
  ): Promise<void> {
    if (!(await completeIdempotentCommand(tx, { recordId, resultReference, completedAt }))) {
      throw new VerificationDepositServiceError("Payments command did not complete");
    }
  }

  async function insertUnmatched(
    tx: PawketTransaction,
    values: {
      possibleChallengeId: string | null;
      bankTransactionFingerprint: string;
      actualAmountVnd: number;
      actualReferenceHash: string;
      receivedAt: Date;
      sourceBankBin: string | null;
      sourceAccountFingerprint: string | null;
      sourceMaskedSuffix: string | null;
      reason: "amount_mismatch" | "reference_mismatch" | "source_mismatch" | "unidentified_source" | "late" | "duplicate";
      privateNote: string;
      ownerUserId: string;
      ownerSessionId: string;
      stepUpProofId: string;
      requestId: string;
      at: Date;
    },
  ) {
    const identifiable = Boolean(values.sourceAccountFingerprint);
    const unmatchedId = id();
    const [created] = await tx
      .insert(paymentsUnmatchedDeposits)
      .values({
        id: unmatchedId,
        possibleChallengeId: values.possibleChallengeId,
        bankTransactionFingerprint: values.bankTransactionFingerprint,
        actualAmountVnd: values.actualAmountVnd,
        actualReferenceHash: values.actualReferenceHash,
        receivedAt: values.receivedAt,
        sourceBankBin: values.sourceBankBin,
        sourceAccountFingerprint: values.sourceAccountFingerprint,
        sourceMaskedSuffix: values.sourceMaskedSuffix,
        reason: values.reason,
        resolutionState: identifiable ? "refund_required" : "pending_review",
        refundLiabilityState: identifiable ? "pending" : "unknown",
        privateNote: values.privateNote,
        reconciledByOwnerUserId: values.ownerUserId,
        ownerSessionId: values.ownerSessionId,
        stepUpProofId: values.stepUpProofId,
        requestId: values.requestId,
        createdAt: values.at,
        updatedAt: values.at,
      })
      .returning({ id: paymentsUnmatchedDeposits.id });
    if (!created) throw new VerificationDepositServiceError("Unmatched deposit was not recorded");
    await appendAdminAuditEvent(tx, {
      actorUserId: values.ownerUserId,
      actorSessionId: values.ownerSessionId,
      subjectType: "verification_deposit",
      subjectId: unmatchedId,
      action: "payments.deposit.reconcile",
      outcome: "succeeded",
      reasonCode: values.reason,
      beforeState: null,
      afterState: { result: "unmatched", reason: values.reason },
      assurance: { method: "totp", proofId: values.stepUpProofId },
      applicationRevision: values.possibleChallengeId ?? "unmatched",
      requestId: values.requestId,
      occurredAt: values.at,
    });
    return unmatchedId;
  }

  return {
    async listRefundObligations() {
      const recentSentSince = new Date(now().getTime() - 30 * 24 * 60 * 60_000);
      return input.db.select({ id: paymentsVerificationDepositRefundObligations.id, applicantUserId: paymentsVerificationDepositRefundObligations.applicantUserId, artistDisplayName: creatorApplicationRevisions.artistDisplayName, amountVnd: paymentsVerificationDepositRefundObligations.amountVnd, bankName: paymentsVerificationDepositRefundObligations.lockedBankName, maskedSuffix: paymentsVerificationDepositRefundObligations.lockedMaskedSuffix, refundNotBefore: paymentsVerificationDepositRefundObligations.refundNotBefore, refundDue: paymentsVerificationDepositRefundObligations.refundDue, state: paymentsVerificationDepositRefundObligations.state, updatedAt: paymentsVerificationDepositRefundObligations.updatedAt }).from(paymentsVerificationDepositRefundObligations).innerJoin(paymentsVerificationDepositChallenges, eq(paymentsVerificationDepositChallenges.id, paymentsVerificationDepositRefundObligations.challengeId)).innerJoin(creatorApplicationRevisions, eq(creatorApplicationRevisions.id, paymentsVerificationDepositChallenges.revisionId)).where(or(ne(paymentsVerificationDepositRefundObligations.state, "sent"), gte(paymentsVerificationDepositRefundObligations.updatedAt, recentSentSince))).orderBy(asc(paymentsVerificationDepositRefundObligations.refundDue)).limit(200);
    },

    async issueChallenge(command: {
      ownerUserId: string;
      ownerSessionId: string;
      stepUpProofId: string;
      applicationId: string;
      revisionId: string;
      accountVersionId: string;
      idempotencyKey: string;
      requestId: string;
    }): Promise<VerificationDepositChallengeProjection> {
      const at = now();
      requireValidDate(at, "Challenge issue time is invalid");
      const idem = idempotencyValues({
        key: command.idempotencyKey,
        fingerprint: [
          "challenge-issue-v1",
          command.ownerUserId,
          command.ownerSessionId,
          command.applicationId,
          command.revisionId,
          command.accountVersionId,
        ],
        lookupHmacKey: input.lookupHmacKey,
      });

      return input.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`payments-challenge:${command.applicationId}`}, 0))`,
        );
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.ownerUserId,
          commandScope: "payments.verification_deposit.challenge.issue",
          ...idem,
          expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: at,
        });
        if (started.kind === "replay") {
          const challengeId = parseChallengeReplayReference(started.resultReference);
          if (!challengeId) throw new VerificationDepositServiceError("Challenge replay is invalid");
          const [challenge] = await tx
            .select()
            .from(paymentsVerificationDepositChallenges)
            .where(eq(paymentsVerificationDepositChallenges.id, challengeId))
            .limit(1);
          if (!challenge) throw new VerificationDepositServiceError("Challenge replay is invalid");
          return {
            id: challenge.id,
            amountVnd: challenge.amountVnd,
            reference: null,
            expiresAt: challenge.expiresAt,
            replayed: true,
            operatingAccount: input.operatingAccount,
          };
        }
        if (started.kind !== "acquired") {
          throw new VerificationDepositServiceError("Challenge issue conflicts");
        }

        const [application] = await tx
          .select({
            id: creatorApplications.id,
            userId: creatorApplications.userId,
            state: creatorApplications.state,
            currentRevisionId: creatorApplications.currentRevisionId,
          })
          .from(creatorApplications)
          .where(eq(creatorApplications.id, command.applicationId))
          .limit(1)
          .for("update");
        if (
          !application ||
          application.state !== "submitted" ||
          application.currentRevisionId !== command.revisionId
        ) {
          throw new VerificationDepositServiceError("Submitted application required");
        }
        const [revision] = await tx
          .select({
            id: creatorApplicationRevisions.id,
            proposedReceivingAccountId: creatorApplicationRevisions.proposedReceivingAccountId,
            submittedAt: creatorApplicationRevisions.submittedAt,
          })
          .from(creatorApplicationRevisions)
          .where(
            and(
              eq(creatorApplicationRevisions.id, command.revisionId),
              eq(creatorApplicationRevisions.applicationId, application.id),
            ),
          )
          .limit(1);
        const [account] = await tx
          .select({ id: paymentsReceivingAccountOnboarding.id })
          .from(paymentsReceivingAccountOnboarding)
          .where(
            and(
              eq(paymentsReceivingAccountOnboarding.id, command.accountVersionId),
              eq(paymentsReceivingAccountOnboarding.applicantUserId, application.userId),
              isNull(paymentsReceivingAccountOnboarding.retiredAt),
            ),
          )
          .limit(1);
        if (
          !revision?.submittedAt ||
          revision.proposedReceivingAccountId !== command.accountVersionId ||
          !account
        ) {
          throw new VerificationDepositServiceError("Submitted receiving account required");
        }
        await requireOwnerStepUp(
          input,
          tx,
          {
            proofId: command.stepUpProofId,
            sessionId: command.ownerSessionId,
            userId: command.ownerUserId,
            actionClass: "owner.verification_deposit_challenge",
          },
          at,
        );

        const challengeId = id();
        const reference = challengeToken();
        if (!uuidPattern.test(challengeId) || !/^PV-[A-Z0-9]{26,64}$/u.test(reference)) {
          throw new VerificationDepositServiceError("Challenge identifier is invalid");
        }
        const expiresAt = new Date(at.getTime() + CHALLENGE_LIFETIME_MS);
        const [created] = await tx
          .insert(paymentsVerificationDepositChallenges)
          .values({
            id: challengeId,
            applicationId: command.applicationId,
            revisionId: command.revisionId,
            accountVersionId: command.accountVersionId,
            amountVnd: input.depositAmountVnd,
            referenceHash: hashOpaqueToken(reference, "verification_deposit_reference"),
            issuedByOwnerUserId: command.ownerUserId,
            stepUpProofId: command.stepUpProofId,
            issuedAt: at,
            expiresAt,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!created) throw new VerificationDepositServiceError("Challenge was not issued");
        await tx
          .update(paymentsReceivingAccountOnboarding)
          .set({ proofState: "challenge_issued", updatedAt: at })
          .where(eq(paymentsReceivingAccountOnboarding.id, command.accountVersionId));
        await appendAdminAuditEvent(tx, {
          actorUserId: command.ownerUserId,
          actorSessionId: command.ownerSessionId,
          subjectType: "verification_deposit_challenge",
          subjectId: challengeId,
          action: "payments.challenge.issue",
          outcome: "succeeded",
          beforeState: null,
          afterState: {
            state: "issued",
            amountVnd: input.depositAmountVnd,
            expiresAt: expiresAt.toISOString(),
            accountVersionId: command.accountVersionId,
          },
          assurance: { method: "totp", proofId: command.stepUpProofId },
          applicationRevision: command.revisionId,
          requestId: command.requestId,
          occurredAt: at,
        });
        await insertOutboxEvent(tx, {
          eventType: "payments.verification_deposit_challenge_issued.v1",
          eventVersion: 1,
          aggregateType: "verification_deposit_challenge",
          aggregateId: challengeId,
          payload: {
            challengeId,
            applicationId: command.applicationId,
            state: "issued",
            expiresAt: expiresAt.toISOString(),
            correlationId: command.applicationId,
          },
          occurredAt: at,
        });
        await completeCommand(tx, started.recordId, challengeReplayReference(challengeId), at);
        return {
          id: challengeId,
          amountVnd: input.depositAmountVnd,
          reference,
          expiresAt,
          replayed: false,
          operatingAccount: input.operatingAccount,
        };
      });
    },

    async reportSent(command: {
      applicantUserId: string;
      challengeId: string;
      reportedSentAt: Date;
      idempotencyKey: string;
    }): Promise<{ state: string }> {
      const at = now();
      requireValidDate(at, "Deposit report time is invalid");
      requireValidDate(command.reportedSentAt, "Deposit report time is invalid");
      if (command.reportedSentAt > at) {
        throw new VerificationDepositServiceError("Deposit report time is invalid");
      }
      const idem = idempotencyValues({
        key: command.idempotencyKey,
        fingerprint: [
          "deposit-report-v1",
          command.applicantUserId,
          command.challengeId,
          command.reportedSentAt.toISOString(),
        ],
        lookupHmacKey: input.lookupHmacKey,
      });
      return input.db.transaction(async (tx) => {
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.applicantUserId,
          commandScope: "payments.verification_deposit.report_sent",
          ...idem,
          expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: at,
        });
        if (started.kind === "replay") return { state: "sent_reported" };
        if (started.kind !== "acquired") {
          throw new VerificationDepositServiceError("Deposit report conflicts");
        }
        const [challenge] = await tx
          .select({
            id: paymentsVerificationDepositChallenges.id,
            state: paymentsVerificationDepositChallenges.state,
            expiresAt: paymentsVerificationDepositChallenges.expiresAt,
            accountVersionId: paymentsVerificationDepositChallenges.accountVersionId,
          })
          .from(paymentsVerificationDepositChallenges)
          .innerJoin(
            paymentsReceivingAccountOnboarding,
            eq(
              paymentsReceivingAccountOnboarding.id,
              paymentsVerificationDepositChallenges.accountVersionId,
            ),
          )
          .where(
            and(
              eq(paymentsVerificationDepositChallenges.id, command.challengeId),
              eq(paymentsReceivingAccountOnboarding.applicantUserId, command.applicantUserId),
            ),
          )
          .limit(1)
          .for("update");
        if (!challenge || !["issued", "sent_reported"].includes(challenge.state)) {
          throw new VerificationDepositServiceError("Active challenge required");
        }
        if (at > challenge.expiresAt) {
          throw new VerificationDepositServiceError("Challenge expired");
        }
        await tx
          .insert(paymentsVerificationDepositReports)
          .values({
            id: id(),
            challengeId: challenge.id,
            applicantUserId: command.applicantUserId,
            reportedSentAt: command.reportedSentAt,
            reportedAt: at,
            createdAt: at,
          })
          .onConflictDoNothing();
        await tx
          .update(paymentsVerificationDepositChallenges)
          .set({ state: "sent_reported", updatedAt: at })
          .where(eq(paymentsVerificationDepositChallenges.id, challenge.id));
        await tx
          .update(paymentsReceivingAccountOnboarding)
          .set({ proofState: "sent_reported", updatedAt: at })
          .where(eq(paymentsReceivingAccountOnboarding.id, challenge.accountVersionId));
        await completeCommand(tx, started.recordId, `payments-report-v1:${challenge.id}`, at);
        return { state: "sent_reported" };
      });
    },

    async reconcile(command: {
      ownerUserId: string;
      ownerSessionId: string;
      stepUpProofId: string;
      idempotencyKey: string;
      requestId: string;
      bankTransactionReference: string;
      actualAmountVnd: number;
      actualTransferReference: string;
      receivedAt: Date;
      sourceBankBin?: string;
      sourceAccountNumber?: string;
      privateNote: string;
    }): Promise<VerificationDepositReconciliationProjection> {
      const at = now();
      requireValidDate(at, "Reconciliation time is invalid");
      requireValidDate(command.receivedAt, "Receipt time is invalid");
      if (
        !Number.isSafeInteger(command.actualAmountVnd) ||
        command.actualAmountVnd <= 0 ||
        command.receivedAt > at
      ) {
        throw new VerificationDepositServiceError("Receipt facts are invalid");
      }
      const bankTransactionReference = requireBoundedText(
        command.bankTransactionReference,
        6,
        200,
        "Receipt facts are invalid",
      );
      const actualTransferReference = requireBoundedText(
        command.actualTransferReference,
        1,
        200,
        "Receipt facts are invalid",
      );
      const privateNote = requireBoundedText(command.privateNote, 1, 1_000, "Receipt note is invalid");
      const sourceBankBin = command.sourceBankBin?.trim() ?? null;
      const sourceAccountNumber = command.sourceAccountNumber?.trim() ?? null;
      const sourceValid = Boolean(
        sourceBankBin &&
          sourceAccountNumber &&
          bankBinPattern.test(sourceBankBin) &&
          accountNumberPattern.test(sourceAccountNumber) &&
          input.supportedBanks[sourceBankBin],
      );
      const sourceAccountFingerprint = sourceValid
        ? fingerprintReceivingAccount({
            bankBin: sourceBankBin!,
            accountNumber: sourceAccountNumber!,
            key: input.lookupHmacKey,
          })
        : null;
      const sourceMaskedSuffix = sourceValid
        ? `•••• ${sourceAccountNumber!.slice(-4)}`
        : null;
      const bankTransactionFingerprint = createLookupHmac({
        value: bankTransactionReference,
        context: "deposit-bank-transaction",
        key: input.lookupHmacKey,
      });
      const actualReferenceHash = hashOpaqueToken(
        actualTransferReference,
        "verification_deposit_reference",
      );
      const idem = idempotencyValues({
        key: command.idempotencyKey,
        fingerprint: [
          "deposit-reconciliation-v1",
          command.ownerUserId,
          command.ownerSessionId,
          bankTransactionFingerprint,
          command.actualAmountVnd,
          actualReferenceHash,
          command.receivedAt.toISOString(),
          sourceBankBin,
          sourceAccountFingerprint,
          privateNote,
        ],
        lookupHmacKey: input.lookupHmacKey,
      });

      return input.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`payments-reconcile:${bankTransactionFingerprint}`}, 0))`,
        );
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.ownerUserId,
          commandScope: "payments.verification_deposit.reconcile",
          ...idem,
          expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: at,
        });
        if (started.kind === "replay") {
          const replay = parseReconciliationReplayReference(started.resultReference);
          if (!replay) throw new VerificationDepositServiceError("Reconciliation replay is invalid");
          if (replay.kind === "unmatched") {
            const [unmatched] = await tx
              .select({ id: paymentsUnmatchedDeposits.id, reason: paymentsUnmatchedDeposits.reason })
              .from(paymentsUnmatchedDeposits)
              .where(eq(paymentsUnmatchedDeposits.id, replay.id))
              .limit(1);
            if (!unmatched) throw new VerificationDepositServiceError("Reconciliation replay is invalid");
            return { kind: "unmatched" as const, unmatchedId: unmatched.id, reason: unmatched.reason };
          }
          const [receipt] = await tx
            .select({
              id: paymentsVerificationDepositReceipts.id,
              obligationId: paymentsVerificationDepositRefundObligations.id,
            })
            .from(paymentsVerificationDepositReceipts)
            .innerJoin(
              paymentsVerificationDepositRefundObligations,
              eq(
                paymentsVerificationDepositRefundObligations.receiptId,
                paymentsVerificationDepositReceipts.id,
              ),
            )
            .where(eq(paymentsVerificationDepositReceipts.id, replay.id))
            .limit(1);
          if (!receipt) throw new VerificationDepositServiceError("Reconciliation replay is invalid");
          return { kind: "matched" as const, receiptId: receipt.id, obligationId: receipt.obligationId };
        }
        if (started.kind !== "acquired") {
          throw new VerificationDepositServiceError("Reconciliation conflicts");
        }

        let [challenge] = await tx
          .select()
          .from(paymentsVerificationDepositChallenges)
          .where(eq(paymentsVerificationDepositChallenges.referenceHash, actualReferenceHash))
          .orderBy(desc(paymentsVerificationDepositChallenges.createdAt))
          .limit(1)
          .for("update");
        if (!challenge && sourceAccountFingerprint) {
          [challenge] = await tx
            .select({
              id: paymentsVerificationDepositChallenges.id,
              applicationId: paymentsVerificationDepositChallenges.applicationId,
              revisionId: paymentsVerificationDepositChallenges.revisionId,
              accountVersionId: paymentsVerificationDepositChallenges.accountVersionId,
              amountVnd: paymentsVerificationDepositChallenges.amountVnd,
              referenceHash: paymentsVerificationDepositChallenges.referenceHash,
              state: paymentsVerificationDepositChallenges.state,
              issuedByOwnerUserId: paymentsVerificationDepositChallenges.issuedByOwnerUserId,
              stepUpProofId: paymentsVerificationDepositChallenges.stepUpProofId,
              issuedAt: paymentsVerificationDepositChallenges.issuedAt,
              expiresAt: paymentsVerificationDepositChallenges.expiresAt,
              verifiedAt: paymentsVerificationDepositChallenges.verifiedAt,
              createdAt: paymentsVerificationDepositChallenges.createdAt,
              updatedAt: paymentsVerificationDepositChallenges.updatedAt,
            })
            .from(paymentsVerificationDepositChallenges)
            .innerJoin(
              paymentsReceivingAccountOnboarding,
              and(
                eq(
                  paymentsReceivingAccountOnboarding.id,
                  paymentsVerificationDepositChallenges.accountVersionId,
                ),
                eq(
                  paymentsReceivingAccountOnboarding.accountFingerprint,
                  sourceAccountFingerprint,
                ),
              ),
            )
            .where(
              sql`${paymentsVerificationDepositChallenges.state} in ('issued', 'sent_reported', 'verified')`,
            )
            .orderBy(desc(paymentsVerificationDepositChallenges.createdAt))
            .limit(1)
            .for("update");
        }

        await requireOwnerStepUp(
          input,
          tx,
          {
            proofId: command.stepUpProofId,
            sessionId: command.ownerSessionId,
            userId: command.ownerUserId,
            actionClass: "owner.verification_deposit_reconciliation",
          },
          at,
        );

        const [account] = challenge
          ? await tx
              .select()
              .from(paymentsReceivingAccountOnboarding)
              .where(eq(paymentsReceivingAccountOnboarding.id, challenge.accountVersionId))
              .limit(1)
          : [];
        let unmatchedReason:
          | "amount_mismatch"
          | "reference_mismatch"
          | "source_mismatch"
          | "unidentified_source"
          | "late"
          | "duplicate"
          | null = null;
        if (challenge?.state === "verified") unmatchedReason = "duplicate";
        else if (challenge && command.actualAmountVnd !== challenge.amountVnd) unmatchedReason = "amount_mismatch";
        else if (!challenge || actualReferenceHash !== challenge.referenceHash) unmatchedReason = "reference_mismatch";
        else if (command.receivedAt > challenge.expiresAt) unmatchedReason = "late";
        else if (!sourceAccountFingerprint || !sourceBankBin) unmatchedReason = "unidentified_source";
        else if (
          !account ||
          account.accountFingerprint !== sourceAccountFingerprint ||
          account.bankBin !== sourceBankBin
        ) {
          unmatchedReason = "source_mismatch";
        }

        if (unmatchedReason) {
          const unmatchedId = await insertUnmatched(tx, {
            possibleChallengeId: challenge?.id ?? null,
            bankTransactionFingerprint,
            actualAmountVnd: command.actualAmountVnd,
            actualReferenceHash,
            receivedAt: command.receivedAt,
            sourceBankBin: sourceValid ? sourceBankBin : null,
            sourceAccountFingerprint,
            sourceMaskedSuffix,
            reason: unmatchedReason,
            privateNote,
            ownerUserId: command.ownerUserId,
            ownerSessionId: command.ownerSessionId,
            stepUpProofId: command.stepUpProofId,
            requestId: command.requestId,
            at,
          });
          await completeCommand(
            tx,
            started.recordId,
            reconciliationReplayReference("unmatched", unmatchedId),
            at,
          );
          return { kind: "unmatched", unmatchedId, reason: unmatchedReason };
        }

        if (!challenge || !account) {
          throw new VerificationDepositServiceError("Matched deposit is invalid");
        }
        const receiptId = id();
        const obligationId = id();
        const receiptDate = vietnamDateFromInstant(command.receivedAt);
        const window = await calculateStoredReceiptBusinessDayWindow(tx, {
          receiptDate,
          calendarVersion: input.calendarVersion,
        });
        const accountNumber = decryptSensitiveField({
          envelope: asAccountNumberEnvelope(account.accountNumberEnvelope),
          binding: {
            recordType: "payments_receiving_account",
            recordId: account.id,
            fieldName: "account_number",
          },
          keyring: input.keyring,
        });
        const accountHolderLabel = decryptSensitiveField({
          envelope: asHolderEnvelope(account.accountHolderLabelEnvelope),
          binding: {
            recordType: "payments_receiving_account",
            recordId: account.id,
            fieldName: "account_holder_label",
          },
          keyring: input.keyring,
        });
        const [receipt] = await tx
          .insert(paymentsVerificationDepositReceipts)
          .values({
            id: receiptId,
            challengeId: challenge.id,
            bankTransactionFingerprint,
            actualAmountVnd: command.actualAmountVnd,
            actualReferenceHash,
            receivedAt: command.receivedAt,
            sourceBankBin: sourceBankBin!,
            sourceAccountFingerprint: sourceAccountFingerprint!,
            sourceMaskedSuffix: sourceMaskedSuffix!,
            privateNote,
            reconciledByOwnerUserId: command.ownerUserId,
            ownerSessionId: command.ownerSessionId,
            stepUpProofId: command.stepUpProofId,
            requestId: command.requestId,
            createdAt: at,
          })
          .returning({ id: paymentsVerificationDepositReceipts.id });
        if (!receipt) throw new VerificationDepositServiceError("Receipt was not recorded");
        const [obligation] = await tx
          .insert(paymentsVerificationDepositRefundObligations)
          .values({
            id: obligationId,
            receiptId,
            challengeId: challenge.id,
            accountVersionId: account.id,
            applicantUserId: account.applicantUserId,
            amountVnd: challenge.amountVnd,
            lockedBankBin: account.bankBin,
            lockedBankName: account.bankName,
            lockedAccountNumberEnvelope: encryptSensitiveField({
              plaintext: accountNumber,
              binding: {
                recordType: "payments_refund_obligation",
                recordId: obligationId,
                fieldName: "account_number",
              },
              keyring: input.keyring,
            }),
            lockedAccountHolderLabelEnvelope: encryptSensitiveField({
              plaintext: accountHolderLabel,
              binding: {
                recordType: "payments_refund_obligation",
                recordId: obligationId,
                fieldName: "account_holder_label",
              },
              keyring: input.keyring,
            }),
            lockedMaskedSuffix: account.maskedSuffix,
            lockedAccountFingerprint: account.accountFingerprint,
            calendarVersion: window.calendarVersion,
            receiptDate: window.receiptDate,
            refundNotBefore: window.refundNotBefore,
            refundDue: window.refundDue,
            state: "pending_window",
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: paymentsVerificationDepositRefundObligations.id });
        if (!obligation) throw new VerificationDepositServiceError("Refund obligation was not created");
        await tx
          .update(paymentsVerificationDepositChallenges)
          .set({ state: "verified", verifiedAt: command.receivedAt, updatedAt: at })
          .where(eq(paymentsVerificationDepositChallenges.id, challenge.id));
        await tx
          .update(paymentsReceivingAccountOnboarding)
          .set({ proofState: "verified", proofVerifiedAt: command.receivedAt, updatedAt: at })
          .where(eq(paymentsReceivingAccountOnboarding.id, account.id));
        await appendAdminAuditEvent(tx, {
          actorUserId: command.ownerUserId,
          actorSessionId: command.ownerSessionId,
          subjectType: "verification_deposit",
          subjectId: receiptId,
          action: "payments.deposit.reconcile",
          outcome: "succeeded",
          beforeState: { state: challenge.state },
          afterState: {
            state: "verified",
            obligationId,
            amountVnd: challenge.amountVnd,
            accountVersionId: account.id,
            refundNotBefore: window.refundNotBefore,
            refundDue: window.refundDue,
          },
          assurance: { method: "totp", proofId: command.stepUpProofId },
          applicationRevision: challenge.revisionId,
          requestId: command.requestId,
          occurredAt: at,
        });
        for (const eventType of [
          "payments.verification_deposit_received.v1",
          "payments.receiving_account_control_verified.v1",
        ]) {
          await insertOutboxEvent(tx, {
            eventType,
            eventVersion: 1,
            aggregateType: "verification_deposit_refund_obligation",
            aggregateId: obligationId,
            payload: {
              obligationId,
              receiptId,
              challengeId: challenge.id,
              applicationId: challenge.applicationId,
              accountVersionId: account.id,
              state: "pending_window",
              amountVnd: challenge.amountVnd,
              refundNotBefore: window.refundNotBefore,
              refundDue: window.refundDue,
              correlationId: challenge.applicationId,
            },
            occurredAt: at,
          });
        }
        await completeCommand(
          tx,
          started.recordId,
          reconciliationReplayReference("receipt", receiptId),
          at,
        );
        return { kind: "matched", receiptId, obligationId };
      });
    },

    async revealRefundDestination(command: {
      ownerUserId: string;
      ownerSessionId: string;
      stepUpProofId: string;
      obligationId: string;
      requestId: string;
    }): Promise<{ bankBin: string; accountNumber: string; accountHolderLabel: string }> {
      const at = now();
      requireValidDate(at, "Refund destination reveal time is invalid");
      return input.db.transaction(async (tx) => {
        const [obligation] = await tx
          .select()
          .from(paymentsVerificationDepositRefundObligations)
          .where(eq(paymentsVerificationDepositRefundObligations.id, command.obligationId))
          .limit(1);
        if (!obligation) throw new VerificationDepositServiceError("Refund obligation was not found");
        await requireOwnerStepUp(
          input,
          tx,
          {
            proofId: command.stepUpProofId,
            sessionId: command.ownerSessionId,
            userId: command.ownerUserId,
            actionClass: "owner.refund_destination_reveal",
          },
          at,
        );
        const accountNumber = decryptSensitiveField({
          envelope: obligation.lockedAccountNumberEnvelope as EncryptionEnvelope<
            "payments_refund_obligation",
            "account_number"
          >,
          binding: {
            recordType: "payments_refund_obligation",
            recordId: obligation.id,
            fieldName: "account_number",
          },
          keyring: input.keyring,
        });
        const accountHolderLabel = decryptSensitiveField({
          envelope: obligation.lockedAccountHolderLabelEnvelope as EncryptionEnvelope<
            "payments_refund_obligation",
            "account_holder_label"
          >,
          binding: {
            recordType: "payments_refund_obligation",
            recordId: obligation.id,
            fieldName: "account_holder_label",
          },
          keyring: input.keyring,
        });
        await appendAdminAuditEvent(tx, {
          actorUserId: command.ownerUserId,
          actorSessionId: command.ownerSessionId,
          subjectType: "verification_deposit_refund_obligation",
          subjectId: obligation.id,
          action: "payments.refund_destination.reveal",
          outcome: "succeeded",
          beforeState: null,
          afterState: {
            bankBin: obligation.lockedBankBin,
            maskedSuffix: obligation.lockedMaskedSuffix,
          },
          assurance: { method: "totp", proofId: command.stepUpProofId },
          applicationRevision: obligation.challengeId,
          requestId: command.requestId,
          occurredAt: at,
        });
        return { bankBin: obligation.lockedBankBin, accountNumber, accountHolderLabel };
      });
    },

    async recordRefund(command: {
      ownerUserId: string;
      ownerSessionId: string;
      stepUpProofId: string;
      obligationId: string;
      idempotencyKey: string;
      requestId: string;
      outcome: "sent" | "attention_required";
      actualAmountVnd?: number;
      outboundBankReference?: string;
      sentAt?: Date;
      attentionReason?: string;
    }): Promise<{ state: string }> {
      const at = now();
      requireValidDate(at, "Refund record time is invalid");
      const outboundBankReference = command.outboundBankReference?.trim() ?? null;
      const attentionReason = command.attentionReason?.trim() ?? null;
      if (command.outcome === "sent") {
        if (!Number.isSafeInteger(command.actualAmountVnd) || command.actualAmountVnd! <= 0) {
          throw new VerificationDepositServiceError("Outbound refund evidence is invalid");
        }
        if (!outboundBankReference || outboundBankReference.length < 6 || outboundBankReference.length > 200) {
          throw new VerificationDepositServiceError("Outbound refund evidence is invalid");
        }
        if (!command.sentAt) throw new VerificationDepositServiceError("Outbound refund evidence is invalid");
        requireValidDate(command.sentAt, "Outbound refund evidence is invalid");
        if (command.sentAt > at) throw new VerificationDepositServiceError("Outbound refund evidence is invalid");
      } else if (!attentionReason || attentionReason.length > 500) {
        throw new VerificationDepositServiceError("Refund attention reason is invalid");
      }
      const outboundFingerprint = outboundBankReference
        ? createLookupHmac({
            value: outboundBankReference,
            context: "refund-bank-reference",
            key: input.lookupHmacKey,
          })
        : null;
      const idem = idempotencyValues({
        key: command.idempotencyKey,
        fingerprint: [
          "deposit-refund-v1",
          command.ownerUserId,
          command.ownerSessionId,
          command.obligationId,
          command.outcome,
          command.actualAmountVnd ?? null,
          outboundFingerprint,
          command.sentAt?.toISOString() ?? null,
          attentionReason,
        ],
        lookupHmacKey: input.lookupHmacKey,
      });
      return input.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`payments-refund:${command.obligationId}`}, 0))`,
        );
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.ownerUserId,
          commandScope: "payments.verification_deposit.refund.record",
          ...idem,
          expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: at,
        });
        if (started.kind === "replay") {
          const refundId = parseRefundReplayReference(started.resultReference);
          if (!refundId) throw new VerificationDepositServiceError("Refund replay is invalid");
          const [refund] = await tx
            .select({ outcome: paymentsVerificationDepositRefunds.outcome })
            .from(paymentsVerificationDepositRefunds)
            .where(eq(paymentsVerificationDepositRefunds.id, refundId))
            .limit(1);
          if (!refund) throw new VerificationDepositServiceError("Refund replay is invalid");
          return { state: refund.outcome };
        }
        if (started.kind !== "acquired") {
          throw new VerificationDepositServiceError("Refund record conflicts");
        }
        const [obligation] = await tx
          .select()
          .from(paymentsVerificationDepositRefundObligations)
          .where(eq(paymentsVerificationDepositRefundObligations.id, command.obligationId))
          .limit(1)
          .for("update");
        if (!obligation) throw new VerificationDepositServiceError("Refund obligation was not found");
        if (obligation.state === "sent") {
          throw new VerificationDepositServiceError("Refund was already recorded");
        }
        if (command.outcome === "sent" && command.actualAmountVnd !== obligation.amountVnd) {
          throw new VerificationDepositServiceError("Refund amount must match the obligation");
        }
        const effectiveSentAt = command.sentAt ?? at;
        if (vietnamDateFromInstant(effectiveSentAt) < obligation.refundNotBefore) {
          throw new VerificationDepositServiceError("Refund window has not opened");
        }
        await requireOwnerStepUp(
          input,
          tx,
          {
            proofId: command.stepUpProofId,
            sessionId: command.ownerSessionId,
            userId: command.ownerUserId,
            actionClass: "owner.refund",
          },
          at,
        );
        const refundId = id();
        const [refund] = await tx
          .insert(paymentsVerificationDepositRefunds)
          .values({
            id: refundId,
            obligationId: obligation.id,
            outcome: command.outcome,
            actualAmountVnd:
              command.outcome === "sent" ? command.actualAmountVnd : null,
            outboundBankReferenceFingerprint: outboundFingerprint,
            outboundBankReferenceMasked: outboundBankReference
              ? referenceMask(outboundBankReference)
              : null,
            sentAt: command.outcome === "sent" ? command.sentAt : null,
            attentionReason: command.outcome === "attention_required" ? attentionReason : null,
            recordedByOwnerUserId: command.ownerUserId,
            ownerSessionId: command.ownerSessionId,
            stepUpProofId: command.stepUpProofId,
            requestId: command.requestId,
            createdAt: at,
          })
          .returning({ id: paymentsVerificationDepositRefunds.id });
        if (!refund) throw new VerificationDepositServiceError("Refund was not recorded");
        await tx
          .update(paymentsVerificationDepositRefundObligations)
          .set({
            state: command.outcome,
            attentionReason: command.outcome === "attention_required" ? attentionReason : null,
            updatedAt: at,
          })
          .where(eq(paymentsVerificationDepositRefundObligations.id, obligation.id));
        await appendAdminAuditEvent(tx, {
          actorUserId: command.ownerUserId,
          actorSessionId: command.ownerSessionId,
          subjectType: "verification_deposit_refund_obligation",
          subjectId: obligation.id,
          action: "payments.refund.record",
          outcome: "succeeded",
          beforeState: { state: obligation.state },
          afterState: { state: command.outcome, amountVnd: obligation.amountVnd },
          assurance: { method: "totp", proofId: command.stepUpProofId },
          applicationRevision: obligation.challengeId,
          requestId: command.requestId,
          occurredAt: at,
        });
        await insertOutboxEvent(tx, {
          eventType:
            command.outcome === "sent"
              ? "payments.verification_deposit_refund_sent.v1"
              : "payments.verification_deposit_refund_attention_required.v1",
          eventVersion: 1,
          aggregateType: "verification_deposit_refund_obligation",
          aggregateId: obligation.id,
          payload: {
            obligationId: obligation.id,
            applicantUserId: obligation.applicantUserId,
            state: command.outcome,
            amountVnd: obligation.amountVnd,
            correlationId: obligation.challengeId,
          },
          occurredAt: at,
        });
        await completeCommand(tx, started.recordId, refundReplayReference(refundId), at);
        return { state: command.outcome };
      });
    },

    async getApplicantStatus(command: { applicantUserId: string; applicationId: string }): Promise<{
      proofState: string;
      refundState: string | null;
      refundNotBefore: string | null;
      refundDue: string | null;
      challengeId: string | null;
      amountVnd: number | null;
      expiresAt: Date | null;
      operatingAccount: VerificationDepositServiceInput["operatingAccount"] | null;
    }> {
      const [challenge] = await input.db
        .select({
          state: paymentsVerificationDepositChallenges.state,
          accountVersionId: paymentsVerificationDepositChallenges.accountVersionId,
          id: paymentsVerificationDepositChallenges.id,
          amountVnd: paymentsVerificationDepositChallenges.amountVnd,
          expiresAt: paymentsVerificationDepositChallenges.expiresAt,
        })
        .from(paymentsVerificationDepositChallenges)
        .innerJoin(
          paymentsReceivingAccountOnboarding,
          eq(
            paymentsReceivingAccountOnboarding.id,
            paymentsVerificationDepositChallenges.accountVersionId,
          ),
        )
        .where(
          and(
            eq(paymentsVerificationDepositChallenges.applicationId, command.applicationId),
            eq(paymentsReceivingAccountOnboarding.applicantUserId, command.applicantUserId),
          ),
        )
        .orderBy(desc(paymentsVerificationDepositChallenges.createdAt))
        .limit(1);
      if (!challenge) {
        return {
          proofState: "unverified",
          refundState: null,
          refundNotBefore: null,
          refundDue: null,
          challengeId: null,
          amountVnd: null,
          expiresAt: null,
          operatingAccount: null,
        };
      }
      const [obligation] = await input.db
        .select({
          state: paymentsVerificationDepositRefundObligations.state,
          refundNotBefore: paymentsVerificationDepositRefundObligations.refundNotBefore,
          refundDue: paymentsVerificationDepositRefundObligations.refundDue,
        })
        .from(paymentsVerificationDepositRefundObligations)
        .innerJoin(
          paymentsVerificationDepositChallenges,
          eq(
            paymentsVerificationDepositChallenges.id,
            paymentsVerificationDepositRefundObligations.challengeId,
          ),
        )
        .where(
          and(
            eq(paymentsVerificationDepositChallenges.applicationId, command.applicationId),
            eq(
              paymentsVerificationDepositRefundObligations.applicantUserId,
              command.applicantUserId,
            ),
          ),
        )
        .orderBy(desc(paymentsVerificationDepositRefundObligations.createdAt))
        .limit(1);
      return {
        proofState: challenge.state,
        refundState: obligation?.state ?? null,
        refundNotBefore: obligation?.refundNotBefore ?? null,
        refundDue: obligation?.refundDue ?? null,
        challengeId: challenge.id,
        amountVnd: challenge.amountVnd,
        expiresAt: challenge.expiresAt,
        operatingAccount: input.operatingAccount,
      };
    },
  };
}
