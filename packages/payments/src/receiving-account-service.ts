import { randomUUID } from "node:crypto";

import {
  beginIdempotentCommand,
  completeIdempotentCommand,
  identityUsers,
  paymentsReceivingAccountOnboarding,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import {
  createLookupHmac,
  encryptSensitiveField,
  type EncryptionKeyring,
} from "@pawket/security";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import {
  fingerprintReceivingAccount,
  normalizeReceivingAccountProposal,
} from "./receiving-account-policy.js";

const RECENT_AUTHENTICATION_MS = 15 * 60_000;
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60_000;
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ReceivingAccountProjection = Readonly<{
  referenceId: string;
  onboardingId: string;
  version: number;
  bankBin: string;
  bankName: string;
  maskedSuffix: string;
  proofState: string;
}>;

export class ReceivingAccountServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivingAccountServiceError";
  }
}

type ReceivingAccountServiceInput = {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
  lookupHmacKey: Uint8Array;
  supportedBanks: Readonly<Record<string, string>>;
  idFactory?: () => string;
  now?: () => Date;
};

function projection(row: typeof paymentsReceivingAccountOnboarding.$inferSelect): ReceivingAccountProjection {
  return {
    referenceId: row.id,
    onboardingId: row.onboardingId,
    version: row.version,
    bankBin: row.bankBin,
    bankName: row.bankName,
    maskedSuffix: row.maskedSuffix,
    proofState: row.proofState,
  };
}

function replayReference(id: string): string {
  return `payments-account-v1:${id}`;
}

function parseReplayReference(value: string): string | null {
  const match = /^payments-account-v1:([0-9a-f-]{36})$/u.exec(value);
  return match?.[1] ?? null;
}

export function createReceivingAccountService(input: ReceivingAccountServiceInput) {
  const now = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;

  return {
    async getCurrentForApplicant(command: {
      applicantUserId: string;
    }): Promise<ReceivingAccountProjection | null> {
      const [account] = await input.db
        .select()
        .from(paymentsReceivingAccountOnboarding)
        .where(
          and(
            eq(
              paymentsReceivingAccountOnboarding.applicantUserId,
              command.applicantUserId,
            ),
            isNull(paymentsReceivingAccountOnboarding.retiredAt),
            isNull(paymentsReceivingAccountOnboarding.minimizedAt),
            isNotNull(paymentsReceivingAccountOnboarding.accountNumberEnvelope),
            isNotNull(paymentsReceivingAccountOnboarding.accountHolderLabelEnvelope),
          ),
        )
        .limit(1);
      return account ? projection(account) : null;
    },

    async propose(command: {
      applicantUserId: string;
      sessionId: string;
      primaryAuthenticatedAt: Date;
      idempotencyKey: string;
      bankBin: string;
      accountNumber: string;
      accountHolderLabel: string;
    }): Promise<ReceivingAccountProjection> {
      const occurredAt = now();
      const authenticationAge = occurredAt.getTime() - command.primaryAuthenticatedAt.getTime();
      if (
        Number.isNaN(occurredAt.getTime()) ||
        Number.isNaN(command.primaryAuthenticatedAt.getTime()) ||
        authenticationAge < 0 ||
        authenticationAge > RECENT_AUTHENTICATION_MS
      ) {
        throw new ReceivingAccountServiceError("Recent authentication required");
      }
      if (!command.sessionId || !command.idempotencyKey) {
        throw new ReceivingAccountServiceError("Receiving account command is invalid");
      }
      const normalized = normalizeReceivingAccountProposal({
        bankBin: command.bankBin,
        accountNumber: command.accountNumber,
        accountHolderLabel: command.accountHolderLabel,
        supportedBanks: input.supportedBanks,
      });
      const accountFingerprint = fingerprintReceivingAccount({
        bankBin: normalized.bankBin,
        accountNumber: normalized.accountNumber,
        key: input.lookupHmacKey,
      });
      const keyHash = createLookupHmac({
        value: command.idempotencyKey,
        context: "payments-command-key",
        key: input.lookupHmacKey,
      });
      const requestFingerprint = createLookupHmac({
        value: JSON.stringify([
          "receiving-account-proposal-v1",
          command.applicantUserId,
          command.sessionId,
          normalized.bankBin,
          normalized.accountNumber,
          normalized.accountHolderLabel,
        ]),
        context: "payments-command",
        key: input.lookupHmacKey,
      });

      return input.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`payments-account:${command.applicantUserId}`}, 0))`,
        );
        const idempotency = await beginIdempotentCommand(tx, {
          actorUserId: command.applicantUserId,
          commandScope: "payments.receiving_account.propose",
          keyHash,
          requestFingerprint,
          expiresAt: new Date(occurredAt.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: occurredAt,
        });
        if (idempotency.kind === "replay") {
          const referenceId = parseReplayReference(idempotency.resultReference);
          if (!referenceId) throw new ReceivingAccountServiceError("Receiving account replay is invalid");
          const [replayed] = await tx
            .select()
            .from(paymentsReceivingAccountOnboarding)
            .where(
              and(
                eq(paymentsReceivingAccountOnboarding.id, referenceId),
                eq(paymentsReceivingAccountOnboarding.applicantUserId, command.applicantUserId),
                isNull(paymentsReceivingAccountOnboarding.retiredAt),
                isNull(paymentsReceivingAccountOnboarding.minimizedAt),
                isNotNull(paymentsReceivingAccountOnboarding.accountNumberEnvelope),
                isNotNull(paymentsReceivingAccountOnboarding.accountHolderLabelEnvelope),
              ),
            )
            .limit(1);
          if (!replayed) throw new ReceivingAccountServiceError("Receiving account replay is invalid");
          return projection(replayed);
        }
        if (idempotency.kind !== "acquired") {
          throw new ReceivingAccountServiceError("Receiving account command conflicts");
        }

        const [applicant] = await tx
          .select({ id: identityUsers.id })
          .from(identityUsers)
          .where(
            and(
              eq(identityUsers.id, command.applicantUserId),
              eq(identityUsers.accessStatus, "active"),
              eq(identityUsers.emailVerified, true),
            ),
          )
          .limit(1);
        if (!applicant) throw new ReceivingAccountServiceError("Eligible applicant required");

        const [current] = await tx
          .select()
          .from(paymentsReceivingAccountOnboarding)
          .where(
            and(
              eq(paymentsReceivingAccountOnboarding.applicantUserId, command.applicantUserId),
              isNull(paymentsReceivingAccountOnboarding.retiredAt),
            ),
          )
          .limit(1)
          .for("update");

        if (
          current?.accountFingerprint === accountFingerprint &&
          current.minimizedAt === null &&
          current.accountNumberEnvelope !== null &&
          current.accountHolderLabelEnvelope !== null
        ) {
          await completeIdempotentCommand(tx, {
            recordId: idempotency.recordId,
            resultReference: replayReference(current.id),
            completedAt: occurredAt,
          });
          return projection(current);
        }

        const recordId = id();
        const onboardingId = current?.onboardingId ?? id();
        if (!referencePattern.test(recordId) || !referencePattern.test(onboardingId)) {
          throw new ReceivingAccountServiceError("Receiving account identifier is invalid");
        }
        if (current) {
          await tx
            .update(paymentsReceivingAccountOnboarding)
            .set({ retiredAt: occurredAt, updatedAt: occurredAt })
            .where(
              and(
                eq(paymentsReceivingAccountOnboarding.id, current.id),
                isNull(paymentsReceivingAccountOnboarding.retiredAt),
              ),
            );
        }
        const [created] = await tx
          .insert(paymentsReceivingAccountOnboarding)
          .values({
            id: recordId,
            onboardingId,
            applicantUserId: command.applicantUserId,
            version: (current?.version ?? 0) + 1,
            bankBin: normalized.bankBin,
            bankName: normalized.bankName,
            accountNumberEnvelope: encryptSensitiveField({
              plaintext: normalized.accountNumber,
              binding: {
                recordType: "payments_receiving_account",
                recordId,
                fieldName: "account_number",
              },
              keyring: input.keyring,
            }),
            accountHolderLabelEnvelope: encryptSensitiveField({
              plaintext: normalized.accountHolderLabel,
              binding: {
                recordType: "payments_receiving_account",
                recordId,
                fieldName: "account_holder_label",
              },
              keyring: input.keyring,
            }),
            maskedSuffix: normalized.maskedSuffix,
            accountFingerprint,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning();
        if (!created) throw new ReceivingAccountServiceError("Receiving account was not created");
        if (
          !(await completeIdempotentCommand(tx, {
            recordId: idempotency.recordId,
            resultReference: replayReference(created.id),
            completedAt: occurredAt,
          }))
        ) {
          throw new ReceivingAccountServiceError("Receiving account command did not complete");
        }
        return projection(created);
      });
    },
  };
}

export function createCreatorReceivingAccountReferenceValidator(input: {
  db: PawketDatabase;
}) {
  return {
    async isValidForApplicant(candidate: {
      applicantUserId: string;
      reference: string;
    }, database?: PawketDatabase | PawketTransaction): Promise<boolean> {
      if (!referencePattern.test(candidate.reference)) return false;
      const [account] = await (database ?? input.db)
        .select({ id: paymentsReceivingAccountOnboarding.id })
        .from(paymentsReceivingAccountOnboarding)
        .where(
          and(
            eq(paymentsReceivingAccountOnboarding.id, candidate.reference),
            eq(paymentsReceivingAccountOnboarding.applicantUserId, candidate.applicantUserId),
            isNull(paymentsReceivingAccountOnboarding.retiredAt),
            isNull(paymentsReceivingAccountOnboarding.minimizedAt),
            isNotNull(paymentsReceivingAccountOnboarding.accountNumberEnvelope),
            isNotNull(paymentsReceivingAccountOnboarding.accountHolderLabelEnvelope),
          ),
        )
        .limit(1)
        .for("update");
      return Boolean(account);
    },
  };
}
