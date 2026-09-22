import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  PLATFORM_TIP_POLICY_BOOTSTRAP_ID, acknowledgeOutboxEvent, createDatabase, creatorTipSettingRevisions, creatorTipSettings, identityEmailHandoffs, identityUsers,
  insertOutboxEvent, paymentGuestCapabilities, paymentIntents, paymentsReceivingAccountOnboarding, systemOutbox, tips,
} from "@pawket/database";
import { DeterministicLocalSecurityEmailSink } from "@pawket/identity/security-email";
import { expireTipPaymentIntents } from "@pawket/payments";
import { createTipExpiryPort } from "@pawket/tips";
import { createEncryptionKeyring, createLookupHmac, encryptSensitiveField } from "@pawket/security";
import { connectQueueProducer, connectQueueWorker, createQueueConnection, createWorkerConnection, dispatchOutboxBatch, SafeSystemQueue, type SystemOutboxJob } from "@pawket/queue";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const valkeyUrl = process.env.TEST_VALKEY_URL;
if (!databaseUrl || !valkeyUrl) throw new Error("TEST_DATABASE_URL and TEST_VALKEY_URL are required for tip worker integration tests");
const schemaName = `tip_worker_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const admin = createDatabase(databaseUrl);
const url = new URL(databaseUrl); url.searchParams.set("options", `-csearch_path=${schemaName},public`);
const database = createDatabase(url.toString()); const db = database.db;
const at = new Date(); const expiredAt = new Date(at.getTime() - 1);
const createdAt = new Date(at.getTime() - 300_001);
const key = new Uint8Array(32).fill(79); // Synthetic test-only key.
const keyring = createEncryptionKeyring({ activeKeyId: "worker-tip-test", keys: { "worker-tip-test": key } });
const hash = () => createLookupHmac({ key, context: "tip-worker-test", value: randomUUID() });
const envelope = (recordType: string, recordId: string, fieldName: string, plaintext: string) => encryptSensitiveField({ keyring, plaintext, binding: { recordType, recordId, fieldName } });

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create schema "${schemaName}"`));
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
});
afterAll(async () => {
  await database.close();
  await admin.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await admin.db.execute(sql.raw(`drop schema if exists "${journalSchema}" cascade`));
  await admin.close();
});

test("real PostgreSQL and Valkey retry a committed tip handoff and deliver expiry without changing payment evidence", async () => {
  const creatorUserId = `worker-artist-${randomUUID()}`; const settingId = randomUUID(); const accountId = randomUUID(); const tipId = randomUUID(); const intentId = randomUUID();
  const sourceId = await db.transaction(async (tx) => {
    await tx.insert(identityUsers).values({ id: creatorUserId, name: "Synthetic Artist", email: `${creatorUserId}@example.invalid`, canonicalEmail: `${creatorUserId}@example.invalid`,
      emailVerified: true, emailVerifiedAt: createdAt, emailVerificationProvenance: "password_email_challenge", createdAt, updatedAt: createdAt });
    await tx.insert(creatorTipSettingRevisions).values({ id: settingId, creatorUserId, revisionNumber: 1, enabled: true, platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000], actorSessionId: "synthetic", requestId: randomUUID(), createdAt });
    await tx.insert(creatorTipSettings).values({ creatorUserId, revisionId: settingId, createdAt, updatedAt: createdAt });
    await tx.insert(paymentsReceivingAccountOnboarding).values({ id: accountId, onboardingId: randomUUID(), applicantUserId: creatorUserId, version: 1, bankBin: "970436", bankName: "Vietcombank", maskedSuffix: "•••• 0001", accountFingerprint: hash(),
      accountNumberEnvelope: envelope("payments_receiving_account", accountId, "account_number", "000001"),
      accountHolderLabelEnvelope: envelope("payments_receiving_account", accountId, "account_holder_label", "SYNTHETIC ARTIST"),
      proofState: "verified", proofVerifiedAt: createdAt, createdAt, updatedAt: createdAt });
    await tx.insert(tips).values({ id: tipId, creatorUserId, settingRevisionId: settingId, platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, amountVnd: 50_000,
      guestContentEnvelope: envelope("tip", tipId, "guest_content", '{"name":"Synthetic Guest","message":"private synthetic message"}'), createdAt, updatedAt: createdAt });
    await tx.insert(paymentIntents).values({ id: intentId, tipId, creatorUserId, amountVnd: 50_000, referenceHash: hash(),
      referenceEnvelope: envelope("payment_intent", intentId, "transfer_reference", "PW00000000000000000001"),
      destinationEnvelope: envelope("payment_intent", intentId, "destination", '{"accountNumber":"000001"}'),
      accountVersionId: accountId, abuseKeyHash: hash(), expiresAt: expiredAt, requestId: randomUUID(), createdAt, updatedAt: createdAt });
    await tx.insert(paymentGuestCapabilities).values({ id: randomUUID(), paymentIntentId: intentId, capabilityHash: hash(), createdAt, expiresAt: new Date(at.getTime() + 604_800_000) });
    return insertOutboxEvent(tx, { eventType: "tip.created.v1", eventVersion: 1, aggregateType: "tip", aggregateId: tipId,
      payload: { tipId, creatorUserId, correlationId: randomUUID() }, occurredAt: createdAt });
  });
  // The unique queue name owns cleanup; no shared Valkey database is flushed.
  const queueName = `pawket.tip-test-${randomUUID()}`;
  const producer = createQueueConnection(valkeyUrl); const connection = createWorkerConnection(valkeyUrl);
  await connectQueueProducer(producer); await connectQueueWorker(connection);
  const queue = new SafeSystemQueue(queueName, { connection: producer });
  const sink = new DeterministicLocalSecurityEmailSink(); const logger = { info: vi.fn(), error: vi.fn() };
  let failFirstAcknowledgement = true;
  const worker = new Worker<SystemOutboxJob>(queueName, createWorkerJobProcessor({ database: db, logger, securityEmail: { keyring, sender: sink },
    async acknowledge(database, input) {
      if (input.eventId === sourceId && failFirstAcknowledgement) { failFirstAcknowledgement = false; throw new Error("synthetic failure after committed handoff"); }
      return acknowledgeOutboxEvent(database, input);
    },
  }), { connection, concurrency: 2 });
  try {
    await worker.waitUntilReady();
    expect(await expireTipPaymentIntents({ db, tips: createTipExpiryPort(), paymentsMode: "manual_only", batchSize: 10, now: at, applicationRevision: "synthetic-worker-revision" })).toEqual({ scanned: 1, expired: 1 });
    await vi.waitFor(async () => {
      await dispatchOutboxBatch({ db, queue }, { workerId: "synthetic-tip-dispatcher", batchSize: 20, leaseMs: 30_000 });
      const events = await db.select().from(systemOutbox);
      expect(events.length).toBe(6); // Two lifecycle sources, two emails, two in-app handoffs.
      expect(events.every((event) => event.publishedAt !== null)).toBe(true);
      expect(sink.snapshot()).toHaveLength(2);
    }, { timeout: 10_000, interval: 100 });
    const emails = await db.select().from(identityEmailHandoffs);
    expect(emails).toHaveLength(2); expect(emails.every((email) => email.status === "sent")).toBe(true);
    expect(emails.filter((email) => email.sourceOutboxEventId === sourceId)).toHaveLength(1);
    expect((await queue.getJob(sourceId))?.attemptsMade).toBe(2);
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId));
    const [tip] = await db.select().from(tips).where(eq(tips.id, tipId));
    expect(intent?.state).toBe("expired"); expect(tip?.state).toBe("expired");
    expect(JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.error.mock.calls)).not.toMatch(/private synthetic|000001|PW00000000000000000001|synthetic failure/u);
  } finally {
    await worker.close(); await queue.obliterate({ force: true }); await queue.close(); await producer.quit(); await connection.quit();
  }
}, 20_000);
