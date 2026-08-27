import {
  beginIdempotentCommand,
  completeIdempotentCommand,
  creatorApplicationAttestations,
  creatorApplicationDecisions,
  creatorApplicationRevisions,
  creatorApplications,
  identityUsers,
  insertOutboxEvent,
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
import { and, desc, eq } from "drizzle-orm";

import {
  CreatorApplicationPolicyError,
  creatorApplicationVietnamDate,
  parseCreatorDateOfBirth,
  rejectionCooldownUntil,
  validateCreatorPortfolioUrls,
} from "./creator-application-policy.js";
import type { CreatorReceivingAccountReferencePort } from "./creator-receiving-account-reference.js";

export const CREATOR_APPLICATION_ATTESTATION_VERSIONS = {
  dob_truthfulness: "creator-dob-warning-v1",
  portfolio_rights: "creator-portfolio-rights-v1",
  truthful_information: "creator-truthful-information-v1",
  creator_terms: "creator-terms-v1",
  privacy: "privacy-v1",
} as const;

type Draft = {
  artistDisplayName?: string;
  shortIntroduction?: string;
  dateOfBirth?: string;
  portfolioUrls?: unknown;
  primaryArtDiscipline?: string;
  practiceDescription?: string;
  contentIntent?: string;
  proposedReceivingAccountId?: string;
};

type NormalizedDraft = {
  artistDisplayName: string;
  shortIntroduction: string;
  dateOfBirth: string;
  portfolioUrls: string[];
  primaryArtDiscipline: string;
  practiceDescription: string;
  contentIntent: "general_audience_only" | "may_include_age_restricted";
  proposedReceivingAccountId: string;
};

type AttestationInput = {
  dateOfBirthAcknowledged: boolean;
  truthfulInformationAccepted: boolean;
  portfolioRightsAccepted: boolean;
  creatorTermsAccepted: boolean;
  privacyAccepted: boolean;
};

type Command = {
  userId: string;
  idempotencyKey: string;
  expectedVersion?: number;
};

type ReplaySnapshot = {
  applicationId: string;
  revisionId: string;
  state: "submitted" | "withdrawn";
  version: number;
};

type CreatorApplicationServiceInput = {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
  commandFingerprintKey: Uint8Array;
  receivingAccountReferences: CreatorReceivingAccountReferencePort;
  idFactory?: () => string;
  now?: () => Date;
};

const boundedString = (value: unknown, min: number, max: number): string | null =>
  typeof value === "string" && value.trim().length >= min && value.trim().length <= max
    ? value.trim()
    : null;

function policy(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new CreatorApplicationPolicyError(reason);
}

function hasDatabaseConstraint(error: unknown, code: string, constraint: string): boolean {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (candidate.code === code && candidate.constraint_name === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

function encodeReplaySnapshot(snapshot: ReplaySnapshot): string {
  return `creator-result-v1:${snapshot.state}:${snapshot.version}:${snapshot.applicationId}:${snapshot.revisionId}`;
}

function parseReplaySnapshot(value: string): ReplaySnapshot | null {
  const match =
    /^creator-result-v1:(submitted|withdrawn):([1-9]\d*):([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(
      value,
    );
  return match
    ? {
        state: match[1] as ReplaySnapshot["state"],
        version: Number(match[2]),
        applicationId: match[3]!,
        revisionId: match[4]!,
      }
    : null;
}

function normalizeDraft(input: Draft): NormalizedDraft {
  const artistDisplayName = boundedString(input.artistDisplayName, 1, 100);
  const shortIntroduction = boundedString(input.shortIntroduction, 1, 500);
  const dateOfBirth = boundedString(input.dateOfBirth, 10, 10);
  const primaryArtDiscipline = boundedString(input.primaryArtDiscipline, 1, 100);
  const practiceDescription = boundedString(input.practiceDescription, 1, 1_000);
  const proposedReceivingAccountId = boundedString(input.proposedReceivingAccountId, 1, 200);
  policy(
    artistDisplayName &&
      shortIntroduction &&
      dateOfBirth &&
      primaryArtDiscipline &&
      practiceDescription &&
      proposedReceivingAccountId,
    "incomplete_draft",
  );
  policy(
    input.contentIntent === "general_audience_only" ||
      input.contentIntent === "may_include_age_restricted",
    "invalid_content_intent",
  );
  return {
    artistDisplayName,
    shortIntroduction,
    dateOfBirth,
    portfolioUrls: validateCreatorPortfolioUrls(input.portfolioUrls),
    primaryArtDiscipline,
    practiceDescription,
    contentIntent: input.contentIntent,
    proposedReceivingAccountId,
  };
}

function draftRevisionValues(input: Draft) {
  return {
    artistDisplayName: boundedString(input.artistDisplayName, 1, 100),
    shortIntroduction: boundedString(input.shortIntroduction, 1, 500),
    portfolioUrls: Array.isArray(input.portfolioUrls) ? (input.portfolioUrls as string[]) : null,
    primaryArtDiscipline: boundedString(input.primaryArtDiscipline, 1, 100),
    practiceDescription: boundedString(input.practiceDescription, 1, 1_000),
    contentIntent: typeof input.contentIntent === "string" ? input.contentIntent : null,
    proposedReceivingAccountId: boundedString(input.proposedReceivingAccountId, 1, 200),
  };
}

export function createCreatorApplicationService(input: CreatorApplicationServiceInput) {
  const id = input.idFactory ?? (() => crypto.randomUUID());
  const now = input.now ?? (() => new Date());

  async function approvedReceivingAccountReference(
    database: PawketDatabase | PawketTransaction,
    userId: string,
    value: unknown,
    required: boolean,
  ): Promise<string | null> {
    const reference = boundedString(value, 1, 200);
    if (!reference) {
      policy(!required, "incomplete_draft");
      return null;
    }
    policy(
      await input.receivingAccountReferences.isValidForApplicant({
        applicantUserId: userId,
        reference,
      }, database),
      "invalid_receiving_account_reference",
    );
    return reference;
  }

  async function response(
    database: PawketDatabase | PawketTransaction,
    applicationId: string,
    userId: string,
    snapshot?: ReplaySnapshot,
    includeLatestDecision = false,
  ) {
    const [application] = await database
      .select()
      .from(creatorApplications)
      .where(
        and(
          eq(creatorApplications.id, applicationId),
          eq(creatorApplications.userId, userId),
        ),
      )
      .limit(1);
    if (!application) throw new CreatorApplicationPolicyError("not_found");
    const revisionId = snapshot?.revisionId ?? application.currentRevisionId;
    policy(revisionId, "missing_revision");
    const [revision] = await database
      .select()
      .from(creatorApplicationRevisions)
      .where(
        and(
          eq(creatorApplicationRevisions.id, revisionId),
          eq(creatorApplicationRevisions.applicationId, application.id),
        ),
      )
      .limit(1);
    if (!revision) throw new CreatorApplicationPolicyError("missing_revision");
    const dateOfBirth = revision.dobEnvelope
      ? decryptSensitiveField({
          envelope: revision.dobEnvelope as EncryptionEnvelope<
            "creator_application_revision",
            "date_of_birth"
          >,
          binding: {
            recordType: "creator_application_revision",
            recordId: revision.id,
            fieldName: "date_of_birth",
          },
          keyring: input.keyring,
        })
      : null;
    const cooldownUntil = snapshot
      ? null
      : application.state === "rejected" && application.rejectedAt
        ? rejectionCooldownUntil(application.rejectedAt)
        : application.cooldownUntil;
    const [latestDecision] = includeLatestDecision
      ? await database
          .select({
            action: creatorApplicationDecisions.action,
            reasonCode: creatorApplicationDecisions.reasonCode,
            applicantExplanation: creatorApplicationDecisions.applicantExplanation,
            createdAt: creatorApplicationDecisions.createdAt,
          })
          .from(creatorApplicationDecisions)
          .where(eq(creatorApplicationDecisions.applicationId, application.id))
          .orderBy(
            desc(creatorApplicationDecisions.expectedVersion),
            desc(creatorApplicationDecisions.createdAt),
          )
          .limit(1)
      : [];
    return {
      id: application.id,
      state: snapshot?.state ?? application.state,
      version: snapshot?.version ?? application.version,
      cooldownUntil,
      ...(includeLatestDecision ? { latestDecision: latestDecision ?? null } : {}),
      revision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        artistDisplayName: revision.artistDisplayName,
        shortIntroduction: revision.shortIntroduction,
        dateOfBirth,
        portfolioUrls: revision.portfolioUrls,
        primaryArtDiscipline: revision.primaryArtDiscipline,
        practiceDescription: revision.practiceDescription,
        contentIntent: revision.contentIntent,
        proposedReceivingAccountId: revision.proposedReceivingAccountId,
        submittedAt: revision.submittedAt,
      },
    };
  }

  async function command<T>(
    kind: string,
    inputCommand: Command,
    fingerprint: unknown,
    work: (tx: PawketTransaction) => Promise<string>,
  ): Promise<T> {
    policy(/^[A-Za-z0-9._-]{8,200}$/u.test(inputCommand.idempotencyKey), "invalid_idempotency_key");
    const at = now();
    try {
      return await input.db.transaction(async (tx) => {
        const started = await beginIdempotentCommand(tx, {
          actorUserId: inputCommand.userId,
          commandScope: `creator.${kind}`,
          keyHash: hashOpaqueToken(inputCommand.idempotencyKey, "creator-command"),
          requestFingerprint: createLookupHmac({
            value: JSON.stringify(fingerprint),
            context: "creator-command-request",
            key: input.commandFingerprintKey,
          }),
          expiresAt: new Date(at.getTime() + 86_400_000),
          now: at,
        });
        if (started.kind === "replay") {
          const snapshot = parseReplaySnapshot(started.resultReference);
          return (snapshot
            ? response(tx, snapshot.applicationId, inputCommand.userId, snapshot)
            : response(tx, started.resultReference, inputCommand.userId)) as Promise<T>;
        }
        if (started.kind !== "acquired") {
          throw new CreatorApplicationPolicyError("idempotency_conflict");
        }
        const applicationId = await work(tx);
        const resultResponse = await response(tx, applicationId, inputCommand.userId);
        const resultReference =
          kind === "submit" || kind === "withdraw"
            ? encodeReplaySnapshot({
                applicationId,
                revisionId: resultResponse.revision.id,
                state: kind === "submit" ? "submitted" : "withdrawn",
                version: resultResponse.version,
              })
            : applicationId;
        await completeIdempotentCommand(tx, {
          recordId: started.recordId,
          resultReference,
          completedAt: at,
        });
        return resultResponse as T;
      });
    } catch (error) {
      if (
        kind === "save" &&
        hasDatabaseConstraint(error, "23505", "creator_applications_one_nonterminal_uidx")
      ) {
        throw new CreatorApplicationPolicyError("nonterminal_application_exists");
      }
      throw error;
    }
  }

  async function currentApplicationForUpdate(tx: PawketTransaction, userId: string) {
    const [application] = await tx
      .select()
      .from(creatorApplications)
      .where(eq(creatorApplications.userId, userId))
      .orderBy(desc(creatorApplications.updatedAt))
      .limit(1)
      .for("update");
    return application;
  }

  return {
    async getForApplicant({ userId }: { userId: string }) {
      const [application] = await input.db
        .select({ id: creatorApplications.id })
        .from(creatorApplications)
        .where(eq(creatorApplications.userId, userId))
        .orderBy(desc(creatorApplications.updatedAt))
        .limit(1);
      return application ? response(input.db, application.id, userId, undefined, true) : null;
    },

    async saveDraft(commandInput: Command & Draft) {
      return command("save", commandInput, { ...commandInput, idempotencyKey: undefined }, async (tx) => {
        const at = now();
        const existing = await currentApplicationForUpdate(tx, commandInput.userId);
        if (existing && (existing.state === "draft" || existing.state === "changes_requested")) {
          policy(
            commandInput.expectedVersion !== undefined &&
              existing.version === commandInput.expectedVersion,
            "stale_version",
          );
          policy(existing.currentRevisionId, "missing_revision");
          const [revision] = await tx
            .select()
            .from(creatorApplicationRevisions)
            .where(eq(creatorApplicationRevisions.id, existing.currentRevisionId))
            .limit(1);
          if (!revision) throw new CreatorApplicationPolicyError("missing_revision");

          const priorDateOfBirth = revision.dobEnvelope
            ? decryptSensitiveField({
                envelope: revision.dobEnvelope as EncryptionEnvelope<
                  "creator_application_revision",
                  "date_of_birth"
                >,
                binding: {
                  recordType: "creator_application_revision",
                  recordId: revision.id,
                  fieldName: "date_of_birth",
                },
                keyring: input.keyring,
              })
            : "";
          const mergedDraft: Draft = {
            artistDisplayName: revision.artistDisplayName ?? undefined,
            shortIntroduction: revision.shortIntroduction ?? undefined,
            dateOfBirth: priorDateOfBirth,
            portfolioUrls: revision.portfolioUrls,
            primaryArtDiscipline: revision.primaryArtDiscipline ?? undefined,
            practiceDescription: revision.practiceDescription ?? undefined,
            contentIntent: revision.contentIntent ?? undefined,
            proposedReceivingAccountId: revision.proposedReceivingAccountId ?? undefined,
            ...commandInput,
          };
          mergedDraft.proposedReceivingAccountId =
            (await approvedReceivingAccountReference(
              tx,
              commandInput.userId,
              mergedDraft.proposedReceivingAccountId,
              false,
            )) ?? undefined;
          const dateOfBirth = boundedString(mergedDraft.dateOfBirth, 10, 10);
          const nextVersion = existing.version + 1;

          if (existing.state === "changes_requested" && revision.submittedAt) {
            const revisionId = id();
            const dobEnvelope = dateOfBirth
              ? encryptSensitiveField({
                  plaintext: dateOfBirth,
                  binding: {
                    recordType: "creator_application_revision",
                    recordId: revisionId,
                    fieldName: "date_of_birth",
                  },
                  keyring: input.keyring,
                })
              : null;
            await tx.insert(creatorApplicationRevisions).values({
              id: revisionId,
              applicationId: existing.id,
              revisionNumber: revision.revisionNumber + 1,
              ...draftRevisionValues(mergedDraft),
              dobEnvelope,
              createdAt: at,
              updatedAt: at,
            });
            const [updated] = await tx
              .update(creatorApplications)
              .set({ currentRevisionId: revisionId, version: nextVersion, updatedAt: at })
              .where(
                and(
                  eq(creatorApplications.id, existing.id),
                  eq(creatorApplications.version, existing.version),
                ),
              )
              .returning();
            if (!updated) throw new CreatorApplicationPolicyError("stale_version");
            return existing.id;
          }

          const [updated] = await tx
            .update(creatorApplications)
            .set({ version: nextVersion, updatedAt: at })
            .where(
              and(
                eq(creatorApplications.id, existing.id),
                eq(creatorApplications.version, existing.version),
              ),
            )
            .returning();
          if (!updated) throw new CreatorApplicationPolicyError("stale_version");
          await tx
            .update(creatorApplicationRevisions)
            .set({
              ...draftRevisionValues(mergedDraft),
              dobEnvelope: dateOfBirth
                ? encryptSensitiveField({
                    plaintext: dateOfBirth,
                    binding: {
                      recordType: "creator_application_revision",
                      recordId: revision.id,
                      fieldName: "date_of_birth",
                    },
                    keyring: input.keyring,
                  })
                : null,
              updatedAt: at,
            })
            .where(eq(creatorApplicationRevisions.id, revision.id));
          return existing.id;
        }

        const [prior] = await tx
          .select()
          .from(creatorApplications)
          .where(
            and(
              eq(creatorApplications.userId, commandInput.userId),
              eq(creatorApplications.state, "rejected"),
            ),
          )
          .orderBy(desc(creatorApplications.rejectedAt))
          .limit(1);
        if (prior?.rejectedAt && at < rejectionCooldownUntil(prior.rejectedAt)) {
          throw new CreatorApplicationPolicyError("reapplication_cooldown");
        }

        const applicationId = id();
        const revisionId = id();
        const proposedReceivingAccountId = await approvedReceivingAccountReference(
          tx,
          commandInput.userId,
          commandInput.proposedReceivingAccountId,
          false,
        );
        const dateOfBirth = boundedString(commandInput.dateOfBirth, 10, 10);
        const dobEnvelope = dateOfBirth
          ? encryptSensitiveField({
              plaintext: dateOfBirth,
              binding: {
                recordType: "creator_application_revision",
                recordId: revisionId,
                fieldName: "date_of_birth",
              },
              keyring: input.keyring,
            })
          : null;
        await tx.insert(creatorApplications).values({
          id: applicationId,
          userId: commandInput.userId,
          state: "draft",
          version: 1,
          currentRevisionId: revisionId,
          createdAt: at,
          updatedAt: at,
        });
        await tx.insert(creatorApplicationRevisions).values({
          id: revisionId,
          applicationId,
          revisionNumber: 1,
          ...draftRevisionValues({
            ...commandInput,
            proposedReceivingAccountId: proposedReceivingAccountId ?? undefined,
          }),
          dobEnvelope,
          createdAt: at,
          updatedAt: at,
        });
        return applicationId;
      });
    },

    async submit(commandInput: Command & Draft & AttestationInput) {
      return command(
        "submit",
        commandInput,
        { ...commandInput, idempotencyKey: undefined },
        async (tx) => {
          const at = now();
          const application = await currentApplicationForUpdate(tx, commandInput.userId);
          policy(
            application &&
              (application.state === "draft" || application.state === "changes_requested") &&
              application.version === commandInput.expectedVersion,
            "stale_or_invalid_state",
          );
          policy(application.currentRevisionId, "missing_revision");
          policy(
            commandInput.dateOfBirthAcknowledged &&
              commandInput.truthfulInformationAccepted &&
              commandInput.portfolioRightsAccepted &&
              commandInput.creatorTermsAccepted &&
              commandInput.privacyAccepted,
            "missing_attestation",
          );

          const snapshot = normalizeDraft(commandInput);
          await approvedReceivingAccountReference(
            tx,
            commandInput.userId,
            snapshot.proposedReceivingAccountId,
            true,
          );
          const parsedDateOfBirth = parseCreatorDateOfBirth(snapshot.dateOfBirth, at);
          policy(parsedDateOfBirth.age >= 18, "underage");
          const [user] = await tx
            .select()
            .from(identityUsers)
            .where(
              and(
                eq(identityUsers.id, commandInput.userId),
                eq(identityUsers.emailVerified, true),
              ),
            )
            .limit(1);
          policy(user, "email_unverified");

          const [currentRevision] = await tx
            .select()
            .from(creatorApplicationRevisions)
            .where(eq(creatorApplicationRevisions.id, application.currentRevisionId))
            .limit(1);
          if (!currentRevision) throw new CreatorApplicationPolicyError("missing_revision");

          const revisionId =
            application.state === "changes_requested" && currentRevision.submittedAt
              ? id()
              : currentRevision.id;
          const dobEnvelope = encryptSensitiveField({
            plaintext: parsedDateOfBirth.value,
            binding: {
              recordType: "creator_application_revision",
              recordId: revisionId,
              fieldName: "date_of_birth",
            },
            keyring: input.keyring,
          });
          const submittedRevisionValues = {
            artistDisplayName: snapshot.artistDisplayName,
            shortIntroduction: snapshot.shortIntroduction,
            applicantEmail: user.email,
            dobEnvelope,
            portfolioUrls: snapshot.portfolioUrls,
            primaryArtDiscipline: snapshot.primaryArtDiscipline,
            practiceDescription: snapshot.practiceDescription,
            contentIntent: snapshot.contentIntent,
            proposedReceivingAccountId: snapshot.proposedReceivingAccountId,
            ageAtSubmission: parsedDateOfBirth.age,
            ageEvaluatedOn: creatorApplicationVietnamDate(at),
            submittedAt: null,
            updatedAt: at,
          };

          if (revisionId === currentRevision.id) {
            policy(!currentRevision.submittedAt, "stale_or_invalid_state");
            await tx
              .update(creatorApplicationRevisions)
              .set(submittedRevisionValues)
              .where(eq(creatorApplicationRevisions.id, revisionId));
          } else {
            await tx.insert(creatorApplicationRevisions).values({
              id: revisionId,
              applicationId: application.id,
              revisionNumber: currentRevision.revisionNumber + 1,
              ...submittedRevisionValues,
              createdAt: at,
            });
          }

          for (const [type, policyVersion] of Object.entries(
            CREATOR_APPLICATION_ATTESTATION_VERSIONS,
          )) {
            await tx.insert(creatorApplicationAttestations).values({
              id: id(),
              revisionId,
              type,
              policyVersion,
              acceptedAt: at,
              actorUserId: commandInput.userId,
            });
          }
          await tx
            .update(creatorApplicationRevisions)
            .set({ submittedAt: at, updatedAt: at })
            .where(eq(creatorApplicationRevisions.id, revisionId));
          const [updated] = await tx
            .update(creatorApplications)
            .set({
              state: "submitted",
              currentRevisionId: revisionId,
              version: application.version + 1,
              updatedAt: at,
            })
            .where(
              and(
                eq(creatorApplications.id, application.id),
                eq(creatorApplications.version, application.version),
              ),
            )
            .returning();
          if (!updated) throw new CreatorApplicationPolicyError("stale_version");
          await insertOutboxEvent(tx, {
            eventType: "creator.application.submitted.v1",
            eventVersion: 1,
            aggregateType: "creator_application",
            aggregateId: application.id,
            payload: {
              applicationId: application.id,
              state: "submitted",
              version: updated.version,
              correlationId: application.id,
            },
            occurredAt: at,
          });
          return application.id;
        },
      );
    },

    async withdraw(commandInput: Command) {
      return command(
        "withdraw",
        commandInput,
        { ...commandInput, idempotencyKey: undefined },
        async (tx) => {
          const at = now();
          const application = await currentApplicationForUpdate(tx, commandInput.userId);
          policy(
            application &&
              ["draft", "submitted", "under_review", "changes_requested"].includes(
                application.state,
              ) &&
              application.version === commandInput.expectedVersion,
            "stale_or_invalid_state",
          );
          const [updated] = await tx
            .update(creatorApplications)
            .set({ state: "withdrawn", reviewerUserId: null, reviewClaimedAt: null, reviewClaimExpiresAt: null, version: application.version + 1, updatedAt: at })
            .where(
              and(
                eq(creatorApplications.id, application.id),
                eq(creatorApplications.version, application.version),
              ),
            )
            .returning();
          if (!updated) throw new CreatorApplicationPolicyError("stale_version");
          await insertOutboxEvent(tx, {
            eventType: "creator.application.withdrawn.v1",
            eventVersion: 1,
            aggregateType: "creator_application",
            aggregateId: application.id,
            payload: {
              applicationId: application.id,
              state: "withdrawn",
              version: updated.version,
              correlationId: application.id,
            },
            occurredAt: at,
          });
          return application.id;
        },
      );
    },
  };
}
