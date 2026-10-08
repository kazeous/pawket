import { beginIdempotentCommand, completeIdempotentCommand, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { commissionCommandFingerprint, commissionIdempotencyKey, commissionIdentifier, commissionTime, lockCommissionCreator, readCommissionRecord } from "@pawket/orders";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionEnvelope, type EncryptionKeyring } from "@pawket/security";
import { ResolutionError, resolutionFail, type ResolutionActor, type ResolutionCommand, type ResolutionOwnerCommand, type ResolutionErrorCode, RESOLUTION_ERRORS } from "./contracts.js";
import type { ResolutionSessionPort } from "./ports.js";

type Change = Readonly<{ resultReference: string; at: Date; guardUntil?: Date }>;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; session: ResolutionSessionPort;
  authorizeCommand?(tx: PawketTransaction, actor: ResolutionActor): Promise<void>;
  consumeStepUpProof?(tx: PawketTransaction, input: Readonly<{ proofId: string; sessionId: string; userId: string; actionClass: string; now: Date }>): Promise<boolean>;
  now?(): Date;
}>;
/** creatorOf must authorize the command target on both first execution and replay. */
export function createResolutionCommandKit(input: Input) {
  if (input.lookupHmacKey.length < 32) resolutionFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date());
  const now = () => { const at = clock(); commissionTime(at); return new Date(at); };
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof ResolutionError) throw error;
      if (error instanceof Error && error.name === "CommissionError" && "code" in error && error.code === "expired") resolutionFail("deadline_passed");
      if (error instanceof Error && ["CommissionError", "CommissionRefundError", "TrustCaseError"].includes(error.name) && "code" in error &&
        (RESOLUTION_ERRORS as readonly unknown[]).includes(error.code)) resolutionFail(error.code as ResolutionErrorCode);
      // Drizzle wraps postgres-js failures in cause; map this domain's active-record constraints.
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
        if ("code" in cause && cause.code === "23505" && "constraint_name" in cause && cause.constraint_name === "commission_proposals_pending_uidx") resolutionFail("proposal_pending");
        if ("code" in cause && cause.code === "23505" && "constraint_name" in cause && cause.constraint_name === "commission_disputes_open_uidx") resolutionFail("dispute_open");
        cause = cause.cause;
      }
      return resolutionFail("dependency_unavailable");
    }
  }
  async function mutate(command: ResolutionCommand, scope: string, payload: unknown, creatorOf: (tx: PawketTransaction) => Promise<string>,
    apply: (tx: PawketTransaction) => Promise<Change>, stepUp?: { proofId: string; actionClass: string }): Promise<string> {
    const candidate = readCommissionRecord(command.actor, ["userId", "sessionId"]);
    if (!candidate || !commissionIdentifier(candidate.userId) || !commissionIdentifier(candidate.sessionId)) resolutionFail("not_authorized");
    const actor = { userId: candidate.userId, sessionId: candidate.sessionId };
    if (!commissionIdentifier(command.requestId) || !commissionIdempotencyKey(command.idempotencyKey) || !commissionIdentifier(scope)) resolutionFail("invalid_request");
    return boundary(() => input.db.transaction(async (tx) => {
      const startedAt = now();
      const started = await beginIdempotentCommand(tx, { actorUserId: actor.userId, commandScope: `resolutions.commission.${scope}`,
        keyHash: createLookupHmac({ key, context: "resolution-command-key", value: command.idempotencyKey }),
        requestFingerprint: commissionCommandFingerprint(key, "resolution-command", [scope, actor.userId, payload]),
        now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
      if (started.kind !== "acquired" && started.kind !== "replay") resolutionFail("idempotency_conflict");
      await lockCommissionCreator(tx, await creatorOf(tx));
      const at = now(); const proof = await input.session.getTipSessionAssurance(tx, actor, at);
      if (!proof || !(proof.sessionExpiresAt instanceof Date) || !Number.isFinite(proof.sessionExpiresAt.getTime()) || proof.sessionExpiresAt <= at) resolutionFail("not_authorized");
      if (started.kind === "replay") {
        if (proof.sessionExpiresAt <= now()) resolutionFail("not_authorized");
        await input.authorizeCommand?.(tx, actor);
        return started.resultReference;
      }
      if (stepUp) {
        let accepted = false;
        try { accepted = await input.consumeStepUpProof?.(tx, { proofId: stepUp.proofId, ...actor, actionClass: stepUp.actionClass, now: at }) ?? false; }
        catch { resolutionFail("owner_step_up_required"); }
        if (!accepted) resolutionFail("owner_step_up_required");
      }
      const changed = await apply(tx); const completedAt = now();
      commissionTime(changed.at); if (changed.guardUntil !== undefined) commissionTime(changed.guardUntil);
      if (completedAt < startedAt || completedAt < changed.at || completedAt >= proof.sessionExpiresAt) resolutionFail("not_authorized");
      if (changed.guardUntil && completedAt >= changed.guardUntil) resolutionFail("deadline_passed");
      if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: changed.resultReference, completedAt })) resolutionFail("idempotency_conflict");
      await input.authorizeCommand?.(tx, actor);
      return changed.resultReference;
    }));
  }
  return {
    now,
    mutate: (command: ResolutionCommand, scope: string, payload: unknown, creatorOf: (tx: PawketTransaction) => Promise<string>, apply: (tx: PawketTransaction) => Promise<Change>) =>
      mutate(command, scope, payload, creatorOf, apply),
    async ownerMutate(command: ResolutionOwnerCommand, scope: string, payload: unknown, creatorOf: (tx: PawketTransaction) => Promise<string>, actionClass: string, apply: (tx: PawketTransaction) => Promise<Change>) {
      if (!commissionIdentifier(command.stepUpProofId) || !commissionIdentifier(actionClass)) resolutionFail("invalid_request");
      return mutate({ ...command, actor: command.owner }, scope, payload, creatorOf, apply, { proofId: command.stepUpProofId, actionClass });
    },
    encrypt<R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, text: string): EncryptionEnvelope<R, F> {
      try { return encryptSensitiveField({ keyring: input.keyring, plaintext: JSON.stringify(text), binding: { recordType, recordId, fieldName } }); }
      catch { return resolutionFail("dependency_unavailable"); }
    },
    decrypt<R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, envelope: EncryptionEnvelope<R, F>): string {
      try {
        const text: unknown = JSON.parse(decryptSensitiveField({ keyring: input.keyring, envelope, binding: { recordType, recordId, fieldName } }));
        if (typeof text !== "string") resolutionFail("dependency_unavailable"); return text;
      } catch { return resolutionFail("dependency_unavailable"); }
    },
  };
}
