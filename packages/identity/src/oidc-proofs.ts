import { and, eq, gt, isNull } from "drizzle-orm";
import { identityOidcProofBindings, identityStepUpProofs, type PawketTransaction } from "@pawket/database";
import { createOidcAssurancePort } from "./oidc-assurance-port.js";
import type { OidcSessionProvider } from "./oidc-session.js";
import { OIDC_PRIMARY_FRESH_MS, OIDC_MFA_FRESH_MS } from "./oidc-policy.js";
import { StepUpProofError } from "./step-up-error.js";

export type OidcFreshness = { primaryFreshMs?: number; mfaFreshMs?: number };
type ProofInput = OidcFreshness & { userId: string; sessionId: string; actionClass: string; commandDigest: string; now: Date };
const validDigest = (value: string) => /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u.test(value);

/** Issue/consume inside the domain transaction: evidence and revocation stay fenced. */
export function createOidcProofRepository(provider: OidcSessionProvider, clock: () => Date = () => new Date()) {
  const assurance = createOidcAssurancePort(provider, clock);
  async function validity(tx: PawketTransaction, input: ProofInput) {
    if (!validDigest(input.commandDigest) || !/^[a-z][a-z0-9_.-]{2,63}$/u.test(input.actionClass)) return null;
    const primaryMs = Math.min(input.primaryFreshMs ?? OIDC_PRIMARY_FRESH_MS, OIDC_PRIMARY_FRESH_MS);
    const mfaMs = Math.min(input.mfaFreshMs ?? OIDC_MFA_FRESH_MS, OIDC_MFA_FRESH_MS);
    if (![primaryMs, mfaMs].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
    const proof = await assurance.read(tx, input, input.now);
    if (!proof) return null;
    const owner = input.actionClass.startsWith("owner.");
    if (owner && !await assurance.authorizeOwner(tx, input, input.now)) return null;
    const requiresMfa = owner || proof.mfaEnrolled;
    const primaryDeadline = proof.primaryAuthenticatedAt.getTime() + primaryMs;
    const mfaDeadline = requiresMfa ? (proof.mfaVerifiedAt?.getTime() ?? 0) + mfaMs : Infinity;
    const deadline = Math.min(primaryDeadline, mfaDeadline, proof.sessionExpiresAt.getTime());
    if (deadline <= Math.max(proof.checkedAt.getTime(), clock().getTime())) return null;
    return { ...proof, requiresMfa, expiresAt: new Date(deadline) };
  }
  async function existing(tx: PawketTransaction, input: ProofInput & { proofId: string }) {
    const evidence = await validity(tx, input);
    if (!evidence) return null;
    const [binding] = await tx.select().from(identityOidcProofBindings).where(and(
      eq(identityOidcProofBindings.proofId, input.proofId), eq(identityOidcProofBindings.authorizationVersion, evidence.authorizationVersion),
      eq(identityOidcProofBindings.commandDigest, input.commandDigest), eq(identityOidcProofBindings.providerRevision, provider.providerRevision),
      eq(identityOidcProofBindings.transactionId, evidence.transactionId),
    )).limit(1);
    if (!binding) return null;
    const checkedAt = new Date(Math.max(input.now.getTime(), clock().getTime()));
    if (evidence.expiresAt <= checkedAt) return null;
    return { evidence, checkedAt, predicate: and(
      eq(identityStepUpProofs.id, input.proofId), eq(identityStepUpProofs.userId, input.userId), eq(identityStepUpProofs.sessionId, input.sessionId),
      eq(identityStepUpProofs.actionClass, input.actionClass), eq(identityStepUpProofs.assuranceMethod, evidence.requiresMfa ? "mfa" : "primary"),
      isNull(identityStepUpProofs.consumedAt), gt(identityStepUpProofs.expiresAt, checkedAt),
    ) };
  }
  return {
    async check(tx: PawketTransaction, input: ProofInput): Promise<boolean> {
      return Boolean(await validity(tx, input));
    },
    async usable(tx: PawketTransaction, input: ProofInput & { proofId: string }): Promise<boolean> {
      const checked = await existing(tx, input); if (!checked) return false;
      const [proof] = await tx.select({ expiresAt: identityStepUpProofs.expiresAt }).from(identityStepUpProofs).where(checked.predicate).limit(1);
      const at = Math.max(checked.checkedAt.getTime(), clock().getTime());
      return Boolean(proof && proof.expiresAt.getTime() > at && checked.evidence.expiresAt.getTime() > at);
    },
    async create(tx: PawketTransaction, input: ProofInput & { deadline?: Date }) {
      const evidence = await validity(tx, input);
      const expiresAt = evidence ? new Date(Math.min(evidence.expiresAt.getTime(), input.deadline?.getTime() ?? Infinity)) : null;
      const checkedAt = new Date(Math.max(input.now.getTime(), clock().getTime()));
      if (!evidence || !expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt <= checkedAt) {
        throw new StepUpProofError(input.actionClass.startsWith("owner.") ? "OWNER_TOTP_REQUIRED" : "RECENT_AUTH_REQUIRED");
      }
      const [proof] = await tx.insert(identityStepUpProofs).values({ userId: input.userId, sessionId: input.sessionId,
        actionClass: input.actionClass, assuranceMethod: evidence.requiresMfa ? "mfa" : "primary", issuedAt: checkedAt, expiresAt }).returning({ id: identityStepUpProofs.id });
      if (!proof) throw new Error("OIDC proof insertion failed");
      await tx.insert(identityOidcProofBindings).values({ proofId: proof.id, authorizationVersion: evidence.authorizationVersion,
        commandDigest: input.commandDigest, providerRevision: provider.providerRevision, transactionId: evidence.transactionId });
      return { id: proof.id, expiresAt };
    },
    async consume(tx: PawketTransaction, input: ProofInput & { proofId: string }): Promise<boolean> {
      const checked = await existing(tx, input); if (!checked) return false;
      const [proof] = await tx.select({ expiresAt: identityStepUpProofs.expiresAt }).from(identityStepUpProofs).where(checked.predicate).for("update");
      const at = new Date(Math.max(checked.checkedAt.getTime(), clock().getTime()));
      if (!proof || proof.expiresAt <= at || checked.evidence.expiresAt <= at) return false;
      const [consumed] = await tx.update(identityStepUpProofs).set({ consumedAt: at }).where(checked.predicate).returning({ id: identityStepUpProofs.id });
      return Boolean(consumed);
    },
  };
}
