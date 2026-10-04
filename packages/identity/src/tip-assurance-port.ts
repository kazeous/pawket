import { createOidcAssurancePort } from "./oidc-assurance-port.js";
import type { OidcSessionProvider } from "./oidc-session.js";
import type { PawketTransaction } from "@pawket/database";

export type TipSessionAssurance = Readonly<{
  primaryAuthenticatedAt: Date; mfaEnrolled: boolean; mfaVerifiedAt: Date | null; sessionExpiresAt: Date;
}>;

export function createIdentityTipAssurancePort(provider: OidcSessionProvider, clock?: () => Date) {
  const assurance = createOidcAssurancePort(provider, clock);
  return { async getTipSessionAssurance(tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date): Promise<TipSessionAssurance | null> {
    const evidence = await assurance.read(tx, actor, at);
    // Domain ports deliberately reject unknown fields. Keep protocol metadata private to Identity.
    return evidence ? { primaryAuthenticatedAt: evidence.primaryAuthenticatedAt, mfaEnrolled: evidence.mfaEnrolled,
      mfaVerifiedAt: evidence.mfaVerifiedAt, sessionExpiresAt: evidence.sessionExpiresAt } : null;
  } };
}
