import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  findEmailHandoffBySourceEvent,
  identityUsers,
  systemOutbox,
  type PawketDatabase,
} from "../src/index.js";
import * as schema from "../src/schema.js";
import { createEncryptionKeyring } from "@pawket/security";

import { materializeDomainEmailHandoff } from "../../../apps/worker/src/domain-email.js";

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
});
