import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as schema from "@pawket/database";
import { createEncryptionKeyring, createLookupHmac, encryptSensitiveField } from "@pawket/security";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { vi } from "vitest";

import { fingerprintReceivingAccount } from "../src/receiving-account-policy.js";
import { createSePayConnectionService } from "../src/sepay-connection-service.js";
import { createSePayInboxService } from "../src/sepay-inbox-service.js";
import { createSePayReconciliationService } from "../src/sepay-reconciliation-service.js";
import type { SePayProviderBinding, SePayProviderCapabilities, SePayProviderPort } from "../src/sepay-provider.js";
import type { SePayAssurancePort } from "../src/sepay-service-support.js";

export { schema };
export const fixtureAt = new Date("2026-09-24T00:00:00.000Z");
export const fixtureKey = new Uint8Array(32).fill(39);
export const fixtureKeyring = createEncryptionKeyring({ activeKeyId: "sepay-services-test", keys: { "sepay-services-test": fixtureKey } });
export const fixtureHash = (value = randomUUID()) => createLookupHmac({ key: fixtureKey, context: "sepay-service-test", value });
export const fixtureEnvelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, plaintext: string) =>
  encryptSensitiveField({ keyring: fixtureKeyring, binding: { recordType, recordId, fieldName }, plaintext });
export const commandIds = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });
export const syntheticCapabilities: SePayProviderCapabilities = {
  oauthApplication: true, pkceS256: true, stableAccountIdentity: true,
  canonicalTransactionIdentity: true, bankTimeReference: true, remoteRevocation: false,
};

/** Synthetic provider only. This fixture never constructs the runtime provider or contacts SePay. */
export function syntheticProvider(binding: SePayProviderBinding, now: () => Date) {
  const grant = () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: new Date(now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
  return {
    environment: "test" as const, capabilities: syntheticCapabilities,
    authorizationUrl: vi.fn<SePayProviderPort["authorizationUrl"]>(({ state, codeChallenge }) => {
      const url = new URL("https://synthetic-provider.example.invalid/authorize");
      url.searchParams.set("state", state); url.searchParams.set("code_challenge", codeChallenge);
      return url.href;
    }),
    exchange: vi.fn<SePayProviderPort["exchange"]>(async () => grant()),
    refresh: vi.fn<SePayProviderPort["refresh"]>(async () => ({ ...grant(), accessToken: "synthetic-refreshed-access", refreshToken: "synthetic-rotated-refresh" })),
    discoverAccounts: vi.fn<SePayProviderPort["discoverAccounts"]>(async () => ({ kind: "complete", accounts: [{ ...binding, active: true, binding }] })),
    readback: vi.fn<SePayProviderPort["readback"]>(async ({ event }) => ({ kind: "complete", transactions: [{
      id: event.id, binding, amountVnd: event.amountVnd, direction: "in", occurredAt: event.occurredAt,
      reference: event.reference, referenceStatus: event.referenceStatus, bankReference: event.bankReference,
    }] })),
    revoke: vi.fn<NonNullable<SePayProviderPort["revoke"]>>(async () => "unverified"),
  };
}

export function createSePayIntegrationFixture(label: string) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for SePay service integration tests");
  const schemaName = `sepay_${label}_${process.pid}_${Date.now()}`;
  const journalSchema = `${schemaName}_journal`;
  const client = postgres(url, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
  const db = drizzle(client, { schema });
  async function initialize() {
    await client.unsafe(`create schema "${schemaName}"`);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
  }
  async function dispose() {
    await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
    await client.end();
  }
  async function creator(options: { accountNumber?: string } = {}) {
    const id = `sepay-test-${randomUUID()}`;
    const accountNumber = options.accountNumber ?? String(Math.floor(Math.random() * 10 ** 11)).padStart(12, "0");
    const accountVersionId = randomUUID(); const settingRevisionId = randomUUID();
    const accountFingerprint = fingerprintReceivingAccount({ bankBin: "970436", accountNumber, key: fixtureKey });
    await db.insert(schema.identityUsers).values({ id, name: "Synthetic creator", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: fixtureAt, updatedAt: fixtureAt });
    await db.insert(schema.paymentsReceivingAccountOnboarding).values({ id: accountVersionId, onboardingId: randomUUID(), applicantUserId: id, version: 1,
      bankBin: "970436", bankName: "Vietcombank", maskedSuffix: `•••• ${accountNumber.slice(-4)}`, accountFingerprint,
      accountNumberEnvelope: fixtureEnvelope("payments_receiving_account", accountVersionId, "account_number", accountNumber),
      accountHolderLabelEnvelope: fixtureEnvelope("payments_receiving_account", accountVersionId, "account_holder_label", "SYNTHETIC CREATOR"),
      proofState: "verified", proofVerifiedAt: fixtureAt, createdAt: fixtureAt, updatedAt: fixtureAt });
    await db.insert(schema.creatorTipSettingRevisions).values({ id: settingRevisionId, creatorUserId: id, revisionNumber: 1, enabled: true,
      platformPolicyRevisionId: schema.PLATFORM_TIP_POLICY_BOOTSTRAP_ID, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000],
      actorSessionId: "synthetic-session", requestId: randomUUID(), createdAt: fixtureAt });
    await db.insert(schema.creatorTipSettings).values({ creatorUserId: id, revisionId: settingRevisionId, createdAt: fixtureAt, updatedAt: fixtureAt });
    let clock = new Date(fixtureAt.getTime() + 60_000);
    const now = () => new Date(clock);
    const actor = { userId: id, sessionId: `synthetic-session-${randomUUID()}` };
    const assurance = { getTipSessionAssurance: vi.fn<SePayAssurancePort["getTipSessionAssurance"]>(async (_tx, requested, at) =>
      requested.userId === actor.userId && requested.sessionId === actor.sessionId
        ? { primaryAuthenticatedAt: at, totpEnrolled: false, totpVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 3_600_000) } : null) };
    const binding: SePayProviderBinding = { environment: "test", tenantId: `synthetic-tenant-${randomUUID()}`, accountId: "11",
      bankBin: "970436", bankGateway: "Vietcombank", accountNumber, subAccount: null };
    const provider = syntheticProvider(binding, now);
    const common = { db, keyring: fixtureKeyring, lookupHmacKey: fixtureKey, now, environment: "test" as const };
    const connectionInput = { ...common, paymentsMode: "sepay_optional" as const, appBaseUrl: "https://pawket.example.invalid",
      redirectUri: "https://pawket.example.invalid/api/v1/creator/sepay/callback", applicationRevision: "synthetic-revision", assurance, provider };
    const connections = createSePayConnectionService(connectionInput);
    const inbox = createSePayInboxService({ ...common, enabled: true });
    // A transactional domain port makes successful/failed Tips writes observable in the same commit.
    const tips = { completeTip: vi.fn<Parameters<typeof createSePayReconciliationService>[0]["tips"]["completeTip"]>(async (tx, command) => {
      const rows = await tx.update(schema.tips).set({ state: "completed", closedAt: command.at, updatedAt: command.at }).where(and(
        eq(schema.tips.id, command.tipId), eq(schema.tips.creatorUserId, command.creatorUserId), eq(schema.tips.amountVnd, command.amountVnd), eq(schema.tips.state, "awaiting_payment"),
      )).returning({ id: schema.tips.id });
      return rows.length === 1;
    }) };
    const reconciliationInput = { ...common, paymentsMode: "sepay_optional" as const, applicationRevision: "synthetic-revision",
      workerIdentity: "synthetic-worker", provider, connections, assurance, tips };
    const reconciliation = createSePayReconciliationService(reconciliationInput);
    const current = async () => {
      const [row] = await db.select().from(schema.paymentsSepayConnections).where(eq(schema.paymentsSepayConnections.creatorUserId, id));
      if (!row) throw new Error("Missing synthetic connection");
      return row;
    };
    const change = async (action: Parameters<typeof connections.change>[0]["action"]) => {
      const row = await current();
      return connections.change({ actor, connectionId: row.id, expectedVersion: row.version, action, ...commandIds() });
    };
    const start = async () => {
      const result = await connections.start({ actor, ...commandIds() });
      if (!result.authorizationUrl) throw new Error("Missing synthetic authorization URL");
      return new URL(result.authorizationUrl).searchParams.get("state")!;
    };
    const authorize = async () => {
      const state = await start();
      await connections.callback({ actor, state, code: "synthetic-code", requestId: randomUUID() });
      return current();
    };
    const connect = async () => {
      const row = await authorize();
      const result = await connections.bindAccount({ actor, connectionId: row.id, expectedVersion: row.version, providerAccountId: binding.accountId, ...commandIds() });
      if (!result.webhookSecret) throw new Error("Missing synthetic one-time secret");
      return { ...result, secret: result.webhookSecret };
    };
    const createIntent = async (cutoverId: string | null = null, amountVnd = 50_000) => {
      const tipId = randomUUID(); const intentId = randomUUID();
      const reference = `PW${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
      const createdAt = now(); const expiresAt = new Date(createdAt.getTime() + 86_400_000);
      const referenceHash = createLookupHmac({ key: fixtureKey, context: "tip-transfer-reference", value: reference });
      await db.transaction(async (tx) => {
        await tx.insert(schema.tips).values({ id: tipId, creatorUserId: id, buyerUserId: id, settingRevisionId,
          platformPolicyRevisionId: schema.PLATFORM_TIP_POLICY_BOOTSTRAP_ID, amountVnd,
          guestContentEnvelope: fixtureEnvelope("tips", tipId, "guest_content", JSON.stringify({ name: "Synthetic buyer", message: "Private fixture message" })), createdAt, updatedAt: createdAt });
        await tx.insert(schema.paymentIntents).values({ id: intentId, tipId, creatorUserId: id, amountVnd, accountVersionId,
          settlementLane: cutoverId ? "provider_bound" : "manual_attested", cutoverId, referenceHash, abuseKeyHash: fixtureHash(),
          referenceEnvelope: fixtureEnvelope("payment_intents", intentId, "transfer_reference", reference),
          destinationEnvelope: fixtureEnvelope("payment_intents", intentId, "destination", JSON.stringify({ version: 1, bankBin: binding.bankBin,
            bankName: "Vietcombank", accountNumber, accountName: "SYNTHETIC CREATOR", creator: { displayName: "Synthetic creator", handle: "synthetic-creator" } })),
          expiresAt, requestId: randomUUID(), createdAt, updatedAt: createdAt });
      });
      return { id: intentId, tipId, reference, referenceHash, amountVnd, createdAt, expiresAt };
    };
    const cutover = async () => {
      await change("enable_automation");
      const [row] = await db.select().from(schema.paymentsSepayAccountCutovers).where(eq(schema.paymentsSepayAccountCutovers.creatorUserId, id));
      if (!row) throw new Error("Missing synthetic cutover");
      return row;
    };
    const signed = (connectionId: string, secret: string, facts: Record<string, unknown>) => {
      const rawBody = Buffer.from(JSON.stringify(facts)); const timestamp = String(Math.floor(now().getTime() / 1_000));
      return { connectionId, rawBody, contentType: "application/json", timestamp,
        signature: `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}` };
    };
    const event = (reference: string, patch: Record<string, unknown> = {}) => ({
      id: String(Math.floor(Math.random() * 10 ** 12) + 1), gateway: binding.bankGateway, accountNumber, subAccount: null,
      transactionDate: new Date(now().getTime() + 7 * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      code: reference, content: `Synthetic tip ${reference}`, transferType: "in", transferAmount: 50_000, referenceCode: "SYNTHETIC-BANK-REFERENCE", ...patch,
    });
    return { actor, accountVersionId, accountFingerprint, accountNumber, binding, assurance, provider, common, connectionInput, connections,
      inbox, reconciliationInput, reconciliation, tips, now, setNow: (at: Date) => { clock = new Date(at); },
      advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); }, current, change, start, authorize, connect, createIntent, cutover, signed, event };
  }
  return { db, client, schemaName, initialize, dispose, creator };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
