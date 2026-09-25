import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, paymentIntents,
  paymentsReceivingAccountOnboarding, paymentsSepayConnections, paymentsSepayConnectionRevisions,
  paymentsSepayOAuthAttempts, paymentsSepayAccountCutovers, systemCommandIdempotency, type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { SePayProviderNotDispatchedError, type SePayProviderBinding, type SePayProviderPort } from "./sepay-provider.js";
import { lockTipReceivingDestination } from "./tip-receiving-account.js";
import { lockPaymentAccountFingerprints, retryPaymentAccountChange } from "./payment-account-fence.js";
import {
  createSePayCryptography, requireSePayAssurance, sepayBoundary, sepayFail, sepayUuid, sepayValidDate,
  validateSePayActor, validateSePayCommand, type SePayActor, type SePayAssurancePort,
} from "./sepay-service-support.js";

type Connection = typeof paymentsSepayConnections.$inferSelect;
type Revision = typeof paymentsSepayConnectionRevisions.$inferSelect;
type BaseCommand = { actor: SePayActor; idempotencyKey: string; requestId: string };
type VersionedCommand = BaseCommand & { connectionId: string; expectedVersion: number };
export type SePayConnectionView = Readonly<{
  id: string; version: number; status: string; bankName: string; maskedSuffix: string;
  automationEnabled: boolean; cutoverAt: string | null; webhookEndpoint: string;
  remoteRevocationStatus: string;
}>;
export type SePayConnectionSnapshot = Readonly<{
  available: boolean; blockReason: "payments_disabled" | "provider_contract_pending" | null;
  connection: SePayConnectionView | null;
}>;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  paymentsMode: "disabled" | "manual_only" | "sepay_optional";
  environment: "test" | "live"; appBaseUrl: string; redirectUri: string;
  applicationRevision: string; assurance: SePayAssurancePort; provider: SePayProviderPort;
  now?: () => Date;
}>;

export function createSePayConnectionService(input: Input) {
  const crypt = createSePayCryptography(input); const clock = input.now ?? (() => new Date());
  if (input.provider.environment !== input.environment || new URL(input.redirectUri).origin !== new URL(input.appBaseUrl).origin) sepayFail("invalid_request");
  const now = () => { const at = clock(); if (!sepayValidDate(at)) sepayFail("dependency_unavailable"); return at; };
  const providerReady = () => input.provider.capabilities.oauthApplication && input.provider.capabilities.pkceS256;
  const bindingReady = () => providerReady() && input.provider.capabilities.stableAccountIdentity && input.provider.capabilities.canonicalTransactionIdentity && input.provider.capabilities.bankTimeReference;
  const assertEnabled = () => { if (input.paymentsMode === "disabled") sepayFail("payments_disabled"); };
  const assertVersion = (command: VersionedCommand) => { validateSePayCommand(command); if (!sepayUuid(command.connectionId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) sepayFail("invalid_request"); };
  async function assurance(tx: PawketTransaction, actor: SePayActor, fresh = true) {
    validateSePayActor(actor); const at = now();
    return requireSePayAssurance(await input.assurance.getTipSessionAssurance(tx, actor, at), at, fresh);
  }
  async function current(tx: PawketTransaction, actor: SePayActor, connectionId: string) {
    const destination = await lockTipReceivingDestination(tx, actor.userId, now(), input);
    if (!destination) sepayFail("not_available");
    const [connection] = await tx.select().from(paymentsSepayConnections).where(and(eq(paymentsSepayConnections.id, connectionId), eq(paymentsSepayConnections.creatorUserId, actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment))).limit(1).for("update");
    if (!connection || connection.accountFingerprint !== destination.accountFingerprint || connection.accountVersionId !== destination.accountVersionId) sepayFail("not_available");
    return { connection, destination };
  }
  async function revision(tx: PawketTransaction, connection: Connection): Promise<Revision> {
    if (!connection.currentRevisionId) sepayFail("reconnect_required");
    const [row] = await tx.select().from(paymentsSepayConnectionRevisions).where(and(eq(paymentsSepayConnectionRevisions.id, connection.currentRevisionId), eq(paymentsSepayConnectionRevisions.connectionId, connection.id))).limit(1);
    if (!row) sepayFail("reconnect_required"); return row;
  }
  async function connectionForStop(tx: PawketTransaction, actor: SePayActor, connectionId: string) {
    const predicate = and(eq(paymentsSepayConnections.id, connectionId), eq(paymentsSepayConnections.creatorUserId, actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment));
    const [candidate] = await tx.select().from(paymentsSepayConnections).where(predicate).limit(1);
    if (!candidate) sepayFail("not_available");
    await lockPaymentAccountFingerprints(tx, [candidate.accountFingerprint]);
    const [connection] = await tx.select().from(paymentsSepayConnections).where(predicate).limit(1).for("update");
    if (!connection) sepayFail("not_available"); return { connection, destination: null };
  }
  async function audit(tx: PawketTransaction, actor: SePayActor, connectionId: string, action: string, requestId: string) {
    await appendAdminAuditEvent(tx, { actorUserId: actor.userId, actorSessionId: actor.sessionId, subjectType: "sepay_connection", subjectId: connectionId,
      action: `sepay.${action}`, outcome: "succeeded", assurance: { method: "current_creator_session" }, applicationRevision: input.applicationRevision, requestId, occurredAt: now() });
  }
  async function startCommand(tx: PawketTransaction, command: BaseCommand, scope: string, facts: unknown) {
    const at = now(); const started = await beginIdempotentCommand(tx, { actorUserId: command.actor.userId, commandScope: `payments.sepay_${scope}`,
      keyHash: crypt.hash("command-key", command.idempotencyKey), requestFingerprint: crypt.hash("command", JSON.stringify(facts)), now: at, expiresAt: new Date(at.getTime() + 86_400_000) });
    if (started.kind !== "acquired" && started.kind !== "replay") sepayFail("idempotency_conflict"); return started;
  }
  async function finishCommand(tx: PawketTransaction, recordId: string, connectionId: string) {
    if (!await completeIdempotentCommand(tx, { recordId, resultReference: `sepay-connection:${connectionId}`, completedAt: now() })) sepayFail("idempotency_conflict");
  }
  function sealRevision(connection: Connection, previous: Revision | null, values: {
    accessToken?: string; refreshToken?: string; expiresAt?: Date; scopes?: readonly string[];
    secret: string; binding?: SePayProviderBinding | null;
  }) {
    const id = randomUUID(); const at = now(); const binding = values.binding ?? null;
    return { id, connectionId: connection.id, revisionNumber: (previous?.revisionNumber ?? 0) + 1, tokenGeneration: (previous?.tokenGeneration ?? 0) + 1,
      accessTokenEnvelope: values.accessToken ? crypt.encrypt("sepay_connection_revision", id, "access_token", values.accessToken) : null,
      refreshTokenEnvelope: values.refreshToken ? crypt.encrypt("sepay_connection_revision", id, "refresh_token", values.refreshToken) : null,
      accessTokenExpiresAt: values.expiresAt ?? null, scopes: [...(values.scopes ?? [])],
      webhookSecretEnvelope: crypt.encrypt("sepay_connection_revision", id, "webhook_secret", values.secret),
      providerBindingEnvelope: binding ? crypt.encrypt("sepay_connection_revision", id, "provider_binding", JSON.stringify(binding)) : null,
      providerTenantId: binding?.tenantId ?? connection.providerTenantId, providerAccountId: binding?.accountId ?? connection.providerAccountId,
      capabilityEvidence: { ...input.provider.capabilities }, createdAt: at };
  }
  function plaintext(rev: Revision) {
    if (!rev.accessTokenEnvelope || !rev.refreshTokenEnvelope || !rev.accessTokenExpiresAt) sepayFail("reconnect_required");
    return { accessToken: crypt.decrypt("sepay_connection_revision", rev.id, "access_token", rev.accessTokenEnvelope),
      refreshToken: crypt.decrypt("sepay_connection_revision", rev.id, "refresh_token", rev.refreshTokenEnvelope), expiresAt: rev.accessTokenExpiresAt,
      scopes: rev.scopes, secret: crypt.decrypt("sepay_connection_revision", rev.id, "webhook_secret", rev.webhookSecretEnvelope),
      binding: rev.providerBindingEnvelope ? JSON.parse(crypt.decrypt("sepay_connection_revision", rev.id, "provider_binding", rev.providerBindingEnvelope)) as SePayProviderBinding : null };
  }
  async function view(tx: PawketTransaction, connection: Connection): Promise<SePayConnectionView> {
    const [account] = await tx.select({ bankName: paymentsReceivingAccountOnboarding.bankName, maskedSuffix: paymentsReceivingAccountOnboarding.maskedSuffix }).from(paymentsReceivingAccountOnboarding).where(eq(paymentsReceivingAccountOnboarding.id, connection.accountVersionId)).limit(1);
    const [cutover] = await tx.select({ at: paymentsSepayAccountCutovers.cutoverAt }).from(paymentsSepayAccountCutovers).where(eq(paymentsSepayAccountCutovers.accountFingerprint, connection.accountFingerprint)).limit(1);
    if (!account) sepayFail("dependency_unavailable");
    return { id: connection.id, version: connection.version, status: connection.status, ...account, automationEnabled: connection.automationEnabled,
      cutoverAt: cutover?.at.toISOString() ?? null, webhookEndpoint: new URL(`/api/v1/webhooks/sepay/${connection.id}`, input.appBaseUrl).href, remoteRevocationStatus: connection.remoteRevocationStatus };
  }
  async function access(connectionId: string) {
    assertEnabled(); if (!providerReady() || !sepayUuid(connectionId)) sepayFail("provider_unavailable");
    const leaseOwner = randomUUID();
    const prepared = await input.db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(paymentsSepayConnections).where(and(eq(paymentsSepayConnections.id, connectionId), eq(paymentsSepayConnections.providerEnvironment, input.environment))).limit(1);
      if (!candidate) sepayFail("not_available");
      await lockPaymentAccountFingerprints(tx, [candidate.accountFingerprint]);
      const [connection] = await tx.select().from(paymentsSepayConnections).where(eq(paymentsSepayConnections.id, connectionId)).limit(1).for("update");
      if (!connection || !["ready", "setup_pending"].includes(connection.status)) sepayFail("reconnect_required");
      const rev = await revision(tx, connection); const grant = plaintext(rev); const at = now();
      if (connection.refreshLeaseOwner) {
        if (connection.refreshLeaseExpiresAt && connection.refreshLeaseExpiresAt > at) sepayFail("provider_unavailable", Math.max(1, Math.ceil((connection.refreshLeaseExpiresAt.getTime() - at.getTime()) / 1000)));
        // The preceding refresh may have spent its token before its worker died.
        await tx.update(paymentsSepayConnections).set({ status: "reconnect_required", version: connection.version + 1,
          refreshLeaseOwner: null, refreshLeaseExpiresAt: null, updatedAt: at }).where(eq(paymentsSepayConnections.id, connectionId));
        return { kind: "uncertain" as const };
      }
      if (grant.expiresAt.getTime() > at.getTime() + 30_000) return { kind: "ready" as const, connection, rev, grant };
      await tx.update(paymentsSepayConnections).set({ refreshLeaseOwner: leaseOwner, refreshLeaseExpiresAt: new Date(at.getTime() + 30_000), updatedAt: at }).where(eq(paymentsSepayConnections.id, connectionId));
      return { kind: "refresh" as const, connection, rev, grant };
    });
    if (prepared.kind === "uncertain") sepayFail("reconnect_required");
    if (prepared.kind === "ready") return prepared;
    try {
      const renewed = await input.provider.refresh({ refreshToken: prepared.grant.refreshToken });
      return await input.db.transaction(async (tx) => {
        await lockPaymentAccountFingerprints(tx, [prepared.connection.accountFingerprint]);
        const [connection] = await tx.select().from(paymentsSepayConnections).where(eq(paymentsSepayConnections.id, connectionId)).limit(1).for("update");
        const at = now();
        if (!connection || connection.version !== prepared.connection.version || connection.currentRevisionId !== prepared.rev.id ||
          connection.refreshLeaseOwner !== leaseOwner || !connection.refreshLeaseExpiresAt || connection.refreshLeaseExpiresAt <= at || !["ready", "setup_pending"].includes(connection.status)) sepayFail("version_conflict");
        if (!sepayValidDate(renewed.expiresAt) || renewed.expiresAt <= at || renewed.scopes.length !== 2 || !renewed.scopes.includes("transaction:read") || !renewed.scopes.includes("bank-account:read")) sepayFail("provider_unavailable");
        const next = sealRevision(connection, prepared.rev, { ...renewed, secret: prepared.grant.secret, binding: prepared.grant.binding });
        await tx.insert(paymentsSepayConnectionRevisions).values(next);
        const [changed] = await tx.update(paymentsSepayConnections).set({ currentRevisionId: next.id, version: connection.version + 1,
          refreshLeaseOwner: null, refreshLeaseExpiresAt: null, updatedAt: at }).where(eq(paymentsSepayConnections.id, connectionId)).returning();
        if (!changed) sepayFail("dependency_unavailable");
        return { kind: "ready" as const, connection: changed, rev: next, grant: { ...prepared.grant, ...renewed } };
      });
    } catch (error) {
      await input.db.transaction(async (tx) => {
        await lockPaymentAccountFingerprints(tx, [prepared.connection.accountFingerprint]);
        if (error instanceof SePayProviderNotDispatchedError) {
          await tx.update(paymentsSepayConnections).set({ refreshLeaseOwner: null, refreshLeaseExpiresAt: null, updatedAt: now() })
            .where(and(eq(paymentsSepayConnections.id, connectionId), eq(paymentsSepayConnections.refreshLeaseOwner, leaseOwner)));
          return;
        }
        // A pause can advance the version while this exact grant is in flight.
        // Keep the lease as its identity fence; a new OAuth start/disconnect clears it.
        await tx.update(paymentsSepayConnections).set({ status: "reconnect_required", version: sql`${paymentsSepayConnections.version} + 1`,
          refreshLeaseOwner: null, refreshLeaseExpiresAt: null, updatedAt: now() }).where(and(eq(paymentsSepayConnections.id, connectionId), eq(paymentsSepayConnections.refreshLeaseOwner, leaseOwner)));
      });
      if (error instanceof SePayProviderNotDispatchedError) throw error;
      sepayFail("reconnect_required");
    }
  }
  return {
    getReadbackAccess: access,
    async listAccounts(command: { actor: SePayActor; connectionId: string }) {
      assertEnabled(); validateSePayActor(command.actor); if (!sepayUuid(command.connectionId) || !providerReady()) sepayFail("provider_unavailable");
      const candidate = await input.db.transaction(async (tx) => {
        await assurance(tx, command.actor, false);
        const { connection } = await current(tx, command.actor, command.connectionId);
        if (connection.status !== "setup_pending") sepayFail("not_available");
        const rev = await revision(tx, connection); const grant = plaintext(rev);
        // GET discovery reads an existing grant. It never renews or changes it.
        if (grant.expiresAt <= now()) sepayFail("reconnect_required");
        if (connection.refreshLeaseOwner) sepayFail("provider_unavailable", 30);
        return { connection, rev, grant };
      });
      const grant = candidate;
      const discovered = await input.provider.discoverAccounts({ accessToken: grant.grant.accessToken });
      if (discovered.kind !== "complete") sepayFail("provider_unavailable");
      return input.db.transaction(async (tx) => {
        await assurance(tx, command.actor, false); const { connection, destination } = await current(tx, command.actor, command.connectionId);
        if (connection.version !== grant.connection.version || connection.currentRevisionId !== grant.rev.id || connection.status !== "setup_pending") sepayFail("version_conflict");
        return { connectionVersion: connection.version, accounts: discovered.accounts.slice(0, 100).map((account) => ({
          accountId: account.accountId, bankName: account.bankGateway, maskedSuffix: `•••• ${(account.subAccount ?? account.accountNumber).slice(-4)}`,
          eligible: Boolean(account.active && account.binding && bindingReady() && account.binding.environment === input.environment &&
            account.binding.bankBin === destination.bankBin && (account.binding.subAccount ?? account.binding.accountNumber) === destination.accountNumber &&
            (connection.providerTenantId === null || (connection.providerTenantId === account.binding.tenantId && connection.providerAccountId === account.binding.accountId))),
        })) };
      });
    },
    async getSnapshot(actor: SePayActor): Promise<SePayConnectionSnapshot> {
      return sepayBoundary(() => retryPaymentAccountChange(() => input.db.transaction(async (tx) => {
        await assurance(tx, actor, false);
        const [connection] = await tx.select().from(paymentsSepayConnections).where(and(eq(paymentsSepayConnections.creatorUserId, actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment))).orderBy(desc(paymentsSepayConnections.updatedAt)).limit(1);
        return { available: input.paymentsMode === "sepay_optional" && bindingReady(), blockReason: input.paymentsMode === "disabled" ? "payments_disabled" : !bindingReady() ? "provider_contract_pending" : null,
          connection: connection ? await view(tx, connection) : null };
      })));
    },
    async start(command: BaseCommand): Promise<{ authorizationUrl: string | null; restartRequired: boolean }> {
      assertEnabled(); validateSePayCommand(command); if (!providerReady()) sepayFail("provider_unavailable");
      return sepayBoundary(() => input.db.transaction(async (tx) => {
        const started = await startCommand(tx, command, "oauth_start", [command.actor.userId, command.actor.sessionId]);
        await assurance(tx, command.actor);
        if (started.kind === "replay") return { authorizationUrl: null, restartRequired: true };
        const destination = await lockTipReceivingDestination(tx, command.actor.userId, now(), input); if (!destination) sepayFail("not_available");
        const [active] = await tx.select().from(paymentsSepayConnections).where(and(eq(paymentsSepayConnections.creatorUserId, command.actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment), ne(paymentsSepayConnections.status, "disconnected"))).limit(1).for("update");
        if (active && active.accountFingerprint !== destination.accountFingerprint) sepayFail("account_conflict");
        let [connection] = await tx.select().from(paymentsSepayConnections).where(and(eq(paymentsSepayConnections.creatorUserId, command.actor.userId), eq(paymentsSepayConnections.providerEnvironment, input.environment), eq(paymentsSepayConnections.accountFingerprint, destination.accountFingerprint))).limit(1).for("update");
        const at = now();
        if (!connection) [connection] = await tx.insert(paymentsSepayConnections).values({ id: randomUUID(), creatorUserId: command.actor.userId, accountVersionId: destination.accountVersionId,
          accountFingerprint: destination.accountFingerprint, providerEnvironment: input.environment, status: "setup_pending", createdAt: at, updatedAt: at }).returning();
        if (!connection) sepayFail("dependency_unavailable");
        const previous = connection.currentRevisionId ? await revision(tx, connection) : null;
        const next = sealRevision(connection, previous, { secret: randomBytes(32).toString("base64url") });
        await tx.insert(paymentsSepayConnectionRevisions).values(next);
        const version = connection.version + 1;
        await tx.update(paymentsSepayConnections).set({ currentRevisionId: next.id, accountVersionId: destination.accountVersionId, status: "setup_pending", version,
          refreshLeaseOwner: null, refreshLeaseExpiresAt: null, remoteRevocationStatus: "not_requested", updatedAt: at }).where(eq(paymentsSepayConnections.id, connection.id));
        const state = randomBytes(32).toString("base64url"); const verifier = randomBytes(32).toString("base64url"); const attemptId = randomUUID();
        await tx.insert(paymentsSepayOAuthAttempts).values({ id: attemptId, connectionId: connection.id, stateHash: crypt.hash("oauth-state", state), actorUserId: command.actor.userId,
          actorSessionId: command.actor.sessionId, providerEnvironment: input.environment, redirectUri: input.redirectUri,
          codeVerifierEnvelope: crypt.encrypt("sepay_oauth_attempt", attemptId, "code_verifier", verifier), expectedConnectionVersion: version,
          createdAt: at, expiresAt: new Date(at.getTime() + 600_000) });
        await audit(tx, command.actor, connection.id, "oauth_started", command.requestId); await finishCommand(tx, started.recordId, connection.id);
        return { authorizationUrl: input.provider.authorizationUrl({ state, codeChallenge: createHash("sha256").update(verifier).digest("base64url") }), restartRequired: false };
      }));
    },
    async callback(command: { actor: SePayActor; state: string; code: string; requestId: string }): Promise<void> {
      assertEnabled(); validateSePayActor(command.actor);
      if (!providerReady()) sepayFail("provider_unavailable");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(command.state) || typeof command.code !== "string" || command.code.length < 1 || command.code.length > 4096 || /[\u0000-\u0020\u007f]/u.test(command.code)) sepayFail("invalid_request");
      // Consume before network exchange. A lost response must restart, never replay a code.
      const attempt = await sepayBoundary(() => input.db.transaction(async (tx) => {
        await assurance(tx, command.actor);
        const [candidate] = await tx.select().from(paymentsSepayOAuthAttempts).where(eq(paymentsSepayOAuthAttempts.stateHash, crypt.hash("oauth-state", command.state))).limit(1);
        if (!candidate || candidate.actorUserId !== command.actor.userId || candidate.actorSessionId !== command.actor.sessionId || candidate.providerEnvironment !== input.environment || candidate.redirectUri !== input.redirectUri) sepayFail("not_authorized");
        const { connection } = await current(tx, command.actor, candidate.connectionId);
        if (connection.version !== candidate.expectedConnectionVersion || connection.status !== "setup_pending") sepayFail("version_conflict");
        const [taken] = await tx.update(paymentsSepayOAuthAttempts).set({ status: "exchanging", consumedAt: now() }).where(and(eq(paymentsSepayOAuthAttempts.id, candidate.id), eq(paymentsSepayOAuthAttempts.status, "pending"), sql`${paymentsSepayOAuthAttempts.expiresAt} > ${now().toISOString()}::timestamptz`)).returning();
        if (!taken) sepayFail("not_authorized"); return taken;
      }));
      try {
        const grant = await input.provider.exchange({ code: command.code, codeVerifier: crypt.decrypt("sepay_oauth_attempt", attempt.id, "code_verifier", attempt.codeVerifierEnvelope) });
        await input.db.transaction(async (tx) => {
          await assurance(tx, command.actor);
          const { connection } = await current(tx, command.actor, attempt.connectionId);
          if (connection.version !== attempt.expectedConnectionVersion || connection.status !== "setup_pending") sepayFail("version_conflict");
          const previous = await revision(tx, connection); const at = now();
          if (!sepayValidDate(grant.expiresAt) || grant.expiresAt <= at || grant.scopes.length !== 2 || !grant.scopes.includes("transaction:read") || !grant.scopes.includes("bank-account:read")) sepayFail("provider_unavailable");
          const next = sealRevision(connection, previous, { ...grant, secret: crypt.decrypt("sepay_connection_revision", previous.id, "webhook_secret", previous.webhookSecretEnvelope) });
          await tx.insert(paymentsSepayConnectionRevisions).values(next);
          await tx.update(paymentsSepayConnections).set({ currentRevisionId: next.id, version: connection.version + 1, updatedAt: at }).where(eq(paymentsSepayConnections.id, connection.id));
          await tx.update(paymentsSepayOAuthAttempts).set({ status: "completed" }).where(and(eq(paymentsSepayOAuthAttempts.id, attempt.id), eq(paymentsSepayOAuthAttempts.status, "exchanging")));
          await audit(tx, command.actor, connection.id, "oauth_completed", command.requestId);
        });
      } catch {
        await input.db.transaction(async (tx) => {
          // Match current()/start() ordering before locking the connection row.
          const [candidate] = await tx.select({ fingerprint: paymentsSepayConnections.accountFingerprint }).from(paymentsSepayConnections).where(eq(paymentsSepayConnections.id, attempt.connectionId)).limit(1);
          if (candidate) await lockPaymentAccountFingerprints(tx, [candidate.fingerprint]);
          await tx.update(paymentsSepayOAuthAttempts).set({ status: "failed" }).where(and(eq(paymentsSepayOAuthAttempts.id, attempt.id), eq(paymentsSepayOAuthAttempts.status, "exchanging")));
          await tx.update(paymentsSepayConnections).set({ status: "reconnect_required", version: sql`${paymentsSepayConnections.version} + 1`, updatedAt: now() }).where(and(eq(paymentsSepayConnections.id, attempt.connectionId), eq(paymentsSepayConnections.version, attempt.expectedConnectionVersion)));
        });
        sepayFail("reconnect_required");
      }
    },
    async bindAccount(command: VersionedCommand & { providerAccountId: string }): Promise<{ connection: SePayConnectionView; webhookSecret: string | null }> {
      assertEnabled(); assertVersion(command); if (!bindingReady()) sepayFail("provider_unavailable");
      const candidate = await input.db.transaction(async (tx) => {
        await assurance(tx, command.actor); const { connection } = await current(tx, command.actor, command.connectionId);
        const [replay] = await tx.select().from(systemCommandIdempotency).where(and(eq(systemCommandIdempotency.actorUserId, command.actor.userId),
          eq(systemCommandIdempotency.commandScope, "payments.sepay_bind"), eq(systemCommandIdempotency.keyHash, crypt.hash("command-key", command.idempotencyKey)))).limit(1);
        if (replay) {
          if (replay.status !== "completed" || replay.expiresAt <= now() || replay.requestFingerprint !== crypt.hash("command", JSON.stringify([command.connectionId, command.expectedVersion, command.providerAccountId])) || replay.resultReference !== `sepay-connection:${connection.id}`) sepayFail("idempotency_conflict");
          return { replay: true as const, connection: await view(tx, connection) };
        }
        if (connection.version !== command.expectedVersion || connection.status !== "setup_pending") sepayFail("version_conflict");
        if (connection.refreshLeaseOwner) sepayFail("provider_unavailable", 30);
        const rev = await revision(tx, connection); return { replay: false as const, connection, rev, grant: plaintext(rev) };
      });
      if (candidate.replay) return { connection: candidate.connection, webhookSecret: null };
      if (candidate.grant.expiresAt <= now()) sepayFail("reconnect_required");
      const accounts = await input.provider.discoverAccounts({ accessToken: candidate.grant.accessToken });
      if (accounts.kind !== "complete") sepayFail("provider_unavailable");
      const account = accounts.accounts.find((item) => item.accountId === command.providerAccountId);
      if (!account?.binding || !account.active) sepayFail("evidence_mismatch");
      const binding = account.binding;
      return sepayBoundary(() => input.db.transaction(async (tx) => {
        const started = await startCommand(tx, command, "bind", [command.connectionId, command.expectedVersion, command.providerAccountId]);
        await assurance(tx, command.actor); const { connection, destination } = await current(tx, command.actor, command.connectionId);
        if (started.kind === "replay") return { connection: await view(tx, connection), webhookSecret: null };
        if (connection.version !== candidate.connection.version || connection.currentRevisionId !== candidate.rev.id || connection.status !== "setup_pending" || connection.refreshLeaseOwner) sepayFail("version_conflict");
        if (binding.environment !== input.environment || binding.bankBin !== destination.bankBin || (binding.subAccount ?? binding.accountNumber) !== destination.accountNumber ||
          (connection.providerTenantId !== null && (connection.providerTenantId !== binding.tenantId || connection.providerAccountId !== binding.accountId))) sepayFail("evidence_mismatch");
        const next = sealRevision(connection, candidate.rev, { ...candidate.grant, binding, secret: randomBytes(32).toString("base64url") });
        await tx.insert(paymentsSepayConnectionRevisions).values(next);
        const [changed] = await tx.update(paymentsSepayConnections).set({ providerTenantId: binding.tenantId, providerAccountId: binding.accountId, currentRevisionId: next.id,
          status: "ready", version: connection.version + 1, updatedAt: now() }).where(eq(paymentsSepayConnections.id, connection.id)).returning();
        if (!changed) sepayFail("dependency_unavailable");
        await audit(tx, command.actor, connection.id, "account_bound", command.requestId); await finishCommand(tx, started.recordId, connection.id);
        return { connection: await view(tx, changed), webhookSecret: crypt.decrypt("sepay_connection_revision", next.id, "webhook_secret", next.webhookSecretEnvelope) };
      }));
    },
    async change(command: VersionedCommand & { action: "pause" | "resume" | "disconnect" | "enable_automation" | "rotate_secret" }): Promise<{ connection: SePayConnectionView; webhookSecret: string | null }> {
      assertEnabled(); assertVersion(command);
      return sepayBoundary(() => input.db.transaction(async (tx) => {
        const started = await startCommand(tx, command, command.action, [command.connectionId, command.expectedVersion, command.action]);
        const proof = await assurance(tx, command.actor);
        const { connection, destination } = await (["pause", "disconnect"].includes(command.action)
          ? connectionForStop(tx, command.actor, command.connectionId) : current(tx, command.actor, command.connectionId));
        if (started.kind === "replay") return { connection: await view(tx, connection), webhookSecret: null };
        if (connection.version !== command.expectedVersion) sepayFail("version_conflict");
        const patch: Partial<typeof paymentsSepayConnections.$inferInsert> = { version: connection.version + 1, updatedAt: now() };
        let webhookSecret: string | null = null;
        if (command.action === "disconnect") { patch.status = "disconnected"; patch.remoteRevocationStatus = "unknown"; patch.refreshLeaseOwner = null; patch.refreshLeaseExpiresAt = null; }
        else if (command.action === "pause") { if (connection.status !== "ready") sepayFail("not_available"); patch.status = "paused"; }
        else {
          if (!destination) sepayFail("not_available");
          // Never copy or resume credentials whose refresh outcome is outstanding.
          if (connection.refreshLeaseOwner) sepayFail(connection.refreshLeaseExpiresAt && connection.refreshLeaseExpiresAt > now() ? "provider_unavailable" : "reconnect_required", 30);
          if (!bindingReady()) sepayFail("provider_unavailable");
          const rev = await revision(tx, connection); const grant = plaintext(rev);
          if (!grant.binding || grant.expiresAt <= now() || !["ready", "paused"].includes(connection.status)) sepayFail("reconnect_required");
          if (command.action === "resume") patch.status = "ready";
          else if (command.action === "rotate_secret") {
            webhookSecret = randomBytes(32).toString("base64url"); const next = sealRevision(connection, rev, { ...grant, secret: webhookSecret });
            await tx.insert(paymentsSepayConnectionRevisions).values(next); patch.currentRevisionId = next.id;
          } else if (command.action === "enable_automation") {
            if (input.paymentsMode !== "sepay_optional" || connection.status !== "ready") sepayFail("not_available");
            const [other] = await tx.select({ id: paymentsReceivingAccountOnboarding.id }).from(paymentsReceivingAccountOnboarding).where(and(eq(paymentsReceivingAccountOnboarding.accountFingerprint, destination.accountFingerprint), ne(paymentsReceivingAccountOnboarding.applicantUserId, command.actor.userId), isNull(paymentsReceivingAccountOnboarding.retiredAt))).limit(1);
            if (other) sepayFail("account_conflict");
            const [pending] = await tx.select({ id: paymentIntents.id }).from(paymentIntents).innerJoin(paymentsReceivingAccountOnboarding, eq(paymentIntents.accountVersionId, paymentsReceivingAccountOnboarding.id))
              .where(and(eq(paymentsReceivingAccountOnboarding.accountFingerprint, destination.accountFingerprint), eq(paymentIntents.settlementLane, "manual_attested"), eq(paymentIntents.state, "awaiting_transfer"))).limit(1);
            if (pending) sepayFail("open_manual_intents");
            const [cutover] = await tx.select().from(paymentsSepayAccountCutovers).where(eq(paymentsSepayAccountCutovers.accountFingerprint, destination.accountFingerprint)).limit(1);
            if (cutover && (cutover.connectionId !== connection.id || cutover.creatorUserId !== command.actor.userId || cutover.providerTenantId !== connection.providerTenantId || cutover.providerAccountId !== connection.providerAccountId)) sepayFail("account_conflict");
            if (!cutover) await tx.insert(paymentsSepayAccountCutovers).values({ id: randomUUID(), accountFingerprint: destination.accountFingerprint, creatorUserId: command.actor.userId,
              connectionId: connection.id, providerEnvironment: input.environment, providerTenantId: grant.binding.tenantId, providerAccountId: grant.binding.accountId,
              actorSessionId: command.actor.sessionId, primaryAuthenticatedAt: proof.primaryAuthenticatedAt, totpVerifiedAt: proof.totpEnrolled ? proof.totpVerifiedAt : null, cutoverAt: now() });
            patch.automationEnabled = true;
          } else sepayFail("invalid_request");
        }
        const [changed] = await tx.update(paymentsSepayConnections).set(patch).where(eq(paymentsSepayConnections.id, connection.id)).returning();
        if (!changed) sepayFail("dependency_unavailable");
        await audit(tx, command.actor, connection.id, command.action, command.requestId); await finishCommand(tx, started.recordId, connection.id);
        return { connection: await view(tx, changed), webhookSecret };
      }));
    },
  };
}
