import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  findEmailHandoffBySourceEvent,
  identityEmailHandoffs,
  identityUsers,
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

  test("retries an acknowledgement-unknown SMTP delivery with one durable sent row and safe observability", async () => {
    // Break caught: claiming single-send delivery, losing the stable handoff ID, or leaking delivery material on retry.
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
            if (providerCalls.length === 1) throw new Error(providerDetail);
          },
        },
      },
    });

    let firstError: unknown;
    try {
      await processor(deliveryJob as never);
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toMatchObject({ message: "Worker job processing failed" });
    const [unknownOutcome] = await db.select({
      status: identityEmailHandoffs.status,
      attempts: identityEmailHandoffs.attempts,
      availableAt: identityEmailHandoffs.availableAt,
      sentAt: identityEmailHandoffs.sentAt,
      failureCode: identityEmailHandoffs.failureCode,
    }).from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
    expect(unknownOutcome).toEqual({
      status: "failed",
      attempts: 1,
      availableAt: new Date(firstAttemptAt.getTime() + 60_000),
      sentAt: null,
      failureCode: "delivery_outcome_unknown",
    });
    expect(acknowledge).not.toHaveBeenCalled();

    deliveryNow = new Date(firstAttemptAt.getTime() + 60_001);
    await expect(processor(deliveryJob as never)).resolves.toBeUndefined();

    const [delivered] = await db.select({
      status: identityEmailHandoffs.status,
      attempts: identityEmailHandoffs.attempts,
      sentAt: identityEmailHandoffs.sentAt,
      failureCode: identityEmailHandoffs.failureCode,
    }).from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
    expect(delivered).toEqual({
      status: "sent",
      attempts: 2,
      sentAt: new Date(firstAttemptAt.getTime() + 60_001),
      failureCode: null,
    });
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls.map((call) => call.handoffId)).toEqual([handoffId, handoffId]);
    expect(acknowledge).toHaveBeenCalledOnce();

    const metrics = await metricsRegistry.metrics();
    const safeSnapshot = JSON.stringify({
      job: deliveryJob,
      logs,
      metrics,
      error: firstError instanceof Error ? { name: firstError.name, message: firstError.message, stack: firstError.stack } : firstError,
    });
    for (const prohibited of [destination, secret, providerDetail]) {
      expect(safeSnapshot).not.toContain(prohibited);
    }
    expect(metrics).toContain('pawket_security_emails_total{purpose="password_reset",outcome="retryable_failure"} 1');
    expect(metrics).toContain('pawket_security_emails_total{purpose="password_reset",outcome="sent"} 1');
  });
});
