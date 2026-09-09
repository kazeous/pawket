import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createCatalogMediaOwnershipPort, createCatalogService } from "@pawket/catalog";
import { createDatabase, creatorApplications, creatorApplicationRevisions, creatorPages, identityCreatorCapabilities, identityRoleGrants, identitySessions, identityTotpAuthenticators, identityUsers } from "@pawket/database";
import { createIdentityCreatorSeedPort, hashSessionToken } from "@pawket/identity";
import { createPublicMediaService, createS3ObjectStorage, processPublicMediaAsset } from "@pawket/public-media";
import { connectQueueProducer, createQueueConnection } from "@pawket/queue";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import { eq, sql } from "drizzle-orm";

import {
  assertIncrementThreeBrowserDatabaseName,
  browserDatabaseUrl,
  prepareIncrementThreeDatabase,
} from "./increment-three-database";
import {
  acceptanceCreatorApprovedRevisionId,
  acceptanceCreatorSessionId,
  acceptanceCreatorUserId,
  creatorSessionToken,
  ownerSessionToken,
  seededAvatarAssetId,
  syntheticPng,
} from "./increment-three-fixture";
import {
  clearIncrementThreeWorkerHealth,
  resolveIncrementThreeBrowserValkeyUrl,
  resolveIncrementThreeStorageFixture,
} from "./increment-three-environment";

const creatorUserId = "task15-creator";
const applicationId = "15000000-0000-4000-8000-000000000001";
const revisionId = "15000000-0000-4000-8000-000000000002";
const capabilityId = "15000000-0000-4000-8000-000000000003";
const storageFixture = resolveIncrementThreeStorageFixture(process.env);
const mediaBuckets = [
  storageFixture.quarantineBucket,
  storageFixture.derivativeBucket,
] as const;

async function prepareMediaBuckets() {
  for (const bucket of mediaBuckets) {
    const url = `${storageFixture.endpoint}/${bucket}`;
    if ((await fetch(url, { method: "HEAD" })).status === 404) {
      const created = await fetch(url, { method: "PUT" });
      if (!created.ok) throw new Error(`Task 15 could not create S3Mock bucket ${bucket}: ${created.status}`);
    }
    const versioning = await fetch(`${url}?versioning`, {
      method: "PUT",
      headers: { "content-type": "application/xml" },
      body: '<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
    });
    if (!versioning.ok) throw new Error(`Task 15 could not enable S3Mock versioning for ${bucket}: ${versioning.status}`);
  }
  const preflight = await fetch(`${storageFixture.endpoint}/${storageFixture.quarantineBucket}/task17-preflight`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:4175",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  if (!preflight.ok || preflight.headers.get("access-control-allow-origin") !== "http://127.0.0.1:4175") {
    throw new Error("Task 17 S3Mock browser upload CORS is unavailable");
  }
}

async function resetWorkerHealth() {
  const connection = createQueueConnection(
    resolveIncrementThreeBrowserValkeyUrl(process.env),
  );
  try {
    await connectQueueProducer(connection);
    await clearIncrementThreeWorkerHealth(connection);
  } finally {
    connection.disconnect(false);
  }
}

async function encryptBetterAuthSecret(data: string) {
  const requireFromIdentity = createRequire(new URL("../../../packages/identity/package.json", import.meta.url));
  const cryptoModule = await import(pathToFileURL(requireFromIdentity.resolve("better-auth/crypto")).href) as {
    symmetricEncrypt(input: { key: string; data: string }): Promise<string>;
  };
  return cryptoModule.symmetricEncrypt({ key: "playwright-only-better-auth-secret-000000000000", data });
}

export async function resetIncrementThreeState() {
  await resetWorkerHealth();
  await prepareMediaBuckets();
  const database = createDatabase(browserDatabaseUrl); const { db } = database; const now = new Date();
  try {
    const [connected] = await db.execute<{ current_database: string }>(sql`select current_database() as current_database`);
    assertIncrementThreeBrowserDatabaseName(connected?.current_database);
    const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`);
    const names = [...tables].map((row) => row.tablename).filter((name) => /^[a-z_]+$/u.test(name));
    if (names.length > 0) await db.execute(sql.raw(`truncate table ${names.map((name) => `"${name}"`).join(", ")} restart identity cascade`));
    await db.insert(identityUsers).values({ id: creatorUserId, name: "Artist One", email: "task15-creator@example.test", canonicalEmail: "task15-creator@example.test", emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge", accessStatus: "active", authorizationVersion: 1, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(creatorApplications).values({ id: applicationId, userId: creatorUserId, state: "approved", version: 1, currentRevisionId: null, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1, artistDisplayName: "Artist One", shortIntroduction: "Synthetic approved creator for browser verification.", createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.update(creatorApplications).set({ currentRevisionId: revisionId, updatedAt: now }).where(eq(creatorApplications.id, applicationId));
    await db.insert(identityCreatorCapabilities).values({ id: capabilityId, userId: creatorUserId, state: "active", version: 1, approvedApplicationId: applicationId, approvedRevisionId: revisionId, suspendedAt: null, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.update(identityCreatorCapabilities).set({ state: "active", suspendedAt: null, updatedAt: now }).where(eq(identityCreatorCapabilities.userId, creatorUserId));
    const [creatorUser] = await db.select({ authorizationVersion: identityUsers.authorizationVersion }).from(identityUsers).where(eq(identityUsers.id, creatorUserId));
    await db.delete(identitySessions).where(eq(identitySessions.id, "task15-creator-session"));
    await db.insert(identitySessions).values({ id: "task15-creator-session", token: hashSessionToken(creatorSessionToken), userId: creatorUserId, expiresAt: new Date(now.getTime() + 60 * 60_000), createdAt: now, updatedAt: now, assuranceState: "active", primaryAuthenticatedAt: now, mfaVerifiedAt: null, lastUsedAt: now, absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000), idleExpiresAt: new Date(now.getTime() + 60 * 60_000), authorizationVersion: creatorUser!.authorizationVersion });

    const [existingPage] = await db.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, creatorUserId)).limit(1);
    const seedPort = createIdentityCreatorSeedPort();
    const storage = createS3ObjectStorage({ ...storageFixture, now: () => now });
    const mediaIds = ["15000000-0000-4000-8000-000000000009", seededAvatarAssetId];
    const mediaService = createPublicMediaService({ db, storage, creator: { async getCreatorCapability(_database, userId) { return userId === creatorUserId ? { userId, state: "active" as const } : null; } }, catalog: createCatalogMediaOwnershipPort(), publishingMode: "general_audience", commandFingerprintKey: new Uint8Array(32).fill(2), now: () => now, idFactory: () => mediaIds.shift()! });
    const service = createCatalogService({ db, creatorSeeds: seedPort, mediaCatalog: mediaService, visibility: { async readHolds() { return { pageHeld: false, heldShowcaseIds: new Set<string>() }; }, async readHoldsBatch(_database, requests) { return new Map(requests.map((request) => [request.pageId, { pageHeld: false, heldShowcaseIds: new Set<string>() }])); } }, publishingMode: "general_audience", commandFingerprintKey: new Uint8Array(32).fill(2), now: () => now });
    const actor = { userId: creatorUserId, sessionId: "task15-creator-session", primaryAuthenticatedAt: now };
    let workspace = existingPage ? await service.getWorkspace({ actorUserId: creatorUserId, pageId: existingPage.id }) : await service.initialize({ userId: creatorUserId, requestId: "task15-initialize" });
    let version = workspace.draftVersion;
    if (!workspace.canonicalHandle) version = (await service.claimHandle({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: "task15-claim", handle: "former-name" })).draftVersion;
    version = (await service.saveDraft({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID(), draft: { displayName: "Artist One", introduction: "Published introduction for the synthetic creator.", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } })).draftVersion;
    const avatarIntent = await mediaService.createUploadIntent({ actor: { userId: creatorUserId }, purpose: "avatar", declaredSourceFormat: "png", contentType: "image/png", declaredBytes: syntheticPng.byteLength, idempotencyKey: randomUUID(), requestId: randomUUID() });
    version = (await service.saveDraft({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID(), draft: { displayName: "Artist One", introduction: "Published introduction for the synthetic creator.", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: seededAvatarAssetId, coverAssetId: null } })).draftVersion;
    const uploaded = await fetch(avatarIntent.url, { method: "PUT", headers: avatarIntent.requiredHeaders, body: syntheticPng });
    if (!uploaded.ok) throw new Error(`Task 15 S3 fixture upload failed: ${uploaded.status}`);
    await mediaService.completeUpload({ actor: { userId: creatorUserId }, assetId: seededAvatarAssetId, intentId: avatarIntent.intentId, idempotencyKey: randomUUID(), requestId: randomUUID() });
    const processed = await processPublicMediaAsset(db, storage, seededAvatarAssetId, { workerId: "task15-global-setup", now: () => new Date(now.getTime() + 1_000) });
    if (processed.state !== "ready") throw new Error(`Task 15 media fixture did not become ready: ${processed.state}`);
    await service.publish({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID() });
    workspace = await service.getWorkspace({ actorUserId: creatorUserId, pageId: workspace.pageId });
    version = workspace.draftVersion;
    if (workspace.canonicalHandle === "former-name") {
      version = (await service.renameHandle({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: "task15-rename", handle: "artist-one" })).draftVersion;
      await service.publish({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID() });
    }
    await service.saveDraft({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID(), draft: { displayName: "Draft name", introduction: "Private draft introduction.", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: seededAvatarAssetId, coverAssetId: null } });

    const acceptanceApplicationId = "17000000-0000-4000-8000-000000000001";
    await db.insert(identityUsers).values({ id: acceptanceCreatorUserId, name: "Task 17 Creator", email: "task17-creator@example.test", canonicalEmail: "task17-creator@example.test", emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge", accessStatus: "active", authorizationVersion: 1, createdAt: now, updatedAt: now });
    await db.insert(creatorApplications).values({ id: acceptanceApplicationId, userId: acceptanceCreatorUserId, state: "approved", version: 1, currentRevisionId: null, createdAt: now, updatedAt: now });
    await db.insert(creatorApplicationRevisions).values({ id: acceptanceCreatorApprovedRevisionId, applicationId: acceptanceApplicationId, revisionNumber: 1, artistDisplayName: "Task 17 Creator", shortIntroduction: "Synthetic approved creator with no catalog page.", createdAt: now, updatedAt: now });
    await db.update(creatorApplications).set({ currentRevisionId: acceptanceCreatorApprovedRevisionId, updatedAt: now }).where(eq(creatorApplications.id, acceptanceApplicationId));
    await db.insert(identityCreatorCapabilities).values({ id: "17000000-0000-4000-8000-000000000003", userId: acceptanceCreatorUserId, state: "active", version: 1, approvedApplicationId: acceptanceApplicationId, approvedRevisionId: acceptanceCreatorApprovedRevisionId, suspendedAt: null, createdAt: now, updatedAt: now });
    await db.delete(identitySessions).where(eq(identitySessions.id, acceptanceCreatorSessionId));
    const [unexpectedAcceptancePage] = await db.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, acceptanceCreatorUserId)).limit(1);
    if (unexpectedAcceptancePage) throw new Error("Task 17 acceptance creator must start without a creator page");

    const ownerUserId = "task15-owner";
    await db.insert(identityUsers).values({ id: ownerUserId, name: "Task 15 Owner", email: "task15-owner@example.test", canonicalEmail: "task15-owner@example.test", emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge", twoFactorEnabled: true, accessStatus: "active", authorizationVersion: 1, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(identityRoleGrants).values({ id: "15000000-0000-4000-8000-000000000004", userId: ownerUserId, role: "owner", state: "active", grantSource: "bootstrap_cli", version: 1, grantedAt: now, createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [authenticator] = await db.select({ id: identityTotpAuthenticators.id }).from(identityTotpAuthenticators).where(eq(identityTotpAuthenticators.userId, ownerUserId)).limit(1);
    const authenticatorId = authenticator?.id ?? randomUUID();
    const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": Buffer.from("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", "base64") } });
    const libraryTotpSecret = await encryptBetterAuthSecret("3132333435363738393031323334353637383930");
    const encryptedTotpSecret = encryptSensitiveField({ plaintext: libraryTotpSecret, binding: { recordType: "identity_totp_authenticator", recordId: authenticatorId, fieldName: "secret" }, keyring });
    await db.update(identityUsers).set({ twoFactorEnabled: true }).where(eq(identityUsers.id, ownerUserId));
    if (authenticator) await db.update(identityTotpAuthenticators).set({ secret: encryptedTotpSecret, verified: true, updatedAt: now }).where(eq(identityTotpAuthenticators.id, authenticatorId));
    else await db.insert(identityTotpAuthenticators).values({ id: authenticatorId, userId: ownerUserId, secret: encryptedTotpSecret, verified: true, createdAt: now, updatedAt: now });
    const [ownerUser] = await db.select({ authorizationVersion: identityUsers.authorizationVersion }).from(identityUsers).where(eq(identityUsers.id, ownerUserId));
    await db.delete(identitySessions).where(eq(identitySessions.id, "task15-owner-session"));
    await db.insert(identitySessions).values({ id: "task15-owner-session", token: hashSessionToken(ownerSessionToken), userId: ownerUserId, expiresAt: new Date(now.getTime() + 30 * 60_000), createdAt: now, updatedAt: now, assuranceState: "active", primaryAuthenticatedAt: now, mfaVerifiedAt: new Date(now.getTime() - 10 * 60_000), lastUsedAt: now, absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000), idleExpiresAt: new Date(now.getTime() + 30 * 60_000), authorizationVersion: ownerUser!.authorizationVersion });
  } finally { await database.close(); }
}

type IncrementThreeGlobalSetupDependencies = Readonly<{
  prepareDatabase(): Promise<void>;
  resetState(): Promise<void>;
}>;

export async function prepareAndResetIncrementThreeState(
  dependencies: IncrementThreeGlobalSetupDependencies = {
    prepareDatabase: prepareIncrementThreeDatabase,
    resetState: resetIncrementThreeState,
  },
) {
  await dependencies.prepareDatabase();
  await dependencies.resetState();
}

export default async function incrementThreeGlobalSetup() {
  await prepareAndResetIncrementThreeState();
}
