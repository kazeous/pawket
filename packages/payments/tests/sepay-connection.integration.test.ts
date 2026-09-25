import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createSePayConnectionService } from "../src/sepay-connection-service.js";
import { SePayProviderError } from "../src/sepay-provider.js";
import { createSePayBudgetedProvider } from "../src/sepay-provider-budget.js";
import { commandIds, createSePayIntegrationFixture, deferred, fixtureAt, schema } from "./sepay-integration-fixture.js";

const fixture = createSePayIntegrationFixture("connection");
beforeAll(fixture.initialize, 30_000);
afterAll(fixture.dispose, 30_000);

describe("SePay connection and OAuth lifecycle with real persistence", () => {
  test("binds hashed one-time state and PKCE to the initiating actor/session without exposing grants", async () => {
    const creator = await fixture.creator();
    const state = await creator.start();
    const [attempt] = await fixture.db.select().from(schema.paymentsSepayOAuthAttempts).where(eq(schema.paymentsSepayOAuthAttempts.actorUserId, creator.actor.userId));
    expect(attempt).toMatchObject({ actorUserId: creator.actor.userId, actorSessionId: creator.actor.sessionId, status: "pending", providerEnvironment: "test" });
    expect(JSON.stringify(attempt)).not.toContain(state);
    await expect(creator.connections.callback({ actor: { ...creator.actor, sessionId: "different-session" }, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "not_authorized" });
    expect(creator.provider.exchange).not.toHaveBeenCalled();
    expect((await fixture.db.select().from(schema.paymentsSepayOAuthAttempts).where(eq(schema.paymentsSepayOAuthAttempts.id, attempt!.id)))[0]?.status).toBe("pending");

    await creator.connections.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() });
    const exchange = creator.provider.exchange.mock.calls[0]![0];
    expect(createHash("sha256").update(exchange.codeVerifier).digest("base64url")).toBe(creator.provider.authorizationUrl.mock.calls[0]![0].codeChallenge);
    expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(creator.connections.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "version_conflict" });
    expect(creator.provider.exchange).toHaveBeenCalledTimes(1);
    const revisions = await fixture.db.select().from(schema.paymentsSepayConnectionRevisions).where(eq(schema.paymentsSepayConnectionRevisions.connectionId, attempt!.connectionId));
    expect(JSON.stringify(revisions)).not.toMatch(/synthetic-access|synthetic-refresh/);
    expect(JSON.stringify(await creator.connections.getSnapshot(creator.actor))).not.toMatch(/synthetic-access|synthetic-refresh|accessToken|refreshToken/);
  });

  test("OAuth start replay requires a restart instead of repeating an unrecoverable state secret", async () => {
    const creator = await fixture.creator(); const command = { actor: creator.actor, ...commandIds() };
    const first = await creator.connections.start(command);
    expect(first.authorizationUrl).toBeTruthy();
    expect(await creator.connections.start(command)).toEqual({ authorizationUrl: null, restartRequired: true });
    expect(creator.provider.authorizationUrl).toHaveBeenCalledTimes(1);
    expect(await fixture.db.select().from(schema.paymentsSepayOAuthAttempts).where(eq(schema.paymentsSepayOAuthAttempts.actorUserId, creator.actor.userId))).toHaveLength(1);
  });

  test("a callback cannot switch environment or registered redirect, and expiry leaves the code unused", async () => {
    const creator = await fixture.creator(); const state = await creator.start();
    const alternative = createSePayConnectionService({ ...creator.connectionInput,
      redirectUri: "https://pawket.example.invalid/another-callback" });
    await expect(alternative.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "not_authorized" });
    const otherEnvironment = createSePayConnectionService({ ...creator.connectionInput, environment: "live", provider: { ...creator.provider, environment: "live" } });
    await expect(otherEnvironment.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "not_authorized" });
    creator.advance(600_000);
    await expect(creator.connections.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "not_authorized" });
    expect(creator.provider.exchange).not.toHaveBeenCalled();
  });

  test("rejects stale primary authentication and requires TOTP only when enrolled", async () => {
    const creator = await fixture.creator();
    creator.assurance.getTipSessionAssurance.mockImplementation(async (_tx, _actor, at) => ({ primaryAuthenticatedAt: new Date(at.getTime() - 900_001),
      totpEnrolled: false, totpVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 3_600_000) }));
    await expect(creator.start()).rejects.toMatchObject({ code: "recent_auth_required" });
    creator.assurance.getTipSessionAssurance.mockImplementation(async (_tx, _actor, at) => ({ primaryAuthenticatedAt: at,
      totpEnrolled: true, totpVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 3_600_000) }));
    await expect(creator.start()).rejects.toMatchObject({ code: "totp_required" });
    creator.assurance.getTipSessionAssurance.mockImplementation(async (_tx, _actor, at) => ({ primaryAuthenticatedAt: at,
      totpEnrolled: true, totpVerifiedAt: at, sessionExpiresAt: new Date(at.getTime() + 3_600_000) }));
    expect(await creator.start()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("revoking the session while exchange is in flight cannot install returned credentials", async () => {
    const creator = await fixture.creator(); const state = await creator.start();
    const entered = deferred<void>(); const response = deferred<Awaited<ReturnType<typeof creator.provider.exchange>>>();
    creator.provider.exchange.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const result = creator.connections.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() });
    const observed = expect(result).rejects.toMatchObject({ code: "reconnect_required" });
    await entered.promise;
    creator.assurance.getTipSessionAssurance.mockResolvedValue(null);
    response.resolve({ accessToken: "revoked-session-access", refreshToken: "revoked-session-refresh", expiresAt: new Date(creator.now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
    await observed;
    const row = await creator.current();
    expect(row.status).toBe("reconnect_required");
    const revisions = await fixture.db.select().from(schema.paymentsSepayConnectionRevisions).where(eq(schema.paymentsSepayConnectionRevisions.connectionId, row.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.accessTokenEnvelope).toBeNull();
    expect((await fixture.db.select().from(schema.paymentsSepayOAuthAttempts).where(eq(schema.paymentsSepayOAuthAttempts.connectionId, row.id)))[0]?.status).toBe("failed");
  });

  test("a lost exchange response consumes the code exactly once and requires reconnect", async () => {
    const creator = await fixture.creator(); const state = await creator.start();
    creator.provider.exchange.mockRejectedValue(new SePayProviderError("grant_outcome_unknown"));
    await expect(creator.connections.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "reconnect_required" });
    await expect(creator.connections.callback({ actor: creator.actor, state, code: "synthetic-code", requestId: randomUUID() })).rejects.toMatchObject({ code: "version_conflict" });
    expect(creator.provider.exchange).toHaveBeenCalledTimes(1);
    expect((await creator.current()).status).toBe("reconnect_required");
  });

  test("replays binding without revealing the webhook secret again or calling discovery again", async () => {
    const creator = await fixture.creator(); const row = await creator.authorize();
    const command = { actor: creator.actor, connectionId: row.id, expectedVersion: row.version, providerAccountId: creator.binding.accountId, ...commandIds() };
    const first = await creator.connections.bindAccount(command);
    expect(first.webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.connection.status).toBe("ready");
    expect(await creator.connections.bindAccount(command)).toMatchObject({ connection: { id: row.id, status: "ready" }, webhookSecret: null });
    expect(creator.provider.discoverAccounts).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await creator.connections.getSnapshot(creator.actor))).not.toContain(first.webhookSecret!);
  });

  test("rejects a different receiving account even when the grant can read it", async () => {
    const creator = await fixture.creator(); const row = await creator.authorize();
    creator.provider.discoverAccounts.mockResolvedValue({ kind: "complete", accounts: [{ ...creator.binding, accountNumber: "999999999999", active: true,
      binding: { ...creator.binding, accountNumber: "999999999999" } }] });
    await expect(creator.connections.bindAccount({ actor: creator.actor, connectionId: row.id, expectedVersion: row.version, providerAccountId: creator.binding.accountId, ...commandIds() })).rejects.toMatchObject({ code: "evidence_mismatch" });
    expect((await creator.current()).status).toBe("setup_pending");
  });

  test("serializes rotating refresh credentials without blocking a second caller on provider I/O", async () => {
    const creator = await fixture.creator(); await creator.connect(); creator.advance(3_580_000);
    const entered = deferred<void>(); const response = deferred<Awaited<ReturnType<typeof creator.provider.refresh>>>();
    creator.provider.refresh.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const row = await creator.current(); const first = creator.connections.getReadbackAccess(row.id);
    await entered.promise;
    await expect(creator.connections.getReadbackAccess(row.id)).rejects.toMatchObject({ code: "provider_unavailable" });
    response.resolve({ accessToken: "fresh-access", refreshToken: "rotated-refresh", expiresAt: new Date(creator.now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
    const access = await first;
    expect(access.grant.accessToken).toBe("fresh-access");
    expect(access.connection.version).toBe(row.version + 1);
    expect(access.connection.refreshLeaseOwner).toBeNull();
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);
    expect((await creator.connections.getReadbackAccess(row.id)).rev.id).toBe(access.rev.id);
  });

  test("unknown refresh outcome and expired refresh lease require reconnect without reuse of the old token", async () => {
    const creator = await fixture.creator(); await creator.connect(); creator.advance(3_580_000);
    creator.provider.refresh.mockRejectedValue(new SePayProviderError("grant_outcome_unknown"));
    const row = await creator.current();
    await expect(creator.connections.getReadbackAccess(row.id)).rejects.toMatchObject({ code: "reconnect_required" });
    await expect(creator.connections.getReadbackAccess(row.id)).rejects.toMatchObject({ code: "reconnect_required" });
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);

    const abandoned = await fixture.creator(); await abandoned.connect(); const old = await abandoned.current();
    await fixture.db.update(schema.paymentsSepayConnections).set({ refreshLeaseOwner: "dead-worker", refreshLeaseExpiresAt: fixtureAt }).where(eq(schema.paymentsSepayConnections.id, old.id));
    await expect(abandoned.connections.getReadbackAccess(old.id)).rejects.toMatchObject({ code: "reconnect_required" });
    expect(abandoned.provider.refresh).not.toHaveBeenCalled();
    expect((await abandoned.current()).status).toBe("reconnect_required");
  });

  test("GET account discovery never renews an expiring or expired grant", async () => {
    const creator = await fixture.creator(); const authorized = await creator.authorize();
    creator.advance(3_580_000);
    const discovered = await creator.connections.listAccounts({ actor: creator.actor, connectionId: authorized.id });
    expect(discovered).toMatchObject({ connectionVersion: authorized.version, accounts: [{ accountId: creator.binding.accountId, eligible: true }] });
    expect(await creator.current()).toEqual(authorized);
    creator.advance(20_001);
    await expect(creator.connections.listAccounts({ actor: creator.actor, connectionId: authorized.id })).rejects.toMatchObject({ code: "reconnect_required" });
    expect(await creator.current()).toEqual(authorized);
    expect(creator.provider.refresh).not.toHaveBeenCalled();
    expect(creator.provider.discoverAccounts).toHaveBeenCalledTimes(1);
  });

  test("secret rotation cannot copy a grant whose refresh is still in flight", async () => {
    const creator = await fixture.creator(); await creator.connect(); creator.advance(3_580_000);
    const entered = deferred<void>(); const response = deferred<Awaited<ReturnType<typeof creator.provider.refresh>>>();
    creator.provider.refresh.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const old = await creator.current(); const pending = creator.connections.getReadbackAccess(old.id);
    await entered.promise;
    await expect(creator.change("rotate_secret")).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(creator.connections.getReadbackAccess(old.id)).rejects.toMatchObject({ code: "provider_unavailable", retryAfterSeconds: 30 });
    expect((await creator.current()).currentRevisionId).toBe(old.currentRevisionId);
    response.resolve({ accessToken: "fresh-access", refreshToken: "fresh-refresh", expiresAt: new Date(creator.now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
    await pending;
    expect((await creator.change("rotate_secret")).webhookSecret).toBeTruthy();
    expect((await creator.connections.getReadbackAccess(old.id)).grant.refreshToken).toBe("fresh-refresh");
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);
  });

  test("pause prevents resume until an in-flight refresh has settled, then requires reconnect", async () => {
    const creator = await fixture.creator(); await creator.connect(); creator.advance(3_580_000);
    const entered = deferred<void>(); const response = deferred<Awaited<ReturnType<typeof creator.provider.refresh>>>();
    creator.provider.refresh.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const old = await creator.current(); const pending = creator.connections.getReadbackAccess(old.id);
    const observed = expect(pending).rejects.toMatchObject({ code: "reconnect_required" });
    await entered.promise;
    expect((await creator.change("pause")).connection.status).toBe("paused");
    expect((await creator.current()).refreshLeaseOwner).not.toBeNull();
    await expect(creator.change("resume")).rejects.toMatchObject({ code: "provider_unavailable" });
    response.resolve({ accessToken: "late-access", refreshToken: "late-refresh", expiresAt: new Date(creator.now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
    await observed;
    expect(await creator.current()).toMatchObject({ status: "reconnect_required", currentRevisionId: old.currentRevisionId, refreshLeaseOwner: null });
    await expect(creator.connections.getReadbackAccess(old.id)).rejects.toMatchObject({ code: "reconnect_required" });
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);
  });

  test("exhausting the shared local budget preserves an unspent refresh grant for a later attempt", async () => {
    const creator = await fixture.creator(); await creator.connect(); creator.advance(3_580_000);
    const old = await creator.current();
    await fixture.db.insert(schema.paymentsSepayProviderBudgets).values({ environment: "test", windowStartedAt: creator.now(), requestCount: 30, updatedAt: creator.now() });
    const connections = createSePayConnectionService({ ...creator.connectionInput, provider: createSePayBudgetedProvider({ db: fixture.db, provider: creator.provider, now: creator.now }) });
    await expect(connections.getReadbackAccess(old.id)).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    expect(await creator.current()).toMatchObject({ status: "ready", version: old.version, currentRevisionId: old.currentRevisionId, refreshLeaseOwner: null });
    expect(creator.provider.refresh).not.toHaveBeenCalled();
    creator.advance(60_000);
    expect((await connections.getReadbackAccess(old.id)).grant.accessToken).toBe("synthetic-refreshed-access");
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);
  });

  test("disconnect wins over an in-flight successful refresh and truthfully reports remote revocation unknown", async () => {
    const creator = await fixture.creator(); await creator.connect(); creator.advance(3_580_000);
    const entered = deferred<void>(); const response = deferred<Awaited<ReturnType<typeof creator.provider.refresh>>>();
    creator.provider.refresh.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const old = await creator.current(); const pending = creator.connections.getReadbackAccess(old.id);
    const observed = expect(pending).rejects.toMatchObject({ code: "reconnect_required" });
    await entered.promise;
    const disconnected = await creator.change("disconnect");
    expect(disconnected.connection).toMatchObject({ status: "disconnected", remoteRevocationStatus: "unknown" });
    response.resolve({ accessToken: "late-access", refreshToken: "late-refresh", expiresAt: new Date(creator.now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
    await observed;
    const final = await creator.current();
    expect(final).toMatchObject({ status: "disconnected", currentRevisionId: old.currentRevisionId, refreshLeaseOwner: null });
    expect(creator.provider.revoke).not.toHaveBeenCalled();
  });

  test("cutover waits for every manual intent on the physical account and rejects ambiguous owners", async () => {
    const creator = await fixture.creator(); await creator.connect();
    const intent = await creator.createIntent();
    await expect(creator.change("enable_automation")).rejects.toMatchObject({ code: "open_manual_intents" });
    creator.setNow(intent.expiresAt);
    // Expiration is a real terminal transition; merely passing expiresAt was insufficient above.
    await fixture.db.transaction(async (tx) => {
      await tx.update(schema.paymentIntents).set({ state: "expired", closedAt: intent.expiresAt, updatedAt: intent.expiresAt }).where(eq(schema.paymentIntents.id, intent.id));
      await tx.update(schema.tips).set({ state: "expired", closedAt: intent.expiresAt, updatedAt: intent.expiresAt }).where(eq(schema.tips.id, intent.tipId));
    });
    // Renew through the connection service before making a cutover command.
    await creator.connections.getReadbackAccess((await creator.current()).id);
    const other = await fixture.creator({ accountNumber: creator.accountNumber });
    await expect(creator.change("enable_automation")).rejects.toMatchObject({ code: "account_conflict" });
    await fixture.db.update(schema.paymentsReceivingAccountOnboarding).set({ retiredAt: creator.now(), updatedAt: creator.now() }).where(eq(schema.paymentsReceivingAccountOnboarding.id, other.accountVersionId));
    const cutover = await creator.cutover();
    expect(cutover.accountFingerprint).toBe(creator.accountFingerprint);
    expect(cutover.creatorUserId).toBe(creator.actor.userId);
  });
});
