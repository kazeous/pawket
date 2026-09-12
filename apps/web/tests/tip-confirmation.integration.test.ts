import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  adminAuditEvents, createDatabase, creatorDiscoveryProjections, creatorHandleClaims, creatorPages,
  creatorPublicationRevisions, identityUsers,
  paymentsReceivingAccountOnboarding, systemCommandIdempotency, systemOutbox, tips, paymentIntents, paymentGuestCapabilities, paymentConfirmations, identitySessions, identityTotpAuthenticators, identityRoleGrants, type PawketDatabase,
} from "@pawket/database";
import { createCreatorTipSettingsService, createPublicCatalogQuery, type CreatorSeed } from "@pawket/catalog";
import { createIdentityCreatorTipAccountPort, createIdentityTipBuyerAccountPort, createIdentityTipAssurancePort } from "@pawket/identity";
import { createTipReceivingAccountEligibilityPort, fingerprintReceivingAccount, createTipPaymentIntentPort, createTipReceiptService, createCreatorTipPaymentService } from "@pawket/payments";
import { createEncryptionKeyring, encryptSensitiveField, createLookupHmac } from "@pawket/security";

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
  return createCreatorTipSettingsService({
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


import { createTipService, createTipAccessPort, createTipLifecyclePort, type CreateTipCommand } from "@pawket/tips";

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
  return createTipService({ db, creatorEligibility: service(), payments: paymentPort(), buyerAccounts: createIdentityTipBuyerAccountPort(),
    paymentsMode: "manual_only", publishingMode: "general_audience", keyring, lookupHmacKey: key, idempotencyTtlMs: 604_800_000, now: () => at, ...overrides });
}
function receiptService(overrides: Partial<Parameters<typeof createTipReceiptService>[0]> = {}) {
  return createTipReceiptService({ db, paymentsMode: "manual_only", keyring, lookupHmacKey: key, tips: createTipAccessPort(),
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
  return createCreatorTipPaymentService({ db, keyring, lookupHmacKey: key, paymentsMode: "manual_only", pageSize: 25, recentAuthMs: 900_000, totpAuthMs: 300_000,
    assurance: createIdentityTipAssurancePort(), tips: createTipLifecyclePort({ keyring }), now: () => at, ...overrides });
}
async function pending(options: Parameters<typeof session>[1] = {}) {
  const f = await optedIn(); const actor = await session(f, options); const c = command(f); const created = await createService().createTip(c);
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
