import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PawketTransaction } from "@pawket/database";
import { createOidcAssurancePort } from "./oidc-assurance-port.js";
import type { createOidcPendingCommandRepository, OidcPendingPayload } from "./oidc-pending-commands.js";
import { OidcIdentityError } from "./oidc-policy.js";
import { createOidcProofRepository, type OidcFreshness } from "./oidc-proofs.js";
import type { OidcSessionProvider } from "./oidc-session.js";
import type { OidcActorBinding } from "./oidc-transactions.js";

export type OidcCommandPolicy = Readonly<OidcFreshness & { actionClass: string; fresh: boolean }>;
type Commands = ReturnType<typeof createOidcPendingCommandRepository>;
type Actor = { userId: string; sessionId: string };
type Context = { actor: OidcActorBinding; payload: OidcPendingPayload; policy: OidcCommandPolicy;
  pendingId?: string; digest: string; issued: Set<string>; authorized: WeakSet<PawketTransaction>; failure?: OidcIdentityError };

/** The route supplies immutable request bytes. Domain services consume the proof
 * in their own transaction, preserving their lock order and rollback behavior. */
export function createOidcCommandContext(options: {
  provider: OidcSessionProvider; commands: Commands; now?: () => Date;
}) {
  const clock = options.now ?? (() => new Date()); const storage = new AsyncLocalStorage<Context>();
  const proofs = createOidcProofRepository(options.provider, clock); const assurance = createOidcAssurancePort(options.provider, clock);
  function context(actor: Actor, actionClass?: string) {
    const current = storage.getStore();
    if (!current || current.actor.userId !== actor.userId || current.actor.sessionId !== actor.sessionId ||
      (actionClass !== undefined && current.policy.actionClass !== actionClass)) throw new OidcIdentityError("actor_changed");
    return current;
  }
  async function valid(tx: PawketTransaction, current: Context) {
    const input = { ...current.actor, ...current.policy, commandDigest: current.digest, now: clock() };
    if (current.policy.fresh) return proofs.check(tx, input);
    const evidence = await assurance.read(tx, current.actor, input.now);
    return Boolean(evidence) && (!current.policy.actionClass.startsWith("owner.") || await assurance.authorizeOwner(tx, current.actor, input.now));
  }
  async function authorize(tx: PawketTransaction, actor: Actor): Promise<void> {
    const current = context(actor);
    if (!await valid(tx, current)) { current.failure = new OidcIdentityError("assurance_required"); throw current.failure; }
    if (current.authorized.has(tx)) return;
    if (current.pendingId) {
      await options.commands.consume(tx, { id: current.pendingId, actor: current.actor, now: clock() }, async (payload) => {
        if (options.commands.digest(payload) !== current.digest) throw new OidcIdentityError("actor_changed");
      });
    } else if (current.policy.fresh) {
      const input = { ...actor, ...current.policy, commandDigest: current.digest, now: clock() };
      const proof = await proofs.create(tx, input);
      if (!await proofs.consume(tx, { ...input, proofId: proof.id, now: clock() })) throw new OidcIdentityError("assurance_required");
    }
    current.authorized.add(tx);
  }
  return {
    run<T>(input: { actor: OidcActorBinding; payload: OidcPendingPayload; policy: OidcCommandPolicy; pendingId?: string }, execute: () => Promise<T>): Promise<T> {
      const payload = Object.freeze({ ...input.payload });
      const current: Context = { ...input, actor: { ...input.actor }, policy: { ...input.policy }, payload,
        digest: options.commands.digest(payload), issued: new Set(), authorized: new WeakSet() };
      return storage.run(current, async () => {
        const result = await execute();
        // A domain HTTP adapter may translate an unknown auth error to503. Retain
        // the reason across that boundary so the draft can be safely preserved.
        if (current.failure) throw current.failure;
        return result;
      });
    },
    authorize,
    async issueOwnerProof(input: Actor & { actionClass: string }): Promise<{ id: string }> {
      const current = context(input, input.actionClass);
      if (!input.actionClass.startsWith("owner.")) throw new OidcIdentityError("actor_changed");
      const id = randomUUID(); current.issued.add(id); return { id };
    },
    async consumeOwnerProof(tx: PawketTransaction, input: Actor & { actionClass: string; proofId: string }): Promise<boolean> {
      try {
        const current = context(input, input.actionClass);
        if (!current.issued.has(input.proofId)) return false;
        await authorize(tx, input); current.issued.delete(input.proofId); return true;
      } catch (error) { if (error instanceof OidcIdentityError) return false; throw error; }
    },
    async ready(tx: PawketTransaction, input: { actor: OidcActorBinding; payload: OidcPendingPayload; policy: OidcCommandPolicy }): Promise<boolean> {
      return valid(tx, { ...input, digest: options.commands.digest(input.payload), issued: new Set(), authorized: new WeakSet() });
    },
  };
}
