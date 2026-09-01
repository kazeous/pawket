import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createCatalogService } from "@pawket/catalog";
import { createDatabase, creatorApplications, creatorApplicationRevisions, creatorPages, identityCreatorCapabilities, identityRoleGrants, identitySessions, identityTotpAuthenticators, identityUsers, publicContentReports, publicContentTriageEvents, publicReportChallenges, publicReportSecurityEvents, publicVisibilityHolds } from "@pawket/database";
import { createIdentityCreatorSeedPort, hashSessionToken } from "@pawket/identity";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import { eq, sql } from "drizzle-orm";

import { creatorSessionToken, ownerSessionToken } from "./increment-three-fixture";

const databaseUrl = "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";
const creatorUserId = "task15-creator";
const applicationId = "15000000-0000-4000-8000-000000000001";
const revisionId = "15000000-0000-4000-8000-000000000002";
const capabilityId = "15000000-0000-4000-8000-000000000003";

async function encryptBetterAuthSecret(data: string) {
  const requireFromIdentity = createRequire(new URL("../../../packages/identity/package.json", import.meta.url));
  const cryptoModule = await import(pathToFileURL(requireFromIdentity.resolve("better-auth/crypto")).href) as {
    symmetricEncrypt(input: { key: string; data: string }): Promise<string>;
  };
  return cryptoModule.symmetricEncrypt({ key: "playwright-only-better-auth-secret-000000000000", data });
}

export default async function setup() {
  const database = createDatabase(databaseUrl); const { db } = database; const now = new Date();
  try {
    const mutationGuards = [
      ["public_content_triage_events", "public_content_triage_events_append_only"],
      ["public_visibility_holds", "public_visibility_holds_guard"],
      ["public_content_reports", "public_content_reports_append_only"],
      ["public_report_challenges", "public_report_challenges_one_way_consume"],
      ["public_report_security_events", "public_report_security_events_retention_guard"],
    ] as const;
    for (const [table, trigger] of mutationGuards) await db.execute(sql.raw(`alter table ${table} disable trigger ${trigger}`));
    try {
      await db.delete(publicContentTriageEvents);
      await db.delete(publicVisibilityHolds);
      await db.delete(publicContentReports);
      await db.delete(publicReportChallenges);
      await db.delete(publicReportSecurityEvents);
    } finally {
      for (const [table, trigger] of mutationGuards) await db.execute(sql.raw(`alter table ${table} enable trigger ${trigger}`));
    }
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
    const service = createCatalogService({ db, creatorSeeds: seedPort, mediaCatalog: { async resolveReadyAssets() { return new Map(); }, async resolveReadyAssetsBatch() { return new Map(); } }, visibility: { async readHolds() { return { pageHeld: false, heldShowcaseIds: new Set<string>() }; }, async readHoldsBatch(_database, requests) { return new Map(requests.map((request) => [request.pageId, { pageHeld: false, heldShowcaseIds: new Set<string>() }])); } }, publishingMode: "general_audience", commandFingerprintKey: new Uint8Array(32).fill(2), now: () => now });
    const actor = { userId: creatorUserId, sessionId: "task15-creator-session", primaryAuthenticatedAt: now };
    let workspace = existingPage ? await service.getWorkspace({ actorUserId: creatorUserId, pageId: existingPage.id }) : await service.initialize({ userId: creatorUserId, requestId: "task15-initialize" });
    let version = workspace.draftVersion;
    if (!workspace.canonicalHandle) version = (await service.claimHandle({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: "task15-claim", handle: "former-name" })).draftVersion;
    version = (await service.saveDraft({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID(), draft: { displayName: "Artist One", introduction: "Published introduction for the synthetic creator.", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } })).draftVersion;
    await service.publish({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID() });
    workspace = await service.getWorkspace({ actorUserId: creatorUserId, pageId: workspace.pageId });
    version = workspace.draftVersion;
    if (workspace.canonicalHandle === "former-name") {
      version = (await service.renameHandle({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: "task15-rename", handle: "artist-one" })).draftVersion;
      await service.publish({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID() });
    }
    await service.saveDraft({ actor, pageId: workspace.pageId, expectedVersion: version, idempotencyKey: randomUUID(), requestId: randomUUID(), draft: { displayName: "Draft name", introduction: "Private draft introduction.", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } });

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
