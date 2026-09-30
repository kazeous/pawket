import type { PawketTransaction } from "@pawket/database";
import { createOidcAssurancePort, OidcIdentityError, StepUpProofError, type OidcSessionProvider } from "@pawket/identity";

type Actor = { userId: string; sessionId: string; now: Date };
export function createOwnerTipPolicyAssurancePort(options: {
  provider: OidcSessionProvider;
  authorizeCommand: (tx: PawketTransaction, actor: Actor) => Promise<void>;
  now?: () => Date;
}) {
  const assurance = createOidcAssurancePort(options.provider, options.now);
  return {
    authorizeOwner: (tx: PawketTransaction, actor: Actor) => assurance.authorizeOwner(tx, actor, actor.now),
    async requireOwnerStepUp(tx: PawketTransaction, actor: Actor): Promise<boolean> {
      try { await options.authorizeCommand(tx, actor); return true; }
      catch (error) {
        if (error instanceof StepUpProofError || error instanceof OidcIdentityError) return false;
        throw error;
      }
    },
  };
}
