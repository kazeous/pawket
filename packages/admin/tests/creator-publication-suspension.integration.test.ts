import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { createCatalogService, createPublicCatalogQuery } from "@pawket/catalog";
import { type PawketDatabase } from "@pawket/database";
import * as schema from "@pawket/database";
import { createIdentityCreatorSeedPort } from "@pawket/identity";
import { createEncryptionKeyring } from "@pawket/security";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import * as admin from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for admin integration tests");

const schemaName = `admin_creator_publication_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 5, connection: { search_path: `${schemaName},public` } });
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const occurredAt = new Date("2026-08-31T04:00:00.000Z");
const ownerUserId = "publication-review-owner";
const creatorUserId = "publication-review-artist";
const applicationId = "13000000-0000-4000-8000-000000000001";
const applicationRevisionId = "13000000-0000-4000-8000-000000000002";
const capabilityId = "13000000-0000-4000-8000-000000000003";
const pageId = "13000000-0000-4000-8000-000000000004";
const publicationRevisionId = "13000000-0000-4000-8000-000000000005";
const canonicalHandle = "atomic-artist";
const fingerprintKey = new Uint8Array(32).fill(19);
const keyring = createEncryptionKeyring({ activeKeyId: "test-v1", keys: { "test-v1": new Uint8Array(32).fill(17) } });

type Transition = Readonly<{
  creatorUserId: string;
  action: "suspend" | "reinstate";
  actorUserId: string;
  actorSessionId: string;
  reasonCode: string;
  requestId: string;
  occurredAt: Date;
}>;

type TransitionPort = Readonly<{
  apply(tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0], transition: Transition): Promise<{ pageId: string | null; previousPublishedRevisionId: string | null }>;
}>;

type ReviewFactory = Readonly<{
  createCreatorReviewService(input: Record<string, unknown>): Readonly<{
    setCreatorCapability(command: ReturnType<typeof capabilityCommand>): Promise<{ state: string }>;
  }>;
}>;

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

const creatorSeeds = createIdentityCreatorSeedPort();
const catalog = createCatalogService({
  db,
  creatorSeeds,
  publishingMode: "general_audience",
  commandFingerprintKey: fingerprintKey,
  now: () => occurredAt,
});
const publicCatalog = createPublicCatalogQuery({
  db,
  creatorSeeds,
  publishingMode: "general_audience",
  mediaCatalog: {
    async resolveReadyAssets() { return new Map(); },
    async resolveReadyAssetsBatch() { return new Map(); },
  },
  visibility: {
    async readHolds() { return { pageHeld: false, heldShowcaseIds: new Set<string>() }; },
    async readHoldsBatch(_database, requests) {
      return new Map(requests.map((request) => [request.pageId, { pageHeld: false, heldShowcaseIds: new Set<string>() }] as const));
    },
  },
});

function catalogTransitionPort(): TransitionPort {
  return {
    async apply(tx, transition) {
      const result = await catalog.clearPublishedHeadForSuspension(tx, {
        creatorUserId: transition.creatorUserId,
        actorUserId: transition.actorUserId,
        actorSessionId: transition.actorSessionId,
        reasonCode: transition.reasonCode,
        requestId: transition.requestId,
        occurredAt: transition.occurredAt,
      });
      if (transition.action === "reinstate" && result.previousPublishedRevisionId !== null) {
        throw new Error("catalog publication head must remain clear during reinstatement");
      }
      return result;
    },
  };
}

function review(port: TransitionPort = catalogTransitionPort()) {
  const factory = admin as unknown as ReviewFactory;
  return factory.createCreatorReviewService({
    db,
    keyring,
    commandFingerprintKey: fingerprintKey,
    consumeStepUpProof: async () => true,
    catalogCapabilityTransition: port,
    now: () => occurredAt,
  });
}

function capabilityCommand(action: "suspend" | "reinstate", suffix: string = action) {
  return {
    ownerUserId,
    ownerSessionId: "owner-session",
    stepUpProofId: action === "suspend" ? "13000000-0000-4000-8000-000000000006" : "13000000-0000-4000-8000-000000000007",
    userId: creatorUserId,
    action,
    reasonCode: "other",
    applicantExplanation: action === "suspend" ? "Creator access is temporarily suspended." : "Creator access is restored.",
    privateNote: "Internal reportDetail bank payment portfolio signedUrl objectKey filename note.",
    idempotencyKey: `${action}-publication-${suffix}`,
    requestId: `${action}-publication-${suffix}`,
  } as const;
}

async function seedPublishedCreator(): Promise<void> {
  const at = occurredAt.toISOString();
  await client`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values
      (${ownerUserId}, 'Owner', 'publication-owner@pawket.test', 'publication-owner@pawket.test', true,
       ${at}, 'password_email_challenge', 'active', 1, ${at}, ${at}),
      (${creatorUserId}, 'Atomic Artist', 'atomic-artist@pawket.test', 'atomic-artist@pawket.test', true,
       ${at}, 'password_email_challenge', 'active', 1, ${at}, ${at})`;
  await client`
    insert into creator_applications
      (id, user_id, state, version, current_revision_id, created_at, updated_at)
    values (${applicationId}, ${creatorUserId}, 'approved', 1, null, ${at}, ${at})`;
  await client`
    insert into creator_application_revisions
      (id, application_id, revision_number, artist_display_name, short_introduction,
       created_at, updated_at)
    values (${applicationRevisionId}, ${applicationId}, 1, 'Atomic Artist', 'Atomic introduction.', ${at}, ${at})`;
  await client`update creator_applications set current_revision_id = ${applicationRevisionId} where id = ${applicationId}`;
  await client`
    insert into identity_creator_capabilities
      (id, user_id, state, version, approved_application_id, approved_revision_id,
       suspended_at, created_at, updated_at)
    values (${capabilityId}, ${creatorUserId}, 'active', 1, ${applicationId}, ${applicationRevisionId}, null, ${at}, ${at})`;
  await client`
    insert into creator_pages
      (id, user_id, draft_version, published_revision_id, initialized_from_revision_id, created_at, updated_at)
    values (${pageId}, ${creatorUserId}, 1, null, ${applicationRevisionId}, ${at}, ${at})`;
  await client`
    insert into creator_publication_revisions
      (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
       primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
       actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
    values (${publicationRevisionId}, ${pageId}, 1, ${canonicalHandle}, 'Atomic Artist', 'Atomic introduction.',
      'illustration', array[]::text[], 'creator-discipline-v1', 'general-audience-v1',
      ${creatorUserId}, 'creator-session', 1, 'seed-publication', ${at})`;
  await client`
    insert into creator_publication_events
      (id, page_id, revision_id, type, actor_user_id, actor_session_id,
       expected_draft_version, request_id, occurred_at)
    values (${randomUUID()}, ${pageId}, ${publicationRevisionId}, 'published', ${creatorUserId},
      'creator-session', 1, 'seed-publication-event', ${at})`;
  await client`update creator_pages set published_revision_id = ${publicationRevisionId} where id = ${pageId}`;
  await client`
    insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at)
    values (${randomUUID()}, ${pageId}, ${canonicalHandle}, 'canonical', ${at})`;
  await client`
    insert into creator_discovery_projections
      (page_id, revision_id, canonical_handle, display_name, short_introduction,
       disciplines, revision_at, enabled)
    values (${pageId}, ${publicationRevisionId}, ${canonicalHandle}, 'Atomic Artist', 'Atomic introduction.',
      array['illustration']::text[], ${at}, true)`;
}

async function readState() {
  const [row] = await client<{ capability_state: string; capability_version: number; published_revision_id: string | null; discovery_enabled: boolean }[]>`
    select capability.state as capability_state, capability.version as capability_version,
      page.published_revision_id::text, projection.enabled as discovery_enabled
    from identity_creator_capabilities capability
    join creator_pages page on page.user_id = capability.user_id
    join creator_discovery_projections projection on projection.page_id = page.id
    where capability.user_id = ${creatorUserId}`;
  return row!;
}

async function installFailure(point: "identity_update" | "catalog_clear" | "catalog_assertion" | "audit_insert" | "outbox_insert") {
  const target = point === "identity_update" ? "identity_creator_capabilities"
    : point === "catalog_clear" || point === "catalog_assertion" ? "creator_discovery_projections"
      : point === "audit_insert" ? "admin_audit_events" : "system_outbox";
  const operation = point === "identity_update" || point === "catalog_clear" || point === "catalog_assertion" ? "UPDATE" : "INSERT";
  const functionName = `task13_fail_${point}_${randomUUID().replaceAll("-", "")}`;
  const triggerName = `${functionName}_trigger`;
  await client.unsafe(`create function "${functionName}"() returns trigger language plpgsql as $$ begin raise exception 'injected ${point} failure' using errcode = '55000'; end; $$`);
  await client.unsafe(`create trigger "${triggerName}" before ${operation} on "${target}" for each row execute function "${functionName}"()`);
  return async () => {
    await client.unsafe(`drop trigger if exists "${triggerName}" on "${target}"`);
    await client.unsafe(`drop function if exists "${functionName}"()`);
  };
}

beforeAll(async () => {
  await client.unsafe(`create schema if not exists "${schemaName}"`);
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) await executeMigration(migration);
});

beforeEach(async () => {
  const tables = await client<{ tablename: string }[]>`select tablename from pg_tables where schemaname = ${schemaName}`;
  for (const { tablename } of tables) await client.unsafe(`truncate table "${schemaName}"."${tablename}" cascade`);
  await seedPublishedCreator();
});

afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("atomic creator capability and publication transition", () => {
  test("suspension changes capability and clears publication in one transaction", async () => {
    // Break caught: Admin commits Identity suspension without invoking Catalog to clear public publication state.
    await expect(review().setCreatorCapability(capabilityCommand("suspend"))).resolves.toEqual({ state: "suspended" });
    expect(await readState()).toEqual({ capability_state: "suspended", capability_version: 2, published_revision_id: null, discovery_enabled: false });
    expect(await publicCatalog.resolvePublicCreator(canonicalHandle)).toEqual({ kind: "not_found" });
    const events = await client<{ type: string }[]>`
      select type from creator_publication_events where page_id = ${pageId} order by occurred_at, type`;
    expect(events.map((event) => event.type)).toEqual(["published", "suspension_unpublish"]);
  });

  test.each(["identity_update", "catalog_clear", "audit_insert", "outbox_insert"] as const)(
    "failure at %s rolls back capability and head together",
    async (failurePoint) => {
      // Break caught: a failure between Identity, Catalog, audit, or outbox commits only one side of suspension.
      const removeFailure = await installFailure(failurePoint);
      try {
        await expect(review().setCreatorCapability(capabilityCommand("suspend", failurePoint))).rejects.toThrow();
      } finally {
        await removeFailure();
      }
      expect(await readState()).toEqual({ capability_state: "active", capability_version: 1, published_revision_id: publicationRevisionId, discovery_enabled: true });
    },
  );

  test("reinstatement leaves published head null", async () => {
    // Break caught: capability reinstatement automatically restores the revision cleared by suspension.
    const service = review();
    await service.setCreatorCapability(capabilityCommand("suspend", "before-reinstate"));
    await expect(service.setCreatorCapability(capabilityCommand("reinstate"))).resolves.toEqual({ state: "active" });
    expect(await readState()).toEqual({ capability_state: "active", capability_version: 3, published_revision_id: null, discovery_enabled: false });
  });

  test.each(["identity_update", "catalog_assertion", "audit_insert", "outbox_insert"] as const)(
    "reinstatement failure at %s rolls back to suspended with no head",
    async (failurePoint) => {
      // Break caught: failed reinstatement activates Identity or recreates public state despite a downstream failure.
      const service = review();
      await service.setCreatorCapability(capabilityCommand("suspend", `before-${failurePoint}`));
      const removeFailure = await installFailure(failurePoint);
      try {
        await expect(service.setCreatorCapability(capabilityCommand("reinstate", failurePoint))).rejects.toThrow();
      } finally {
        await removeFailure();
      }
      expect(await readState()).toEqual({ capability_state: "suspended", capability_version: 2, published_revision_id: null, discovery_enabled: false });
    },
  );

  test("capability audit and outbox payloads contain identifiers and states only", async () => {
    // Break caught: applicant-facing explanations, private owner notes, profile copy, media/storage facts, or payment data enter durable capability events.
    await review().setCreatorCapability(capabilityCommand("suspend", "safe-payload"));
    const [audit] = await client<{ before_state: unknown; after_state: unknown }[]>`
      select before_state, after_state from admin_audit_events
      where action = 'creator.capability.suspend' order by occurred_at desc limit 1`;
    const outbox = await client<{ event_type: string; payload: unknown }[]>`
      select event_type, payload from system_outbox
      where aggregate_type in ('creator_capability', 'creator_page') order by occurred_at, id`;
    const payloads = JSON.stringify({ audit, outbox });
    expect(payloads).not.toMatch(/displayName|introduction|reportDetail|filename|signedUrl|objectKey|applicantEmail|portfolio|bank|payment/i);
    expect(audit).toEqual({
      before_state: { state: "active", version: 1, pageId, publishedRevisionId: publicationRevisionId },
      after_state: { state: "suspended", version: 2, pageId, publishedRevisionId: null },
    });
  });
});
