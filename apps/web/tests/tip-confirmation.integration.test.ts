import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  adminAuditEvents, createDatabase, creatorDiscoveryProjections, creatorHandleClaims, creatorPages,
  creatorPublicationRevisions, identityUsers, identityEmailHandoffs, runRetentionSweep, systemRetentionRuns,
  paymentsReceivingAccountOnboarding, systemCommandIdempotency, systemOutbox, tips, paymentIntents, paymentGuestCapabilities, paymentConfirmations, identitySessions, identityTotpAuthenticators, identityRoleGrants, type PawketDatabase,
} from "@pawket/database";
import { createCreatorTipSettingsService, createPublicCatalogQuery, type CreatorSeed } from "@pawket/catalog";
import { createIdentityCreatorTipAccountPort, createIdentityTipBuyerAccountPort, createIdentityTipAssurancePort } from "@pawket/identity";
import { createTipReceivingAccountEligibilityPort, fingerprintReceivingAccount, createTipPaymentIntentPort, createTipReceiptService, createCreatorTipPaymentService, expireTipPaymentIntents } from "@pawket/payments";
import { createEncryptionKeyring, encryptSensitiveField, createLookupHmac } from "@pawket/security";
import { DeterministicLocalSecurityEmailSink } from "@pawket/identity/security-email";
import { deliverSecurityEmailHandoff } from "@pawket/identity/security-email-handoff";
import { materializeTipNotification } from "../../worker/src/tip-notification.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for creator tip integration tests");
const schemaName = `tip_confirmation_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const admin = createDatabase(databaseUrl);
let db: PawketDatabase;
let close: () => Promise<void>;
const at = new Date("2026-09-12T00:00:00Z");
const key = new Uint8Array(32).fill(74); // Synthetic test-only key material.
const keyring = createEncryptionKeyring({ activeKeyId: "tip-settings-test", keys: { "tip-settings-test": key } });
const seeds = new Map<string, CreatorSeed>();
const heldPages = new Set<string>();
const amountPolicy = { minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000, 200_000] };

function service(overrides: Partial<Parameters<typeof createCreatorTipSettingsService>[0]> = {}) {
  const visibility = createPublicCatalogQuery({
    db, publishingMode: "general_audience",
    creatorSeeds: {
      async getCreatorSeed(_db, userId) { return seeds.get(userId) ?? null; },
      async getCreatorSeeds(_db, userIds) { return new Map(userIds.map((id) => [id, seeds.get(id) ?? null])); },
    },
    visibility: {
      async readHolds(_db, pageId) { return { pageHeld: heldPages.has(pageId), heldShowcaseIds: new Set<string>() }; },
      async readHoldsBatch(_db, requests) { return new Map(requests.map((r) => [r.pageId, { pageHeld: heldPages.has(r.pageId), heldShowcaseIds: new Set<string>() }])); },
    },
    mediaCatalog: {
      async resolveReadyAssets() { return new Map(); },
      async resolveReadyAssetsBatch(_db, requests) { return new Map(requests.map((r) => [r.ownerUserId, new Map()])); },
    },
  });
  return createCreatorTipSettingsService({ applicationRevision: "synthetic-increment-four-revision",
    db, visibility, creatorAccount: createIdentityCreatorTipAccountPort(),
    receivingAccount: createTipReceivingAccountEligibilityPort({ keyring, lookupHmacKey: key }),
    paymentsMode: "manual_only", publishingMode: "general_audience", amountPolicy,
    recentAuthMs: 900_000, commandFingerprintKey: key, now: () => at, ...overrides,
  });
}

async function fixture(accountNumber = "0000001234567", bindingId?: string) {
  const userId = `tip-artist-${randomUUID()}`;
  const pageId = randomUUID(); const publicationId = randomUUID(); const accountVersionId = randomUUID();
  const handle = `tips-${randomUUID().slice(0, 8)}`;
  seeds.set(userId, { userId, capabilityState: "active", capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Test artist", introduction: "Test introduction" });
  await db.transaction(async (tx) => {
    await tx.insert(identityUsers).values({ id: userId, name: "Synthetic Artist", email: `${userId}@example.invalid`, canonicalEmail: `${userId}@example.invalid`, emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
    await tx.insert(creatorPages).values({ id: pageId, userId, initializedFromRevisionId: seeds.get(userId)!.approvedRevisionId, createdAt: at, updatedAt: at });
    await tx.insert(creatorHandleClaims).values({ id: randomUUID(), pageId, normalizedHandle: handle, kind: "canonical", claimedAt: at });
    await tx.insert(creatorPublicationRevisions).values({ id: publicationId, pageId, revisionNumber: 1, canonicalHandle: handle, displayName: "Test artist", shortIntroduction: "Test introduction", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: userId, actorSessionId: "synthetic-session", expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
    await tx.update(creatorPages).set({ publishedRevisionId: publicationId }).where(eq(creatorPages.id, pageId));
    await tx.insert(creatorDiscoveryProjections).values({ pageId, revisionId: publicationId, canonicalHandle: handle, displayName: "Test artist", shortIntroduction: "Test introduction", disciplines: ["illustration"], revisionAt: at, enabled: true });
    await tx.insert(paymentsReceivingAccountOnboarding).values({
      id: accountVersionId, onboardingId: randomUUID(), applicantUserId: userId, version: 1, bankBin: "970436", bankName: "Vietcombank",
      maskedSuffix: `•••• ${accountNumber.slice(-4)}`, accountFingerprint: fingerprintReceivingAccount({ bankBin: "970436", accountNumber, key }),
      accountNumberEnvelope: encryptSensitiveField({ keyring, plaintext: accountNumber, binding: { recordType: "payments_receiving_account", recordId: bindingId ?? accountVersionId, fieldName: "account_number" } }),
      accountHolderLabelEnvelope: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC ARTIST", binding: { recordType: "payments_receiving_account", recordId: accountVersionId, fieldName: "account_holder_label" } }),
      proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at,
    });
  });
  return { userId, pageId, handle, publicationId, accountVersionId, accountNumber };
}
beforeAll(async () => {
  await admin.db.execute(sql.raw(`create schema "${schemaName}"`));
  const url = new URL(databaseUrl); url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  const connection = createDatabase(url.toString()); db = connection.db; close = connection.close;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
});
afterAll(async () => {
  await close?.();
  await admin.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await admin.db.execute(sql.raw(`drop schema if exists "${journalSchema}" cascade`));
  await admin.close();
});


import { createTipService, createTipAccessPort, createTipLifecyclePort, createTipExpiryPort, type CreateTipCommand } from "@pawket/tips";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function optedIn() {
  const f = await fixture();
  await service().saveSettings({ actor: { userId: f.userId, sessionId: "synthetic-session", primaryAuthenticatedAt: at },
    pageId: f.pageId, expectedRevision: 0, enabled: true, presetsVnd: [20_000, 50_000, 100_000], idempotencyKey: randomUUID(), requestId: randomUUID() });
  return f;
}
const hmac = (context: string, value: string) => createLookupHmac({ key, context, value });
const command = (f: Fixture): CreateTipCommand => ({ principal: { kind: "guest", context: randomBytes(32).toString("base64url") },
  canonicalHandle: f.handle, amountVnd: 50_000, name: " Synthetic Guest ", message: " Thank you 🎨 ",
  abuseKeyHash: hmac("tip-abuse-key", randomUUID()), idempotencyKey: randomUUID(), requestId: randomUUID() });
function paymentPort(overrides: Partial<Parameters<typeof createTipPaymentIntentPort>[0]> = {}) {
  return createTipPaymentIntentPort({ keyring, lookupHmacKey: key, intentTtlMs: 86_400_000, guestReceiptTtlMs: 604_800_000, openIpLimit: 3, openCreatorLimit: 1000, ...overrides });
}
function createService(overrides: Partial<Parameters<typeof createTipService>[0]> = {}) {
  return createTipService({ applicationRevision: "synthetic-increment-four-revision", db, creatorEligibility: service(), payments: paymentPort(), buyerAccounts: createIdentityTipBuyerAccountPort(),
    paymentsMode: "manual_only", publishingMode: "general_audience", keyring, lookupHmacKey: key, idempotencyTtlMs: 604_800_000, now: () => at, ...overrides });
}
function receiptService(overrides: Partial<Parameters<typeof createTipReceiptService>[0]> = {}) {
  return createTipReceiptService({ applicationRevision: "synthetic-increment-four-revision", db, paymentsMode: "manual_only", keyring, lookupHmacKey: key, tips: createTipAccessPort(),
    buyerAccounts: createIdentityTipBuyerAccountPort(), creatorEligibility: service(), claimRateLimit: async () => true, now: () => at, ...overrides });
}
async function evidence(f: Fixture) {
  const tipRows = await db.select().from(tips).where(eq(tips.creatorUserId, f.userId));
  const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.creatorUserId, f.userId));
  const capabilities = await db.select().from(paymentGuestCapabilities).innerJoin(paymentIntents, eq(paymentGuestCapabilities.paymentIntentId, paymentIntents.id)).where(eq(paymentIntents.creatorUserId, f.userId));
  const audit = await db.select().from(adminAuditEvents).where(and(eq(adminAuditEvents.action, "tip.created"), sql`${adminAuditEvents.afterState}->>'creatorUserId' = ${f.userId}`));
  const outbox = await db.select().from(systemOutbox).where(and(eq(systemOutbox.eventType, "tip.created.v1"), sql`${systemOutbox.payload}->>'creatorUserId' = ${f.userId}`));
  const commands = await db.select().from(systemCommandIdempotency).where(and(eq(systemCommandIdempotency.commandScope, "tips.create"), inArray(systemCommandIdempotency.resultReference, tipRows.map((r) => `tip-created-v1:${r.id}`))));
  return { tipRows, intents, capabilities, audit, outbox, commands };
}

async function session(f: Fixture, options: { primaryAt?: Date; mfaAt?: Date | null; enrolled?: boolean } = {}) {
  const sessionId = `tip-session-${randomUUID()}`;
  const primaryAt = options.primaryAt ?? at;
  await db.insert(identitySessions).values({ id: sessionId, userId: f.userId, token: hmac("tip-test-session", randomUUID()),
    createdAt: new Date(at.getTime() - 3_600_000), updatedAt: at, lastUsedAt: at,
    primaryAuthenticatedAt: primaryAt, mfaVerifiedAt: options.mfaAt ?? null, assuranceState: "active", authorizationVersion: 1,
    expiresAt: new Date(at.getTime() + 86_400_000), idleExpiresAt: new Date(at.getTime() + 86_400_000), absoluteExpiresAt: new Date(at.getTime() + 86_400_000),
  });
  if (options.enrolled) {
    const factorId = `tip-factor-${randomUUID()}`;
    await db.update(identityUsers).set({ twoFactorEnabled: true }).where(eq(identityUsers.id, f.userId));
    await db.insert(identityTotpAuthenticators).values({ id: factorId, userId: f.userId, verified: true, lastUsedStep: Math.floor(at.getTime() / 30_000),
      createdAt: new Date(at.getTime() - 3_600_000), updatedAt: at,
      secret: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC-TOTP-SECRET", binding: { recordType: "identity_totp_authenticator", recordId: factorId, fieldName: "secret" } }),
    });
  }
  return { userId: f.userId, sessionId };
}
function creatorService(overrides: Partial<Parameters<typeof createCreatorTipPaymentService>[0]> = {}) {
  return createCreatorTipPaymentService({ applicationRevision: "synthetic-increment-four-revision", db, keyring, lookupHmacKey: key, paymentsMode: "manual_only", pageSize: 25, recentAuthMs: 900_000, totpAuthMs: 300_000,
    assurance: createIdentityTipAssurancePort(), tips: createTipLifecyclePort({ keyring }), now: () => at, ...overrides });
}
async function pending(options: Parameters<typeof session>[1] = {}, creation: Partial<Parameters<typeof createTipService>[0]> = {}) {
  const f = await optedIn(); const actor = await session(f, options); const c = command(f); const created = await createService(creation).createTip(c);
  const [intent] = (await evidence(f)).intents;
  if (!intent) throw new Error("Missing synthetic intent");
  const confirm = { actor, paymentIntentId: intent.id, observedAmountVnd: 50_000, observedTransferReference: created.instruction.reference,
    observedBankTransactionId: `txn-${randomUUID()}`, attestedReceived: true, idempotencyKey: randomUUID(), requestId: randomUUID() };
  return { f, actor, created, intent, confirm };
}
async function confirmationFacts(f: Fixture) {
  const creation = await evidence(f); const ids = creation.intents.map((row) => row.id);
  return { tips: creation.tipRows, intents: creation.intents,
    confirmations: await db.select().from(paymentConfirmations).where(eq(paymentConfirmations.creatorUserId, f.userId)),
    audit: await db.select().from(adminAuditEvents).where(and(inArray(adminAuditEvents.subjectId, ids), eq(adminAuditEvents.action, "tip.confirmed"))),
    outbox: await db.select().from(systemOutbox).where(and(inArray(systemOutbox.aggregateId, ids), eq(systemOutbox.eventType, "tip.confirmed.v1"))),
    commands: await db.select().from(systemCommandIdempotency).where(and(eq(systemCommandIdempotency.actorUserId, f.userId), eq(systemCommandIdempotency.commandScope, "payments.tip_confirm"))),
  };
}

describe("creator manual confirmation with authoritative Identity assurance", () => {
  test("post-commit telemetry can fail without changing success or replay, and rejects emit no success", async () => {
    const f = await optedIn(); const c = command(f);
    const onCreate = vi.fn(() => { throw new Error("synthetic telemetry failure"); });
    const creating = createService({ onCommitted: onCreate });
    const created = await creating.createTip(c);
    expect(await creating.createTip(c)).toEqual(created);
    await expect(creating.createTip({ ...c, amountVnd: 20_000 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(onCreate.mock.calls).toEqual([[false], [true]]);
    const claim = { reference: created.instruction.reference, access: { kind: "guest" as const, capability: created.guestCapability!.secret }, requestId: randomUUID() };
    const onClaim = vi.fn(() => { throw new Error("synthetic telemetry failure"); });
    const claiming = receiptService({ onClaimCommitted: onClaim });
    const firstClaim = await claiming.reportTransfer(claim);
    expect(await claiming.reportTransfer(claim)).toEqual(firstClaim);
    expect(firstClaim.authoritative).toBe(false);
    await expect(claiming.reportTransfer({ ...claim, access: { kind: "guest", capability: "invalid" } })).rejects.toMatchObject({ code: "not_authorized" });
    expect(onClaim.mock.calls).toEqual([[false], [true]]);
    const actor = await session(f); const [intent] = (await evidence(f)).intents;
    const confirm = { actor, paymentIntentId: intent!.id, observedAmountVnd: 50_000, observedTransferReference: created.instruction.reference,
      observedBankTransactionId: `txn-${randomUUID()}`, attestedReceived: true, idempotencyKey: randomUUID(), requestId: randomUUID() };
    const onConfirm = vi.fn(() => { throw new Error("synthetic telemetry failure"); });
    const confirming = creatorService({ onCommitted: onConfirm });
    await expect(confirming.confirm({ ...confirm, observedAmountVnd: 20_000 })).rejects.toMatchObject({ code: "evidence_mismatch" });
    const confirmed = await confirming.confirm(confirm);
    expect(await confirming.confirm(confirm)).toEqual(confirmed);
    expect(onConfirm.mock.calls).toEqual([[false], [true]]);
    expect((await confirmationFacts(f)).confirmations).toHaveLength(1);
    const audit = await db.select().from(adminAuditEvents).where(inArray(adminAuditEvents.requestId, [c.requestId, claim.requestId, confirm.requestId]));
    expect(audit).toHaveLength(3);
    expect(audit.every((row) => row.applicationRevision === "synthetic-increment-four-revision")).toBe(true);
  });

  test("a revocation committed while confirmation waits on its session is observed before payment changes", async () => {
    const p = await pending(); const ready = Promise.withResolvers<number>(); const hold = Promise.withResolvers<void>();
    const revoking = db.transaction(async (tx) => {
      await tx.update(identitySessions).set({ revokedAt: at, revocationReason: "synthetic_revocation" }).where(eq(identitySessions.id, p.actor.sessionId));
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready.resolve(backend!.pid); await hold.promise;
    });
    const pid = await ready.promise;
    const confirming = creatorService().confirm(p.confirm).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(async () => {
        const [blocked] = await db.execute<{ value: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as value`);
        expect(blocked?.value).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { hold.resolve(); }
    await revoking;
    expect(await confirming).toMatchObject({ error: { code: "not_authorized" } });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
  });

  test("the authoritative user/session fence is retained until confirmation commits", async () => {
    const p = await pending({ enrolled: true, mfaAt: at }); const ready = Promise.withResolvers<number>(); const hold = Promise.withResolvers<void>();
    const real = createIdentityTipAssurancePort();
    const svc = creatorService({ assurance: { async getTipSessionAssurance(tx, actor, time) {
      const proof = await real.getTipSessionAssurance(tx, actor, time);
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready.resolve(backend!.pid); await hold.promise; return proof;
    } } });
    const confirming = svc.confirm(p.confirm); const pid = await ready.promise;
    const suspending = db.update(identityUsers).set({ accessStatus: "access_suspended", authorizationVersion: 2 }).where(eq(identityUsers.id, p.f.userId)).execute();
    try {
      await vi.waitFor(async () => {
        const [blocked] = await db.execute<{ value: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as value`);
        expect(blocked?.value).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { hold.resolve(); }
    expect((await confirming).state).toBe("confirmed"); await suspending;
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "not_authorized" });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(1);
  });

  test("atomically confirms an exact transfer, completes Tips and reveals private content only afterward", async () => {
    const p = await pending(); const svc = creatorService();
    const queue = await svc.listQueue({ actor: p.actor });
    expect(queue.items).toHaveLength(1); expect(queue.items[0]).not.toHaveProperty("guestContent");
    expect(JSON.stringify(queue)).not.toContain(p.f.accountNumber); expect(JSON.stringify(queue)).not.toContain("Synthetic Guest");
    const result = await svc.confirm(p.confirm);
    expect(result).toMatchObject({ id: p.intent.id, state: "confirmed", confirmedAt: at.toISOString(), guestContent: { name: "Synthetic Guest", message: "Thank you 🎨" } });
    expect(await svc.confirm(p.confirm)).toEqual(result);
    const rows = await confirmationFacts(p.f);
    expect(Object.values(rows).map((value) => value.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(rows.tips[0]).toMatchObject({ state: "completed", closedAt: at });
    expect(rows.intents[0]).toMatchObject({ state: "confirmed", closedAt: at });
    expect(rows.confirmations[0]).toMatchObject({ source: "creator_manual", actorSessionId: p.actor.sessionId, primaryAuthenticatedAt: at, totpVerifiedAt: null, attestedReceived: true });
    for (const sensitive of [p.confirm.observedBankTransactionId, p.confirm.observedBankTransactionId.toUpperCase(), p.created.guestCapability!.secret, "Synthetic Guest", p.f.accountNumber]) {
      expect(JSON.stringify(rows)).not.toContain(sensitive);
    }
    expect((await svc.listQueue({ actor: p.actor, state: "confirmed" })).items).toEqual([result]);
    const receipt = await receiptService().readReceipt({ reference: p.created.instruction.reference, access: { kind: "guest", capability: p.created.guestCapability!.secret } });
    expect(receipt).toMatchObject({ receipt: { state: "confirmed", confirmedAt: at.toISOString() }, instruction: null });
    await expect(db.update(paymentConfirmations).set({ observedAmountVnd: 60_000 }).where(eq(paymentConfirmations.paymentIntentId, p.intent.id))).rejects.toThrow();
  });

  test("owner/admin status cannot confirm or inspect another creator's tips", async () => {
    const p = await pending(); const foreign = await fixture(); const actor = await session(foreign, { enrolled: true, mfaAt: at });
    await db.insert(identityRoleGrants).values({ id: randomUUID(), userId: foreign.userId, role: "owner", state: "active", grantSource: "bootstrap_cli", grantedAt: at, createdAt: at, updatedAt: at });
    const svc = creatorService();
    expect((await svc.listQueue({ actor })).items).toEqual([]);
    await expect(svc.confirm({ ...p.confirm, actor })).rejects.toMatchObject({ code: "not_authorized" });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
  });

  test("stale/future primary authentication is rejected using stored session facts", async () => {
    for (const primaryAt of [new Date(at.getTime() - 900_001), new Date(at.getTime() + 1)]) {
      const p = await pending({ primaryAt });
      await expect(creatorService().confirm({ ...p.confirm, actor: { ...p.actor, primaryAuthenticatedAt: at } } as typeof p.confirm)).rejects.toMatchObject({ code: "recent_auth_required" });
      expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
    }
    const p = await pending({ primaryAt: new Date(at.getTime() - 300_001) });
    await expect(creatorService({ recentAuthMs: 300_000 }).confirm(p.confirm)).rejects.toMatchObject({ code: "recent_auth_required" });
  });

  test("enrolled TOTP must be recent, non-future and at least as recent as primary authentication", async () => {
    for (const mfaAt of [null, new Date(at.getTime() - 300_001), new Date(at.getTime() + 1), new Date(at.getTime() - 1)]) {
      const p = await pending({ enrolled: true, mfaAt });
      await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "totp_required" });
      expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
    }
    const p = await pending({ enrolled: true, mfaAt: at });
    expect((await creatorService().confirm(p.confirm)).state).toBe("confirmed");
    expect((await confirmationFacts(p.f)).confirmations[0]?.totpVerifiedAt).toEqual(at);
  });

  test("enrollment flags cannot bypass missing authenticator evidence or a replaced factor", async () => {
    const p = await pending({ enrolled: true, mfaAt: at });
    await db.update(identityUsers).set({ twoFactorEnabled: false }).where(eq(identityUsers.id, p.f.userId));
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "totp_required" });
    await db.update(identityUsers).set({ twoFactorEnabled: true }).where(eq(identityUsers.id, p.f.userId));
    await db.update(identityTotpAuthenticators).set({ createdAt: new Date(at.getTime() + 1) }).where(eq(identityTotpAuthenticators.userId, p.f.userId));
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "totp_required" });
    await db.delete(identityTotpAuthenticators).where(eq(identityTotpAuthenticators.userId, p.f.userId));
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "totp_required" });
  });

  test("a narrower configured TOTP window is enforced independently of the primary-authentication window", async () => {
    const p = await pending({ enrolled: true, primaryAt: new Date(at.getTime() - 60_000), mfaAt: new Date(at.getTime() - 30_001) });
    await expect(creatorService({ totpAuthMs: 30_000 }).confirm(p.confirm)).rejects.toMatchObject({ code: "totp_required" });
    expect((await creatorService().confirm(p.confirm)).state).toBe("confirmed");
  });

  test("revoked, expired, pending-MFA and obsolete authorization-version sessions fail closed", async () => {
    for (const changes of [{ revokedAt: at, revocationReason: "synthetic_revocation" }, { expiresAt: at }, { assuranceState: "mfa_pending" }, { authorizationVersion: 0 }]) {
      const p = await pending(); await db.update(identitySessions).set(changes).where(eq(identitySessions.id, p.actor.sessionId));
      await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "not_authorized" });
      expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
    }
    const p = await pending(); await db.update(identityUsers).set({ accessStatus: "access_suspended" }).where(eq(identityUsers.id, p.f.userId));
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "not_authorized" });
  });

  test("amount/reference mismatches, missing attestation and malformed bank IDs cannot confirm", async () => {
    const p = await pending(); const svc = creatorService();
    for (const changes of [{ observedAmountVnd: 50_001 }, { observedTransferReference: `PW${"0".repeat(20)}` }, { observedTransferReference: p.confirm.observedTransferReference.toLowerCase() }]) {
      await expect(svc.confirm({ ...p.confirm, ...changes, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "evidence_mismatch" });
    }
    for (const changes of [{ attestedReceived: false }, { observedBankTransactionId: "transfer id with spaces" }, { observedBankTransactionId: "ß" }, { observedBankTransactionId: "abc\n123" }]) {
      await expect(svc.confirm({ ...p.confirm, ...changes, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(svc.confirm({ ...p.confirm, observedAmountVnd: "50000" })).rejects.toMatchObject({ code: "invalid_amount" });
    expect((await confirmationFacts(p.f)).commands).toHaveLength(0);
  });

  test("same-key concurrent confirmations replay one result; different keys cannot reconfirm it", async () => {
    const p = await pending(); const svc = creatorService();
    const results = await Promise.all([svc.confirm(p.confirm), svc.confirm(p.confirm), svc.confirm(p.confirm)]);
    expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2]);
    await expect(svc.confirm({ ...p.confirm, observedBankTransactionId: "different-bank-id" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(svc.confirm({ ...p.confirm, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "intent_not_pending" });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(1);
  });

  test("different concurrent commands serialize on the intent and cannot double-complete it", async () => {
    const p = await pending(); const svc = creatorService();
    const results = await Promise.allSettled([svc.confirm(p.confirm), svc.confirm({ ...p.confirm, idempotencyKey: randomUUID(), observedBankTransactionId: "second-distinct-bank-id" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "intent_not_pending" } });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(1);
  });

  test("one bank transaction cannot confirm two intents, including case/whitespace variants across creators sharing a receiving account", async () => {
    const p = await pending(); const other = await pending(); const svc = creatorService(); const bankId = `bank-${randomUUID()}`;
    const results = await Promise.allSettled([svc.confirm({ ...p.confirm, observedBankTransactionId: bankId }), svc.confirm({ ...other.confirm, observedBankTransactionId: ` ${bankId.toUpperCase()} ` })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "bank_transaction_conflict" } });
    expect((await confirmationFacts(p.f)).confirmations.length + (await confirmationFacts(other.f)).confirmations.length).toBe(1);
  });

  test("retired account, global disable and expiration reject confirmation without changing historical facts", async () => {
    const p = await pending();
    await expect(creatorService({ paymentsMode: "disabled" }).confirm(p.confirm)).rejects.toMatchObject({ code: "payments_disabled" });
    expect((await creatorService({ paymentsMode: "disabled" }).listQueue({ actor: p.actor })).items).toHaveLength(1);
    const expiredAt = new Date(at.getTime() + 86_400_000);
    await db.update(identitySessions).set({ primaryAuthenticatedAt: expiredAt, expiresAt: new Date(expiredAt.getTime() + 900_000), idleExpiresAt: new Date(expiredAt.getTime() + 900_000), absoluteExpiresAt: new Date(expiredAt.getTime() + 900_000) }).where(eq(identitySessions.id, p.actor.sessionId));
    await expect(creatorService({ now: () => expiredAt }).confirm(p.confirm)).rejects.toMatchObject({ code: "intent_not_pending" });
    await db.update(identitySessions).set({ primaryAuthenticatedAt: at }).where(eq(identitySessions.id, p.actor.sessionId));
    await db.update(paymentsReceivingAccountOnboarding).set({ retiredAt: at, updatedAt: at }).where(eq(paymentsReceivingAccountOnboarding.id, p.f.accountVersionId));
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "evidence_mismatch" });
    const rows = await confirmationFacts(p.f); expect(rows.confirmations).toHaveLength(0); expect(rows.tips[0]?.state).toBe("awaiting_payment");
  });

  test("a replacement account version cannot redirect an old intent or reuse an earlier bank transaction", async () => {
    const p = await pending(); const svc = creatorService(); await svc.confirm(p.confirm);
    const oldPending = await createService().createTip(command(p.f));
    const [oldIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.referenceHash, hmac("tip-transfer-reference", oldPending.instruction.reference)));
    const nextId = randomUUID();
    await db.transaction(async (tx) => {
      const [old] = await tx.update(paymentsReceivingAccountOnboarding).set({ retiredAt: at, updatedAt: at }).where(eq(paymentsReceivingAccountOnboarding.id, p.f.accountVersionId)).returning();
      if (!old) throw new Error("Missing synthetic account");
      await tx.insert(paymentsReceivingAccountOnboarding).values({ ...old, id: nextId, version: old.version + 1, retiredAt: null,
        accountNumberEnvelope: encryptSensitiveField({ keyring, plaintext: p.f.accountNumber, binding: { recordType: "payments_receiving_account", recordId: nextId, fieldName: "account_number" } }),
        accountHolderLabelEnvelope: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC ARTIST", binding: { recordType: "payments_receiving_account", recordId: nextId, fieldName: "account_holder_label" } }),
      });
    });
    await expect(svc.confirm({ ...p.confirm, paymentIntentId: oldIntent!.id, observedTransferReference: oldPending.instruction.reference, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "evidence_mismatch" });
    const current = await createService().createTip(command(p.f));
    const [currentIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.referenceHash, hmac("tip-transfer-reference", current.instruction.reference)));
    expect(currentIntent?.accountVersionId).toBe(nextId);
    await expect(svc.confirm({ ...p.confirm, paymentIntentId: currentIntent!.id, observedTransferReference: current.instruction.reference, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "bank_transaction_conflict" });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(1);
  });

  test("stopping new tips or unpublishing does not prevent exact settlement of an existing intent", async () => {
    const p = await pending();
    await service().saveSettings({ actor: { ...p.actor, primaryAuthenticatedAt: at }, pageId: p.f.pageId, expectedRevision: 1, enabled: false, presetsVnd: [20_000, 50_000, 100_000], idempotencyKey: randomUUID(), requestId: randomUUID() });
    await db.update(creatorPages).set({ publishedRevisionId: null }).where(eq(creatorPages.id, p.f.pageId));
    expect((await creatorService().confirm(p.confirm)).state).toBe("confirmed");
    await expect(createService().createTip(command(p.f))).rejects.toMatchObject({ code: "not_available" });
  });

  test("an explicit policy rejection is terminal and cannot be confirmed", async () => {
    const p = await pending();
    await db.transaction(async (tx) => {
      await tx.update(paymentIntents).set({ state: "rejected", rejectionReason: "policy_invalidated", closedAt: at, updatedAt: at }).where(eq(paymentIntents.id, p.intent.id));
      await tx.update(tips).set({ state: "rejected", closedAt: at, updatedAt: at }).where(eq(tips.id, p.intent.tipId));
    });
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "intent_not_pending" });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
  });

  test("over-broad or non-text module projections fail closed and cannot leak through confirmation", async () => {
    const p = await pending(); const ports = createTipLifecyclePort({ keyring });
    const expanded = creatorService({ tips: { ...ports, async getConfirmedGuestContent() { return { name: "Guest", message: "Text", privateAccount: p.f.accountNumber }; } } });
    await expect(expanded.confirm(p.confirm)).rejects.toMatchObject({ code: "dependency_unavailable" });
    const oversized = creatorService({ tips: { ...ports, async getConfirmedGuestContent() { return { name: "Guest", message: "x".repeat(281) }; } } });
    await expect(oversized.confirm(p.confirm)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect((await confirmationFacts(p.f)).confirmations).toHaveLength(0);
  });

  test("bounded queue cursor binds creator and filter, and pending content never reaches a content read port", async () => {
    const f = await optedIn(); const actor = await session(f); const tipsPort = createTipLifecyclePort({ keyring });
    const content = vi.fn(tipsPort.getConfirmedGuestContent); const svc = creatorService({ pageSize: 2, tips: { ...tipsPort, getConfirmedGuestContent: content } });
    for (let i = 0; i < 3; i++) await createService().createTip(command(f));
    const first = await svc.listQueue({ actor }); const second = await svc.listQueue({ actor, cursor: first.nextCursor! });
    expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(3); expect(content).not.toHaveBeenCalled();
    const other = await fixture(); const otherActor = await session(other);
    await expect(svc.listQueue({ actor: otherActor, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(svc.listQueue({ actor, state: "confirmed", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(svc.listQueue({ actor, cursor: `${first.nextCursor!}x` })).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("Tips failure rolls back the confirmation and all correlated state", async () => {
    const p = await pending(); const svc = creatorService({ tips: { ...createTipLifecyclePort({ keyring }), async completeTip() { return false; } } });
    await expect(svc.confirm(p.confirm)).rejects.toMatchObject({ code: "intent_not_pending" });
    const rows = await confirmationFacts(p.f);
    expect(rows.confirmations).toHaveLength(0); expect(rows.audit).toHaveLength(0); expect(rows.outbox).toHaveLength(0); expect(rows.commands).toHaveLength(0);
    expect(rows.intents[0]?.state).toBe("awaiting_transfer"); expect(rows.tips[0]?.state).toBe("awaiting_payment");
  });

  test("late outbox failure rolls back immutable confirmation, Tip completion and idempotency", async () => {
    const p = await pending(); const name = `reject_confirm_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'tip.confirmed.v1' THEN RAISE EXCEPTION 'synthetic confirmation failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON system_outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    try {
      await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "dependency_unavailable", message: "dependency_unavailable" });
      const rows = await confirmationFacts(p.f); expect(rows.confirmations).toHaveLength(0); expect(rows.audit).toHaveLength(0); expect(rows.commands).toHaveLength(0);
      expect(rows.intents[0]?.state).toBe("awaiting_transfer"); expect(rows.tips[0]?.state).toBe("awaiting_payment");
    } finally { await db.execute(sql.raw(`DROP TRIGGER ${name} ON system_outbox`)); await db.execute(sql.raw(`DROP FUNCTION ${name}()`)); }
    expect((await creatorService().confirm(p.confirm)).state).toBe("confirmed");
  });
});

describe("bounded tip expiry with atomic Tips and Payments facts", () => {
  const due = new Date(at.getTime() + 300_000);
  const shortPending = () => pending({}, { payments: paymentPort({ intentTtlMs: 300_000 }) });
  const scan = (overrides: Partial<Parameters<typeof expireTipPaymentIntents>[0]> = {}) => expireTipPaymentIntents({ db, tips: createTipExpiryPort(), paymentsMode: "manual_only", batchSize: 100, now: due, applicationRevision: "synthetic-expiry-revision", ...overrides });
  afterEach(async () => { await scan({ batchSize: 500 }); });

  test("disabled and before-deadline scans are inert; due scan commits matching states and one fact", async () => {
    const p = await shortPending();
    expect(await scan({ paymentsMode: "disabled" })).toEqual({ scanned: 0, expired: 0 });
    expect(await scan({ now: new Date(due.getTime() - 1) })).toEqual({ scanned: 0, expired: 0 });
    expect(await scan()).toEqual({ scanned: 1, expired: 1 });
    expect(await scan()).toEqual({ scanned: 0, expired: 0 });
    const facts = await confirmationFacts(p.f); expect(facts.intents[0]?.state).toBe("expired"); expect(facts.tips[0]?.state).toBe("expired"); expect(facts.confirmations).toHaveLength(0);
    const outbox = await db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, p.intent.id), eq(systemOutbox.eventType, "tip.expired.v1")));
    const audit = await db.select().from(adminAuditEvents).where(and(eq(adminAuditEvents.subjectId, p.intent.id), eq(adminAuditEvents.action, "tip.expired")));
    expect(outbox).toHaveLength(1); expect(audit).toHaveLength(1); expect(audit[0]?.applicationRevision).toBe("synthetic-expiry-revision");
    expect(JSON.stringify([...outbox, ...audit])).not.toContain(p.created.instruction.reference); expect(JSON.stringify([...outbox, ...audit])).not.toMatch(/Synthetic Guest|0000001234567|Thank you/u);
    await expect(creatorService().confirm(p.confirm)).rejects.toMatchObject({ code: "intent_not_pending" });
  });

  test("honors the batch bound and never changes an already confirmed intent", async () => {
    const confirmed = await shortPending(); await creatorService().confirm(confirmed.confirm);
    await shortPending(); await shortPending();
    expect(await scan({ batchSize: 1 })).toEqual({ scanned: 1, expired: 1 });
    expect(await scan({ batchSize: 1 })).toEqual({ scanned: 1, expired: 1 });
    expect(await scan()).toEqual({ scanned: 0, expired: 0 });
    const facts = await confirmationFacts(confirmed.f); expect(facts.intents[0]?.state).toBe("confirmed"); expect(facts.tips[0]?.state).toBe("completed"); expect(facts.confirmations).toHaveLength(1);
  });

  test("concurrent scans expire one intent exactly once", async () => {
    const p = await shortPending();
    const results = await Promise.all([scan({ batchSize: 1 }), scan({ batchSize: 1 })]);
    expect(results.reduce((n, r) => n + r.expired, 0)).toBe(1);
    const events = await db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, p.intent.id), eq(systemOutbox.eventType, "tip.expired.v1")));
    expect(events).toHaveLength(1);
  });

  test("skips a locked intent and safely retries it after release", async () => {
    const p = await shortPending(); const ready = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const holding = db.transaction(async (tx) => { await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(eq(paymentIntents.id, p.intent.id)).for("update"); ready.resolve(); await release.promise; });
    await ready.promise;
    try { expect(await scan()).toEqual({ scanned: 0, expired: 0 }); }
    finally { release.resolve(); await holding; }
    expect(await scan()).toEqual({ scanned: 1, expired: 1 });
  });

  test("confirmation and expiry serialize without a split Tip/payment state", async () => {
    const p = await shortPending();
    const [confirmation, expiry] = await Promise.allSettled([creatorService({ now: () => new Date(due.getTime() - 1) }).confirm(p.confirm), scan()]);
    expect(expiry.status).toBe("fulfilled"); const facts = await confirmationFacts(p.f);
    if (confirmation.status === "fulfilled") { expect(facts.intents[0]?.state).toBe("confirmed"); expect(facts.tips[0]?.state).toBe("completed"); expect(facts.confirmations).toHaveLength(1); }
    else { expect(confirmation.reason).toMatchObject({ code: "intent_not_pending" }); expect(facts.intents[0]?.state).toBe("expired"); expect(facts.tips[0]?.state).toBe("expired"); expect(facts.confirmations).toHaveLength(0); }
  });

  test("outbox or lifecycle failure rolls back both states and allows retry", async () => {
    const p = await shortPending(); const trigger = `reject_expiry_${randomUUID().replaceAll("-", "")}`;
    await expect(scan({ tips: { async expireTip() { throw new Error("private synthetic dependency detail"); } } })).rejects.toMatchObject({ code: "dependency_unavailable", message: "dependency_unavailable" });
    expect((await confirmationFacts(p.f)).intents[0]?.state).toBe("awaiting_transfer");
    await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'tip.expired.v1' THEN RAISE EXCEPTION 'synthetic expiry failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON system_outbox FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
    try {
      await expect(scan()).rejects.toMatchObject({ code: "dependency_unavailable" });
      const facts = await confirmationFacts(p.f); expect(facts.intents[0]?.state).toBe("awaiting_transfer"); expect(facts.tips[0]?.state).toBe("awaiting_payment");
      expect(await db.select().from(adminAuditEvents).where(and(eq(adminAuditEvents.subjectId, p.intent.id), eq(adminAuditEvents.action, "tip.expired")))).toHaveLength(0);
    } finally { await db.execute(sql.raw(`DROP TRIGGER ${trigger} ON system_outbox`)); await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`)); }
    expect(await scan()).toEqual({ scanned: 1, expired: 1 });
  });
});

describe("tip notification handoff and protected report-only retention", () => {
  const now = new Date(at.getTime() + 301_000);
  async function sourceFor(p: Awaited<ReturnType<typeof pending>>, eventType: string) {
    const [source] = await db.select().from(systemOutbox).where(and(eq(systemOutbox.eventType, eventType), eq(systemOutbox.aggregateId, eventType === "tip.created.v1" ? p.intent.tipId : p.intent.id)));
    if (!source) throw new Error("Missing synthetic notification source");
    return { outboxEventId: source.id, eventType: source.eventType, eventVersion: source.eventVersion, aggregateType: source.aggregateType, aggregateId: source.aggregateId };
  }
  test("concurrent replay creates one encrypted email and in-app handoff for each authoritative lifecycle fact", async () => {
    const p = await pending(); const created = await sourceFor(p, "tip.created.v1");
    const results = await Promise.all([materializeTipNotification({ db, keyring, event: created, now }), materializeTipNotification({ db, keyring, event: created, now })]);
    expect(results.sort()).toEqual(["already_materialized", "created"]);
    await creatorService().confirm(p.confirm); const confirmed = await sourceFor(p, "tip.confirmed.v1");
    expect(await materializeTipNotification({ db, keyring, event: confirmed, now })).toBe("created");
    const expired = await pending({}, { payments: paymentPort({ intentTtlMs: 300_000 }) });
    await expireTipPaymentIntents({ db, tips: createTipExpiryPort(), paymentsMode: "manual_only", batchSize: 100, now, applicationRevision: "synthetic-notification-revision" });
    const expiry = await sourceFor(expired, "tip.expired.v1"); expect(await materializeTipNotification({ db, keyring, event: expiry, now })).toBe("created");
    const sourceIds = [created.outboxEventId, confirmed.outboxEventId, expiry.outboxEventId];
    const emails = await db.select().from(identityEmailHandoffs).where(inArray(identityEmailHandoffs.sourceOutboxEventId, sourceIds));
    const inApp = await db.select().from(systemOutbox).where(and(eq(systemOutbox.eventType, "tip.notification_available.v1"), inArray(systemOutbox.aggregateId, sourceIds)));
    expect(emails).toHaveLength(3); expect(inApp).toHaveLength(3);
    for (const row of emails) { expect(row.purpose).toBe("tip_status"); expect(row.destinationEnvelope).not.toBeNull(); expect(row.secretEnvelope).toBeNull(); expect(Object.keys(row.templateData).sort()).toEqual(["returnPath", "state"]); }
    expect(JSON.stringify([...emails, ...inApp])).not.toMatch(/Synthetic Guest|0000001234567|Thank you/u); expect(JSON.stringify([...emails, ...inApp])).not.toContain(p.created.instruction.reference);
    const sink = new DeterministicLocalSecurityEmailSink(); const email = emails.find((row) => row.sourceOutboxEventId === confirmed.outboxEventId)!;
    expect(await deliverSecurityEmailHandoff(db, { handoffId: email.id, workerId: "synthetic-tip-delivery", keyring, sender: sink, now })).toBe("delivered");
    expect(await deliverSecurityEmailHandoff(db, { handoffId: email.id, workerId: "synthetic-tip-delivery", keyring, sender: sink, now })).toBe("already_delivered"); expect(sink.snapshot()).toHaveLength(1);
  });

  test("forged queue metadata cannot authorize a handoff; delivery failure cannot change payment state", async () => {
    const p = await pending(); await creatorService().confirm(p.confirm); const event = await sourceFor(p, "tip.confirmed.v1");
    await expect(materializeTipNotification({ db, keyring, event: { ...event, aggregateId: randomUUID() }, now })).rejects.toThrow("Tip notification handoff failed");
    await expect(materializeTipNotification({ db, keyring, event: { ...event, eventType: "tip.expired.v1" }, now })).rejects.toThrow("Tip notification handoff failed");
    expect(await db.select().from(identityEmailHandoffs).where(eq(identityEmailHandoffs.sourceOutboxEventId, event.outboxEventId))).toHaveLength(0);
    await materializeTipNotification({ db, keyring, event, now });
    const [email] = await db.select().from(identityEmailHandoffs).where(eq(identityEmailHandoffs.sourceOutboxEventId, event.outboxEventId));
    await expect(deliverSecurityEmailHandoff(db, { handoffId: email!.id, workerId: "synthetic-failed-tip-delivery", keyring, now, sender: { async send() { throw new Error("private provider details"); } } })).rejects.toThrow();
    const facts = await confirmationFacts(p.f); expect(facts.intents[0]?.state).toBe("confirmed"); expect(facts.tips[0]?.state).toBe("completed"); expect(facts.confirmations).toHaveLength(1);
    expect(await materializeTipNotification({ db, keyring, event, now })).toBe("already_materialized");
  });

  test("an unverified email records attention without inventing a destination or changing business state", async () => {
    const p = await pending(); const event = await sourceFor(p, "tip.created.v1");
    await db.update(identityUsers).set({ emailVerified: false, emailVerifiedAt: null, emailVerificationProvenance: null }).where(eq(identityUsers.id, p.f.userId));
    expect(await materializeTipNotification({ db, keyring, event, now })).toBe("attention_required");
    const [email] = await db.select().from(identityEmailHandoffs).where(eq(identityEmailHandoffs.sourceOutboxEventId, event.outboxEventId));
    expect(email).toMatchObject({ status: "attention_required", failureCode: "no_verified_destination", destinationEnvelope: null, secretEnvelope: null });
    expect((await confirmationFacts(p.f)).intents[0]?.state).toBe("awaiting_transfer");
  });

  test("tip datasets remain protected report-only even if the legacy sweep is set to enforce", async () => {
    const reportAt = new Date(at.getTime() + 8 * 86_400_000); const beforeTips = await db.select().from(tips); const beforeIntents = await db.select().from(paymentIntents); const beforeConfirmations = await db.select().from(paymentConfirmations);
    const results = await runRetentionSweep({ db, now: reportAt, mode: "enforce", enforcementPaused: false, batchSize: 25, policyVersion: "synthetic-tip-report-only" });
    const tipResults = results.filter((row) => row.dataset.startsWith("tip_")); expect(tipResults).toHaveLength(5);
    for (const result of tipResults) { expect(result).toMatchObject({ mode: "report_only", outcome: "completed", processedCount: 0 }); expect(result.protectedCount).toBe(result.candidateCount); }
    expect(await db.select().from(tips)).toEqual(beforeTips); expect(await db.select().from(paymentIntents)).toEqual(beforeIntents); expect(await db.select().from(paymentConfirmations)).toEqual(beforeConfirmations);
    const runs = await db.select().from(systemRetentionRuns).where(eq(systemRetentionRuns.policyVersion, "synthetic-tip-report-only"));
    expect(runs.filter((row) => row.dataset.startsWith("tip_")).every((row) => row.mode === "report_only" && row.processedCount === 0)).toBe(true);
    await expect(db.insert(systemRetentionRuns).values({ policyVersion: "synthetic-invalid-enforce", mode: "enforce", dataset: "tip_confirmations", cutoff: now, candidateCount: 1, protectedCount: 1, processedCount: 0, outcome: "completed", startedAt: now, completedAt: now })).rejects.toThrow();
  });

  test("database rejects minimizing a receiving account referenced by a tip", async () => {
    const p = await pending();
    await expect(db.update(paymentsReceivingAccountOnboarding).set({ accountNumberEnvelope: null, accountHolderLabelEnvelope: null, minimizedAt: now, updatedAt: now }).where(eq(paymentsReceivingAccountOnboarding.id, p.f.accountVersionId))).rejects.toMatchObject({ cause: expect.objectContaining({ message: "Tip receiving-account evidence is protected" }) });
    const [account] = await db.select().from(paymentsReceivingAccountOnboarding).where(eq(paymentsReceivingAccountOnboarding.id, p.f.accountVersionId)); expect(account?.accountNumberEnvelope).not.toBeNull(); expect(account?.minimizedAt).toBeNull();
  });

  test("a minimizer waiting on an uncommitted tip observes its financial reference after commit", async () => {
    const f = await optedIn(); const ready = Promise.withResolvers<number>(); const release = Promise.withResolvers<void>();
    const port = paymentPort();
    const creating = createService({ payments: { ...port, async createIntent(tx, command) {
      const result = await port.createIntent(tx, command);
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready.resolve(backend!.pid); await release.promise; return result;
    } } }).createTip(command(f));
    const pid = await ready.promise;
    const minimizing = db.update(paymentsReceivingAccountOnboarding).set({ accountNumberEnvelope: null, accountHolderLabelEnvelope: null, minimizedAt: now, updatedAt: now })
      .where(eq(paymentsReceivingAccountOnboarding.id, f.accountVersionId)).then(() => ({ minimized: true }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(async () => {
        const [blocked] = await db.execute<{ value: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as value`);
        expect(blocked?.value).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { release.resolve(); }
    await creating;
    expect(await minimizing).toMatchObject({ error: { cause: { message: "Tip receiving-account evidence is protected" } } });
    const [account] = await db.select().from(paymentsReceivingAccountOnboarding).where(eq(paymentsReceivingAccountOnboarding.id, f.accountVersionId));
    expect(account?.minimizedAt).toBeNull(); expect((await evidence(f)).intents).toHaveLength(1);
  });

  test("creation waiting on account minimization fails closed without financial facts", async () => {
    const f = await optedIn(); const ready = Promise.withResolvers<number>(); const release = Promise.withResolvers<void>();
    const minimizing = db.transaction(async (tx) => {
      await tx.update(paymentsReceivingAccountOnboarding).set({ accountNumberEnvelope: null, accountHolderLabelEnvelope: null, minimizedAt: now, updatedAt: now }).where(eq(paymentsReceivingAccountOnboarding.id, f.accountVersionId));
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready.resolve(backend!.pid); await release.promise;
    });
    const pid = await ready.promise;
    const creating = createService().createTip(command(f)).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(async () => {
        const [blocked] = await db.execute<{ value: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as value`);
        expect(blocked?.value).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { release.resolve(); }
    await minimizing; expect(await creating).toHaveProperty("error");
    const facts = await evidence(f); expect(facts.tipRows).toHaveLength(0); expect(facts.intents).toHaveLength(0); expect(facts.outbox).toHaveLength(0); expect(facts.audit).toHaveLength(0);
  });
});
