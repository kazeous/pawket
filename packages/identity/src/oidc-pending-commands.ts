import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { identityAccounts, identityOidcPendingCommands, identityOidcSessions, identitySessions, identityUsers,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { OidcIdentityError } from "./oidc-policy.js";
import { createOidcProofRepository, type OidcFreshness } from "./oidc-proofs.js";
import type { OidcSessionProvider } from "./oidc-session.js";
import { safeOidcReturnPath, type OidcActorBinding, type OidcTransaction } from "./oidc-transactions.js";

export type OidcPendingPayload = Readonly<{
  method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body: string;
  idempotencyKey: string | null; ifMatch: string | null; returnPath: string;
}>;
const binding = (id: string) => ({ recordType: "identity_oidc_pending_command", recordId: id, fieldName: "payload" });
const reviewPath = (id: string) => `/auth/review/${id}`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createOidcPendingCommandRepository(options: {
  db: PawketDatabase; keyring: EncryptionKeyring; fingerprintKey: Uint8Array; provider: OidcSessionProvider;
  now?: () => Date;
  /** Server-owned route registry returns an action; never accept an action supplied by a browser. */
  actionFor: (payload: OidcPendingPayload) => string | null;
  freshnessFor?: (payload: OidcPendingPayload) => OidcFreshness;
}) {
  const clock = options.now ?? (() => new Date());
  const proofs = createOidcProofRepository(options.provider, clock);
  const current = (at: Date) => {
    const result = new Date(Math.max(at.getTime(), clock().getTime()));
    if (!Number.isFinite(result.getTime())) throw new OidcIdentityError("invalid_response");
    return result;
  };
  function serialize(payload: OidcPendingPayload) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(payload.method) || !/^\/api\/v1\//u.test(payload.path) ||
      /[?#\\\u0000-\u0020\u007f]/u.test(payload.path) || /%(?![0-9a-f]{2})/iu.test(payload.path) ||
      /\/auth(?:\/|$)/u.test(payload.path) || typeof payload.body !== "string" || Buffer.byteLength(payload.body, "utf8") > 65_536 ||
      (payload.idempotencyKey !== null && !/^[A-Za-z0-9._-]{8,200}$/u.test(payload.idempotencyKey)) ||
      (payload.ifMatch !== null && !/^\d{1,12}$/u.test(payload.ifMatch))) throw new OidcIdentityError("invalid_response");
    const canonical = JSON.stringify({ method: payload.method, path: payload.path, body: payload.body,
      idempotencyKey: payload.idempotencyKey, ifMatch: payload.ifMatch, returnPath: safeOidcReturnPath(payload.returnPath) });
    if (Buffer.byteLength(canonical, "utf8") > 140_000) throw new OidcIdentityError("invalid_response");
    const actionClass = options.actionFor(payload);
    if (!actionClass || !/^[a-z][a-z0-9_.-]{2,63}$/u.test(actionClass)) throw new OidcIdentityError("invalid_response");
    return { canonical, actionClass, commandDigest: createLookupHmac({ value: createHash("sha256").update(canonical).digest("hex"), context: "oidc-command", key: options.fingerprintKey }) };
  }
  async function actorFence(tx: PawketTransaction, actor: OidcActorBinding, now: Date) {
    if (!Number.isFinite(now.getTime())) throw new OidcIdentityError("invalid_response");
    const [user] = await tx.select().from(identityUsers).where(eq(identityUsers.id, actor.userId)).for("share");
    const [session] = await tx.select().from(identitySessions).where(and(eq(identitySessions.id, actor.sessionId),
      eq(identitySessions.userId, actor.userId))).for("share");
    const [identity] = await tx.select({ subject: identityAccounts.accountId }).from(identityOidcSessions)
      .innerJoin(identityAccounts, eq(identityAccounts.id, identityOidcSessions.accountId)).where(and(
        eq(identityOidcSessions.sessionId, actor.sessionId), eq(identityOidcSessions.userId, actor.userId), eq(identityAccounts.userId, actor.userId),
        eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, options.provider.issuer),
        eq(identityOidcSessions.clientId, options.provider.clientId), eq(identityOidcSessions.providerRevision, options.provider.providerRevision),
      )).limit(1);
    // Expired lease may preserve a command for reauthentication, never authorize execution.
    now = current(now);
    if (!user || !session || identity?.subject !== actor.subject || user.accessStatus !== "active" || !user.emailVerified ||
      user.authorizationVersion !== actor.authorizationVersion || session.authorizationVersion !== actor.authorizationVersion ||
      session.revokedAt || session.assuranceState !== "active" || session.expiresAt <= now || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      throw new OidcIdentityError("actor_changed");
    }
    return { ...session, checkedAt: now };
  }
  async function locked(tx: PawketTransaction, id: string, actor: OidcActorBinding, now: Date) {
    if (!uuidPattern.test(id)) throw new OidcIdentityError("invalid_response");
    const session = await actorFence(tx, actor, now);
    const [command] = await tx.select().from(identityOidcPendingCommands).where(and(
      eq(identityOidcPendingCommands.id, id), eq(identityOidcPendingCommands.userId, actor.userId),
      eq(identityOidcPendingCommands.sessionId, actor.sessionId), eq(identityOidcPendingCommands.authorizationVersion, actor.authorizationVersion),
      isNull(identityOidcPendingCommands.consumedAt), gt(identityOidcPendingCommands.expiresAt, now),
    )).for("update");
    now = current(session.checkedAt);
    if (session.expiresAt <= now || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) throw new OidcIdentityError("actor_changed");
    if (!command?.payloadEnvelope || command.expiresAt <= now) throw new OidcIdentityError("transaction_expired");
    return command;
  }
  function decode(command: typeof identityOidcPendingCommands.$inferSelect): OidcPendingPayload {
    try {
      const payload = JSON.parse(decryptSensitiveField({ envelope: command.payloadEnvelope!, binding: binding(command.id), keyring: options.keyring, maximumPlaintextBytes: 140_000 })) as OidcPendingPayload;
      const checked = serialize(payload);
      if (checked.commandDigest !== command.commandDigest || checked.actionClass !== command.actionClass) throw new Error();
      return payload;
    } catch { throw new OidcIdentityError("invalid_response"); }
  }
  return {
    digest: (payload: OidcPendingPayload) => serialize(payload).commandDigest,
    async prepare(input: { actor: OidcActorBinding; payload: OidcPendingPayload; now: Date }) {
      const encoded = serialize(input.payload); const id = randomUUID();
      return options.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`oidc-pending:${input.actor.userId}`}, 0))`);
        const session = await actorFence(tx, input.actor, input.now);
        const [active] = await tx.select({ count: count() }).from(identityOidcPendingCommands).where(and(
          eq(identityOidcPendingCommands.userId, input.actor.userId), isNull(identityOidcPendingCommands.consumedAt),
          gt(identityOidcPendingCommands.expiresAt, session.checkedAt)));
        if ((active?.count ?? 0) >= 10) throw new OidcIdentityError("rate_limited");
        const expiresAt = new Date(Math.min(session.checkedAt.getTime() + 600_000, session.expiresAt.getTime(), session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()));
        await tx.insert(identityOidcPendingCommands).values({ id, actionClass: encoded.actionClass, commandDigest: encoded.commandDigest,
          userId: input.actor.userId, sessionId: input.actor.sessionId,
          authorizationVersion: input.actor.authorizationVersion, createdAt: session.checkedAt, expiresAt,
          payloadEnvelope: encryptSensitiveField({ plaintext: encoded.canonical, binding: binding(id), keyring: options.keyring, maximumPlaintextBytes: 140_000 }) });
        return { id, expiresAt, reviewPath: reviewPath(id) };
      });
    },
    async intent(input: { id: string; actor: OidcActorBinding; now: Date }) {
      return options.db.transaction(async (tx) => {
        const command = await locked(tx, input.id, input.actor, input.now); decode(command);
        return { intent: { purpose: "step_up" as const, actor: input.actor, actionClass: command.actionClass, commandDigest: command.commandDigest },
          returnPath: reviewPath(command.id) };
      });
    },
    /** Invoked atomically with the OIDC callback. This records readiness, never executes business work. */
    async completeStepUp(tx: PawketTransaction, input: { transaction: OidcTransaction; userId: string; sessionId: string; authorizationVersion: number; now: Date }) {
      const { transaction } = input;
      const id = transaction.returnPath.startsWith("/auth/review/") ? transaction.returnPath.slice("/auth/review/".length) : "";
      const command = await locked(tx, id, { userId: input.userId, sessionId: input.sessionId,
        authorizationVersion: input.authorizationVersion, subject: transaction.expectedSubject! }, input.now);
      if (command.commandDigest !== transaction.commandDigest || command.actionClass !== transaction.actionClass || command.createdAt > transaction.createdAt) {
        throw new OidcIdentityError("actor_changed");
      }
      const payload = decode(command);
      const proof = await proofs.create(tx, { ...input, ...options.freshnessFor?.(payload), actionClass: command.actionClass, commandDigest: command.commandDigest, deadline: command.expiresAt });
      await tx.update(identityOidcPendingCommands).set({ proofId: proof.id }).where(eq(identityOidcPendingCommands.id, id));
    },
    async review(input: { id: string; actor: OidcActorBinding; now: Date }) {
      return options.db.transaction(async (tx) => {
        const command = await locked(tx, input.id, input.actor, input.now);
        const ready = command.proofId !== null && await proofs.usable(tx, { ...input.actor, now: current(input.now),
          ...options.freshnessFor?.(decode(command)), proofId: command.proofId, actionClass: command.actionClass, commandDigest: command.commandDigest });
        return { payload: decode(command), expiresAt: command.expiresAt, ready };
      });
    },
    /** Call only after explicit user confirmation, in the same transaction as the domain mutation. */
    async consume<T>(tx: PawketTransaction, input: { id: string; actor: OidcActorBinding; now: Date },
      execute: (payload: OidcPendingPayload) => Promise<T>): Promise<T> {
      const command = await locked(tx, input.id, input.actor, input.now); const payload = decode(command);
      if (!command.proofId || !await proofs.consume(tx, { ...input.actor, now: input.now, proofId: command.proofId,
        ...options.freshnessFor?.(payload), actionClass: command.actionClass, commandDigest: command.commandDigest })) throw new OidcIdentityError("assurance_required");
      const result = await execute(payload);
      await tx.update(identityOidcPendingCommands).set({ consumedAt: input.now, payloadEnvelope: null }).where(eq(identityOidcPendingCommands.id, input.id));
      return result;
    },
    async cancel(input: { id: string; actor: OidcActorBinding; now: Date }) {
      await options.db.transaction(async (tx) => {
        const command = await locked(tx, input.id, input.actor, input.now);
        await tx.update(identityOidcPendingCommands).set({ consumedAt: input.now, payloadEnvelope: null }).where(eq(identityOidcPendingCommands.id, command.id));
      });
    },
  };
}
