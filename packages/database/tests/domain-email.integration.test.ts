import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  adminAuditEvents,
  appendAdminAuditEvent,
  creatorApplicationDecisions,
  creatorApplicationRevisions,
  creatorApplications,
  findEmailHandoffBySourceEvent,
  identityEmailHandoffs,
  identityUsers,
  insertOutboxEvent,
  systemOutbox,
  type PawketDatabase,
} from "../src/index.js";
import * as schema from "../src/schema.js";
import { createEncryptionKeyring } from "@pawket/security";

import { materializeDomainEmailHandoff } from "../../../apps/worker/src/domain-email.js";
import { createWorkerJobProcessor } from "../../../apps/worker/src/worker-runtime.js";
import {
  deliverSecurityEmailHandoff,
  queueSecurityEmailHandoff,
} from "../../identity/src/security-email-handoff.js";
import type { SecurityEmailMessage } from "../../identity/src/security-email.js";
import { metricsRegistry } from "../../observability/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for domain email tests");

const keyring = createEncryptionKeyring({
  activeKeyId: "test-v1",
  keys: { "test-v1": Buffer.alloc(32, 7) },
});
const schemaName = `domain_email_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, {
  max: 1,
  connection: { search_path: `${schemaName},public` },
});
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../migrations/", import.meta.url);

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  for (const migration of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    await executeMigration(migration);
  }
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

afterEach(() => {
  vi.useRealTimers();
  metricsRegistry.resetMetrics();
});

describe("domain email materialization", () => {
  test("creates one encrypted application-outcome handoff for duplicate source delivery", async () => {
    const userId = `domain-email-${randomUUID()}`;
    const sourceOutboxEventId = randomUUID();
    const handoffId = randomUUID();
    const email = `artist-${randomUUID()}@example.com`;
    const now = new Date("2026-08-25T12:00:00.000Z");
    await db.insert(identityUsers).values({
      id: userId,
      name: "Artist",
      email,
      canonicalEmail: email,
      emailVerified: true,
      emailVerifiedAt: now,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: now,
      updatedAt: now,
    });
    const event = {
      outboxEventId: sourceOutboxEventId,
      eventType: "creator.application_outcome_email.v1",
      eventVersion: 1,
      aggregateType: "creator_application",
      aggregateId: randomUUID(),
      payload: { applicantUserId: userId, state: "approved" },
      occurredAt: now.toISOString(),
    };

    await expect(
      materializeDomainEmailHandoff({ db, event, keyring, now, id: () => handoffId }),
    ).resolves.toBe("created");
    await expect(
      materializeDomainEmailHandoff({ db, event, keyring, now, id: () => randomUUID() }),
    ).resolves.toBe("already_materialized");

    const handoff = await db.transaction((tx) =>
      findEmailHandoffBySourceEvent(tx, sourceOutboxEventId),
    );
    expect(handoff).toEqual(
      expect.objectContaining({
        id: handoffId,
        purpose: "application_outcome",
        userId,
        status: "pending",
        failureCode: null,
      }),
    );
    expect(JSON.stringify(handoff?.destinationEnvelope)).not.toContain(email);
    const deliveryEvents = (await db.select().from(systemOutbox)).filter(
      (row) => row.aggregateId === handoffId,
    );
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]?.payload).toEqual({ handoffId, purpose: "application_outcome" });
  });

  test("records durable attention when the current destination is not verified", async () => {
    const userId = `domain-email-${randomUUID()}`;
    const sourceOutboxEventId = randomUUID();
    const email = `unverified-${randomUUID()}@example.com`;
    const now = new Date("2026-08-25T12:00:00.000Z");
    await db.insert(identityUsers).values({
      id: userId,
      name: "Artist",
      email,
      canonicalEmail: email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      materializeDomainEmailHandoff({
        db,
        event: {
          outboxEventId: sourceOutboxEventId,
          eventType: "creator.capability_outcome_email.v1",
          eventVersion: 1,
          aggregateType: "creator_capability",
          aggregateId: randomUUID(),
          payload: { userId, state: "suspended" },
          occurredAt: now.toISOString(),
        },
        keyring,
        now,
      }),
    ).resolves.toBe("attention_required");

    const handoff = await db.transaction((tx) =>
      findEmailHandoffBySourceEvent(tx, sourceOutboxEventId),
    );
    expect(handoff).toEqual(
      expect.objectContaining({
        purpose: "creator_status",
        status: "attention_required",
        destinationEnvelope: null,
        failureCode: "no_verified_destination",
      }),
    );
  });

  test("materializes a reopened decision as a distinct bounded outcome while retaining the application state", async () => {
    // Break caught: mapping a reopen to the ordinary changes-requested email or forwarding review prose.
    const userId = `domain-email-${randomUUID()}`;
    const sourceOutboxEventId = randomUUID();
    const handoffId = randomUUID();
    const email = `reopened-${randomUUID()}@example.com`;
    const now = new Date("2026-08-25T12:00:00.000Z");
    await db.insert(identityUsers).values({
      id: userId,
      name: "Artist",
      email,
      canonicalEmail: email,
      emailVerified: true,
      emailVerifiedAt: now,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: now,
      updatedAt: now,
    });

    await expect(materializeDomainEmailHandoff({
      db,
      event: {
        outboxEventId: sourceOutboxEventId,
        eventType: "creator.application_outcome_email.v1",
        eventVersion: 1,
        aggregateType: "creator_application",
        aggregateId: randomUUID(),
        payload: {
          applicantUserId: userId,
          state: "changes_requested",
          decisionAction: "reopened",
          applicantExplanation: "private applicant-facing review prose",
          privateNote: "private owner note",
        },
        occurredAt: now.toISOString(),
      },
      keyring,
      now,
      id: () => handoffId,
    })).resolves.toBe("created");

    const [handoff] = await db.select().from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
    expect(handoff).toEqual(expect.objectContaining({
      id: handoffId,
      purpose: "application_outcome",
      templateData: { state: "reopened", returnPath: "/creator/apply" },
    }));
    expect(JSON.stringify(handoff)).not.toContain("private applicant-facing review prose");
    expect(JSON.stringify(handoff)).not.toContain("private owner note");
  });

  test("retries a provider-accepted reopen outcome without rolling back its committed domain facts", async () => {
    // Break caught: testing delivery against an unrelated row instead of the transaction that caused the email.
    const domainAt = new Date("2026-08-25T12:15:00.000Z");
    const firstDeliveryAt = new Date(domainAt.getTime() + 1);
    const applicationId = randomUUID();
    const revisionId = randomUUID();
    const artistUserId = `reopen-artist-${randomUUID()}`;
    const ownerUserId = `reopen-owner-${randomUUID()}`;
    const destination = `${artistUserId}@example.com`;
    const decisionExplanation = `private-explanation-${randomUUID()}`;
    const privateNote = `private-owner-note-${randomUUID()}`;
    const requestId = `reopen-request-${randomUUID()}`;
    const handoffId = randomUUID();
    await db.insert(identityUsers).values([
      {
        id: artistUserId,
        name: "Artist",
        email: destination,
        canonicalEmail: destination,
        emailVerified: true,
        emailVerifiedAt: domainAt,
        emailVerificationProvenance: "password_email_challenge",
        createdAt: domainAt,
        updatedAt: domainAt,
      },
      {
        id: ownerUserId,
        name: "Owner",
        email: `${ownerUserId}@example.com`,
        canonicalEmail: `${ownerUserId}@example.com`,
        emailVerified: true,
        emailVerifiedAt: domainAt,
        emailVerificationProvenance: "password_email_challenge",
        createdAt: domainAt,
        updatedAt: domainAt,
      },
    ]);
    await db.insert(creatorApplications).values({
      id: applicationId,
      userId: artistUserId,
      state: "rejected",
      version: 3,
      currentRevisionId: revisionId,
      rejectedAt: domainAt,
      cooldownUntil: domainAt,
      createdAt: domainAt,
      updatedAt: domainAt,
    });
    await db.insert(creatorApplicationRevisions).values({
      id: revisionId,
      applicationId,
      revisionNumber: 1,
      minimizedAt: domainAt,
      createdAt: domainAt,
      updatedAt: domainAt,
    });

    const sourceOutboxEventId = await db.transaction(async (tx) => {
      const reopened = await tx.update(creatorApplications).set({
        state: "changes_requested",
        version: 4,
        rejectedAt: null,
        cooldownUntil: null,
        updatedAt: domainAt,
      }).where(and(
        eq(creatorApplications.id, applicationId),
        eq(creatorApplications.version, 3),
      )).returning({ id: creatorApplications.id });
      if (reopened.length !== 1) throw new Error("Expected committed reopen transition");
      await tx.insert(creatorApplicationDecisions).values({
        id: randomUUID(),
        applicationId,
        revisionId,
        action: "reopened",
        reasonCode: "other",
        applicantExplanation: decisionExplanation,
        privateNote,
        actorUserId: ownerUserId,
        actorSessionId: "owner-session",
        stepUpProofId: randomUUID(),
        expectedVersion: 3,
        requestId,
        createdAt: domainAt,
      });
      await appendAdminAuditEvent(tx, {
        actorUserId: ownerUserId,
        actorSessionId: "owner-session",
        subjectType: "creator_application",
        subjectId: applicationId,
        action: "creator.application.reopen",
        outcome: "succeeded",
        reasonCode: "other",
        beforeState: { state: "rejected", version: 3 },
        afterState: { state: "changes_requested", version: 4 },
        assurance: { method: "totp", actionClass: "owner.creator_application_reopen" },
        applicationRevision: revisionId,
        requestId,
        occurredAt: domainAt,
      });
      const payload = {
        applicationId,
        applicantUserId: artistUserId,
        revisionId,
        state: "changes_requested",
        decisionAction: "reopened",
        correlationId: requestId,
      };
      await insertOutboxEvent(tx, {
        eventType: "creator.application_reopened.v1",
        eventVersion: 1,
        aggregateType: "creator_application",
        aggregateId: applicationId,
        payload,
        occurredAt: domainAt,
      });
      return insertOutboxEvent(tx, {
        eventType: "creator.application_outcome_email.v1",
        eventVersion: 1,
        aggregateType: "creator_application",
        aggregateId: applicationId,
        payload,
        occurredAt: domainAt,
      });
    });

    const readCommittedFacts = async () => ({
      application: await db.select({
        state: creatorApplications.state,
        version: creatorApplications.version,
      }).from(creatorApplications).where(eq(creatorApplications.id, applicationId)),
      decisions: await db.select({
        action: creatorApplicationDecisions.action,
        requestId: creatorApplicationDecisions.requestId,
      }).from(creatorApplicationDecisions).where(eq(creatorApplicationDecisions.applicationId, applicationId)),
      audits: await db.select({
        action: adminAuditEvents.action,
        outcome: adminAuditEvents.outcome,
        requestId: adminAuditEvents.requestId,
        beforeState: adminAuditEvents.beforeState,
        afterState: adminAuditEvents.afterState,
      }).from(adminAuditEvents).where(eq(adminAuditEvents.subjectId, applicationId)),
      outbox: (await db.select({
        eventType: systemOutbox.eventType,
        payload: systemOutbox.payload,
      }).from(systemOutbox).where(eq(systemOutbox.aggregateId, applicationId)))
        .sort((left, right) => left.eventType.localeCompare(right.eventType)),
    });
    const committedFacts = await readCommittedFacts();
    expect(committedFacts.application).toEqual([{ state: "changes_requested", version: 4 }]);
    expect(committedFacts.decisions).toEqual([{ action: "reopened", requestId }]);
    expect(committedFacts.audits).toEqual([expect.objectContaining({
      action: "creator.application.reopen",
      outcome: "succeeded",
      requestId,
    })]);

    const [sourceEvent] = await db.select().from(systemOutbox)
      .where(eq(systemOutbox.id, sourceOutboxEventId));
    if (!sourceEvent) throw new Error("Expected committed reopen email outcome");
    await expect(materializeDomainEmailHandoff({
      db,
      event: {
        outboxEventId: sourceEvent.id,
        eventType: sourceEvent.eventType,
        eventVersion: sourceEvent.eventVersion,
        aggregateType: sourceEvent.aggregateType,
        aggregateId: sourceEvent.aggregateId,
        payload: sourceEvent.payload,
        occurredAt: sourceEvent.occurredAt.toISOString(),
      },
      keyring,
      now: firstDeliveryAt,
      id: () => handoffId,
    })).resolves.toBe("created");

    const providerDetail = `smtp-provider-private-${randomUUID()}`;
    const providerCalls: Array<{ handoffId: string; state: string | undefined }> = [];
    const sender = {
      async send(message: SecurityEmailMessage) {
        providerCalls.push({ handoffId: message.handoffId, state: message.templateData.state });
        if (providerCalls.length === 1) throw new Error(providerDetail);
      },
    };
    let firstError: unknown;
    try {
      await deliverSecurityEmailHandoff(db, {
        handoffId,
        workerId: sourceOutboxEventId,
        keyring,
        sender,
        now: firstDeliveryAt,
      });
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toMatchObject({ message: "Security email delivery failed" });
    expect(JSON.stringify(firstError)).not.toContain(providerDetail);
    expect(await readCommittedFacts()).toEqual(committedFacts);

    const finalDeliveryAt = new Date(firstDeliveryAt.getTime() + 60_001);
    await expect(deliverSecurityEmailHandoff(db, {
      handoffId,
      workerId: sourceOutboxEventId,
      keyring,
      sender,
      now: finalDeliveryAt,
    })).resolves.toBe("delivered");
    expect(await readCommittedFacts()).toEqual(committedFacts);
    expect(providerCalls).toEqual([
      { handoffId, state: "reopened" },
      { handoffId, state: "reopened" },
    ]);
    const [delivered] = await db.select({
      id: identityEmailHandoffs.id,
      status: identityEmailHandoffs.status,
      attempts: identityEmailHandoffs.attempts,
      sentAt: identityEmailHandoffs.sentAt,
      templateData: identityEmailHandoffs.templateData,
    }).from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
    expect(delivered).toEqual({
      id: handoffId,
      status: "sent",
      attempts: 2,
      sentAt: finalDeliveryAt,
      templateData: { state: "reopened", returnPath: "/creator/apply" },
    });
    expect(JSON.stringify(delivered)).not.toContain(decisionExplanation);
    expect(JSON.stringify(delivered)).not.toContain(privateNote);
  });

  test.each([
    ["malformed", { state: "changes_requested", decisionAction: { privateNote: "must-not-escape" } }],
    ["unknown", { state: "changes_requested", decisionAction: "reopened_with_private_detail" }],
    ["mismatched", { state: "approved", decisionAction: "reopened" }],
  ] as const)("fails closed for a %s application outcome without writing email work", async (_case, outcome) => {
    // Characterization guard: invalid projections must fail before either durable email row is written.
    const userId = `invalid-domain-email-${randomUUID()}`;
    const sourceOutboxEventId = randomUUID();
    const now = new Date("2026-08-25T12:30:00.000Z");
    await db.insert(identityUsers).values({
      id: userId,
      name: "Artist",
      email: `${userId}@example.com`,
      canonicalEmail: `${userId}@example.com`,
      emailVerified: true,
      emailVerifiedAt: now,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: now,
      updatedAt: now,
    });
    const handoffsBefore = (await db.select({ id: identityEmailHandoffs.id }).from(identityEmailHandoffs)).length;
    const outboxBefore = (await db.select({ id: systemOutbox.id }).from(systemOutbox)).length;

    await expect(materializeDomainEmailHandoff({
      db,
      event: {
        outboxEventId: sourceOutboxEventId,
        eventType: "creator.application_outcome_email.v1",
        eventVersion: 1,
        aggregateType: "creator_application",
        aggregateId: randomUUID(),
        payload: { applicantUserId: userId, ...outcome },
        occurredAt: now.toISOString(),
      },
      keyring,
      now,
    })).rejects.toThrow("Invalid domain email event");

    expect(await db.transaction((tx) => findEmailHandoffBySourceEvent(tx, sourceOutboxEventId))).toBeUndefined();
    expect((await db.select({ id: identityEmailHandoffs.id }).from(identityEmailHandoffs))).toHaveLength(handoffsBefore);
    expect((await db.select({ id: systemOutbox.id }).from(systemOutbox))).toHaveLength(outboxBefore);
  });

  test("bounds acknowledgement-unknown SMTP sends at three attempts and acknowledges durable attention", async () => {
    // Break caught: endless provider sends, retaining delivery material after terminal uncertainty, or leaking provider text.
    metricsRegistry.resetMetrics();
    const firstAttemptAt = new Date("2026-08-25T13:00:00.000Z");
    let deliveryNow = firstAttemptAt;
    const userId = `domain-email-${randomUUID()}`;
    const handoffId = randomUUID();
    const destination = `lost-ack-${randomUUID()}@example.com`;
    const secret = `secret-${randomUUID()}`;
    const providerDetail = `smtp-provider-detail-${randomUUID()}`;
    await db.insert(identityUsers).values({
      id: userId,
      name: "Artist",
      email: destination,
      canonicalEmail: destination,
      emailVerified: true,
      emailVerifiedAt: firstAttemptAt,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: firstAttemptAt,
      updatedAt: firstAttemptAt,
    });
    await db.transaction((tx) => queueSecurityEmailHandoff(tx, {
      id: handoffId,
      userId,
      purpose: "password_reset",
      destination,
      secret,
      templateData: { returnPath: "/reset-password" },
      keyring,
      now: firstAttemptAt,
    }));
    const [event] = (await db.select().from(systemOutbox)).filter((row) => row.aggregateId === handoffId);
    if (!event) throw new Error("Expected the durable delivery event");
    const deliveryJob = {
      id: event.id,
      name: "system.outbox-event",
      data: {
        outboxEventId: event.id,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
        occurredAt: event.occurredAt.toISOString(),
      },
    };
    const providerCalls: Array<Record<string, unknown>> = [];
    const logs: Array<Record<string, unknown>> = [];
    const acknowledge = vi.fn(async () => true);
    const processor = createWorkerJobProcessor({
      logger: {
        info() {},
        error(data, message) { logs.push({ ...data, message }); },
      },
      database: db,
      acknowledge,
      securityEmail: {
        keyring,
        deliver: (database, input) => deliverSecurityEmailHandoff(database, { ...input, now: deliveryNow }),
        sender: {
          async send(message) {
            providerCalls.push({ ...message, templateData: { ...message.templateData } });
            throw new Error(providerDetail);
          },
        },
      },
    });

    const errors: unknown[] = [];
    for (const attemptAt of [
      firstAttemptAt,
      new Date(firstAttemptAt.getTime() + 60_001),
    ]) {
      deliveryNow = attemptAt;
      try {
        await processor(deliveryJob as never);
      } catch (error) {
        errors.push(error);
      }
      const [retryable] = await db.select({
        status: identityEmailHandoffs.status,
        attempts: identityEmailHandoffs.attempts,
        availableAt: identityEmailHandoffs.availableAt,
        sentAt: identityEmailHandoffs.sentAt,
        failureCode: identityEmailHandoffs.failureCode,
      }).from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
      expect(retryable).toEqual({
        status: "failed",
        attempts: errors.length,
        availableAt: new Date(attemptAt.getTime() + 60_000),
        sentAt: null,
        failureCode: "delivery_outcome_unknown",
      });
      expect(acknowledge).not.toHaveBeenCalled();
    }
    expect(errors).toHaveLength(2);
    expect(errors).toEqual([
      expect.objectContaining({ message: "Worker job processing failed" }),
      expect.objectContaining({ message: "Worker job processing failed" }),
    ]);

    deliveryNow = new Date(firstAttemptAt.getTime() + 120_002);
    await expect(processor(deliveryJob as never)).resolves.toBeUndefined();

    const [terminal] = await db.select({
      id: identityEmailHandoffs.id,
      status: identityEmailHandoffs.status,
      attempts: identityEmailHandoffs.attempts,
      destinationEnvelope: identityEmailHandoffs.destinationEnvelope,
      secretEnvelope: identityEmailHandoffs.secretEnvelope,
      sentAt: identityEmailHandoffs.sentAt,
      failureCode: identityEmailHandoffs.failureCode,
      lockedAt: identityEmailHandoffs.lockedAt,
      lockedBy: identityEmailHandoffs.lockedBy,
      leaseExpiresAt: identityEmailHandoffs.leaseExpiresAt,
    }).from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
    expect(terminal).toEqual({
      id: handoffId,
      status: "attention_required",
      attempts: 3,
      destinationEnvelope: null,
      secretEnvelope: null,
      sentAt: null,
      failureCode: "delivery_outcome_unknown_retry_limit",
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
    });
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls.map((call) => call.handoffId)).toEqual([handoffId, handoffId, handoffId]);
    expect(acknowledge).toHaveBeenCalledOnce();

    const metrics = await metricsRegistry.metrics();
    const safeSnapshot = JSON.stringify({
      job: deliveryJob,
      logs,
      metrics,
      errors: errors.map((error) => error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error),
    });
    for (const prohibited of [destination, secret, providerDetail]) {
      expect(safeSnapshot).not.toContain(prohibited);
    }
    expect(metrics).toContain('pawket_security_emails_total{purpose="password_reset",outcome="retryable_failure"} 2');
    expect(metrics).toContain('pawket_security_emails_total{purpose="password_reset",outcome="attention_required"} 1');
    expect(metrics).not.toContain('pawket_security_emails_total{purpose="password_reset",outcome="sent"}');

    deliveryNow = new Date(firstAttemptAt.getTime() + 180_003);
    await expect(processor(deliveryJob as never)).resolves.toBeUndefined();
    expect(providerCalls).toHaveLength(3);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  test("fails closed when a sender completion no longer owns the claimed lease", async () => {
    // Characterization guard: a stale completion must never terminalize a lease now owned by another worker.
    const now = new Date("2026-08-25T14:00:00.000Z");
    const userId = `lease-owner-${randomUUID()}`;
    const handoffId = randomUUID();
    const destination = `${userId}@example.com`;
    const secret = `lease-secret-${randomUUID()}`;
    const providerDetail = `lease-provider-detail-${randomUUID()}`;
    await db.insert(identityUsers).values({
      id: userId,
      name: "Artist",
      email: destination,
      canonicalEmail: destination,
      emailVerified: true,
      emailVerifiedAt: now,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: now,
      updatedAt: now,
    });
    await db.transaction((tx) => queueSecurityEmailHandoff(tx, {
      id: handoffId,
      userId,
      purpose: "password_reset",
      destination,
      secret,
      keyring,
      now,
    }));
    await db.update(identityEmailHandoffs).set({
      status: "failed",
      attempts: 2,
      failureCode: "delivery_outcome_unknown",
    }).where(eq(identityEmailHandoffs.id, handoffId));

    await expect(deliverSecurityEmailHandoff(db, {
      handoffId,
      workerId: "original-worker",
      keyring,
      now,
      sender: {
        async send() {
          await db.update(identityEmailHandoffs).set({ lockedBy: "new-owner" })
            .where(eq(identityEmailHandoffs.id, handoffId));
          throw new Error(providerDetail);
        },
      },
    })).rejects.toThrow("Security email delivery failed");

    const [row] = await db.select().from(identityEmailHandoffs)
      .where(eq(identityEmailHandoffs.id, handoffId));
    expect(row).toEqual(expect.objectContaining({
      id: handoffId,
      status: "processing",
      attempts: 3,
      lockedBy: "new-owner",
      sentAt: null,
      failureCode: "delivery_outcome_unknown",
    }));
    expect(row?.destinationEnvelope).not.toBeNull();
    expect(row?.secretEnvelope).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(providerDetail);
  });
});
