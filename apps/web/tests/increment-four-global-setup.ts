import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createCreatorTipSettingsService, createPublicCatalogQuery, createPlatformTipPolicyService } from "@pawket/catalog";
import { createDatabase, creatorApplications, creatorApplicationRevisions, identityCreatorCapabilities, identityUsers, identityEmailAddresses, identitySessions, identityAccounts, identityRoleGrants, identityTotpAuthenticators, creatorPages, creatorHandleClaims, creatorPublicationRevisions, creatorDiscoveryProjections, paymentsReceivingAccountOnboarding } from "@pawket/database";
import { hashPassword } from "../../../packages/identity/src/auth-candidate/password";
import { createIdentityCreatorSeedPort, createIdentityCreatorTipAccountPort, hashSessionToken } from "@pawket/identity";
import { createTipReceivingAccountEligibilityPort, fingerprintReceivingAccount } from "@pawket/payments";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import { eq } from "drizzle-orm";
import { browserDatabaseConfiguration, browserDatabaseUrl, prepareIncrementThreeDatabase } from "./increment-three-database";

export const tipBrowserHandle = "tip-test-artist";
export const tipBrowserUserId = "tip-browser-creator";
export const tipBrowserAccount = "0000001234567";
export const tipBrowserSessionId = "tip-browser-session";
export const tipBrowserSessionToken = "tip-browser-session-token-00000000000000000000";
export const tipBrowserPassword = "synthetic browser creator reauthentication only";
export const tipPolicyOwnerUserId = "tip-policy-browser-owner";
export const tipPolicyOwnerSessionId = "tip-policy-browser-owner-session";
export const tipPolicyOwnerSessionToken = "tip-policy-browser-owner-token-000000000000000";
export default async function setup() {
  if (browserDatabaseConfiguration.targetDatabaseName !== "pawket_increment4_tips_browser") throw new Error("Unexpected tip browser database");
  await prepareIncrementThreeDatabase();
  const database = createDatabase(browserDatabaseUrl); const { db } = database; const at = new Date();
  const key = new Uint8Array(32).fill(2);
  const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
  const userId = tipBrowserUserId; const applicationId = randomUUID(); const revisionId = randomUUID();
  const pageId = randomUUID(); const publicationId = randomUUID(); const accountVersionId = randomUUID();
  const requireFromIdentity = createRequire(new URL("../../../packages/identity/package.json", import.meta.url));
  const { symmetricEncrypt } = await import(pathToFileURL(requireFromIdentity.resolve("better-auth/crypto")).href) as { symmetricEncrypt(input: { key: string; data: string }): Promise<string> };
  const ownerAuthenticatorId = randomUUID();
  const librarySecret = await symmetricEncrypt({ key: "playwright-only-better-auth-secret-000000000000", data: "3132333435363738393031323334353637383930" });
  const creatorPasswordHash = await hashPassword(tipBrowserPassword);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(identityUsers).values({ id: tipPolicyOwnerUserId, name: "Synthetic Tip Policy Owner", email: "tip-policy-owner@example.invalid", canonicalEmail: "tip-policy-owner@example.invalid", emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", twoFactorEnabled: true, accessStatus: "active", authorizationVersion: 1, createdAt: at, updatedAt: at });
      await tx.insert(identityEmailAddresses).values({ userId: tipPolicyOwnerUserId, displayEmail: "tip-policy-owner@example.invalid", canonicalEmail: "tip-policy-owner@example.invalid", status: "primary", verifiedAt: at, verificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
      await tx.insert(identityRoleGrants).values({ id: randomUUID(), userId: tipPolicyOwnerUserId, role: "owner", state: "active", grantSource: "bootstrap_cli", version: 1, grantedAt: at, createdAt: at, updatedAt: at });
      await tx.insert(identityTotpAuthenticators).values({ id: ownerAuthenticatorId, userId: tipPolicyOwnerUserId, secret: encryptSensitiveField({ plaintext: librarySecret, binding: { recordType: "identity_totp_authenticator", recordId: ownerAuthenticatorId, fieldName: "secret" }, keyring }), verified: true, createdAt: at, updatedAt: at });
      await tx.insert(identitySessions).values({ id: tipPolicyOwnerSessionId, token: hashSessionToken(tipPolicyOwnerSessionToken), userId: tipPolicyOwnerUserId, expiresAt: new Date(at.getTime() + 3_600_000), absoluteExpiresAt: new Date(at.getTime() + 12 * 3_600_000), idleExpiresAt: new Date(at.getTime() + 3_600_000), assuranceState: "active", authorizationVersion: 1, primaryAuthenticatedAt: at, mfaVerifiedAt: new Date(at.getTime() - 600_000), createdAt: at, updatedAt: at, lastUsedAt: at });
      await tx.insert(identityUsers).values({ id: userId, name: "Tip Test Artist", email: "tip-artist@example.invalid", canonicalEmail: "tip-artist@example.invalid", emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
      await tx.insert(identityEmailAddresses).values({ userId, displayEmail: "tip-artist@example.invalid", canonicalEmail: "tip-artist@example.invalid", status: "primary", verifiedAt: at, verificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
      await tx.insert(identityAccounts).values({ id: randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: creatorPasswordHash, passwordHashVersion: 1, createdAt: at, updatedAt: at });
      const expiresAt = new Date(at.getTime() + 3_600_000);
      await tx.insert(identitySessions).values({ id: tipBrowserSessionId, token: hashSessionToken(tipBrowserSessionToken), userId, expiresAt, absoluteExpiresAt: expiresAt, idleExpiresAt: expiresAt,
        assuranceState: "active", authorizationVersion: 1, primaryAuthenticatedAt: at, createdAt: at, updatedAt: at, lastUsedAt: at });
      await tx.insert(creatorApplications).values({ id: applicationId, userId, state: "approved", version: 1, currentRevisionId: null, createdAt: at, updatedAt: at });
      await tx.insert(creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1, artistDisplayName: "Tip Test Artist", shortIntroduction: "Nghệ sĩ giả lập để kiểm tra giao diện tip.", createdAt: at, updatedAt: at });
      await tx.update(creatorApplications).set({ currentRevisionId: revisionId }).where(eq(creatorApplications.id, applicationId));
      await tx.insert(identityCreatorCapabilities).values({ id: randomUUID(), userId, state: "active", version: 1, approvedApplicationId: applicationId, approvedRevisionId: revisionId, createdAt: at, updatedAt: at });
      await tx.insert(creatorPages).values({ id: pageId, userId, initializedFromRevisionId: revisionId, createdAt: at, updatedAt: at });
      await tx.insert(creatorHandleClaims).values({ id: randomUUID(), pageId, normalizedHandle: tipBrowserHandle, kind: "canonical", claimedAt: at });
      await tx.insert(creatorPublicationRevisions).values({ id: publicationId, pageId, revisionNumber: 1, canonicalHandle: tipBrowserHandle, displayName: "Tip Test Artist", shortIntroduction: "Nghệ sĩ giả lập để kiểm tra giao diện tip.", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: userId, actorSessionId: "synthetic-session", expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
      await tx.update(creatorPages).set({ publishedRevisionId: publicationId }).where(eq(creatorPages.id, pageId));
      await tx.insert(creatorDiscoveryProjections).values({ pageId, revisionId: publicationId, canonicalHandle: tipBrowserHandle, displayName: "Tip Test Artist", shortIntroduction: "Nghệ sĩ giả lập để kiểm tra giao diện tip.", disciplines: ["illustration"], revisionAt: at, enabled: true });
      await tx.insert(paymentsReceivingAccountOnboarding).values({ id: accountVersionId, onboardingId: randomUUID(), applicantUserId: userId, version: 1, bankBin: "970436", bankName: "Vietcombank", maskedSuffix: "•••• 4567",
        accountFingerprint: fingerprintReceivingAccount({ bankBin: "970436", accountNumber: tipBrowserAccount, key }),
        accountNumberEnvelope: encryptSensitiveField({ keyring, plaintext: tipBrowserAccount, binding: { recordType: "payments_receiving_account", recordId: accountVersionId, fieldName: "account_number" } }),
        accountHolderLabelEnvelope: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC ARTIST", binding: { recordType: "payments_receiving_account", recordId: accountVersionId, fieldName: "account_holder_label" } }),
        proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at });
    });
    const visibility = createPublicCatalogQuery({ db, publishingMode: "general_audience", creatorSeeds: createIdentityCreatorSeedPort(),
      visibility: { async readHolds() { return { pageHeld: false, heldShowcaseIds: new Set<string>() }; }, async readHoldsBatch(_db, requests) { return new Map(requests.map((r) => [r.pageId, { pageHeld: false, heldShowcaseIds: new Set<string>() }])); } },
      mediaCatalog: { async resolveReadyAssets() { return new Map(); }, async resolveReadyAssetsBatch(_db, requests) { return new Map(requests.map((r) => [r.ownerUserId, new Map()])); } } });
    const settings = createCreatorTipSettingsService({ applicationRevision: "synthetic-increment-four-revision", db, visibility, creatorAccount: createIdentityCreatorTipAccountPort(), receivingAccount: createTipReceivingAccountEligibilityPort({ paymentsMode: "manual_only", keyring, lookupHmacKey: key }),
      paymentsMode: "manual_only", publishingMode: "general_audience", platformPolicy: createPlatformTipPolicyService({ db, applicationRevision: "synthetic-increment-four-revision", commandFingerprintKey: key,
        authorizeOwner: async () => false, requireOwnerStepUp: async () => false }), recentAuthMs: 900_000, commandFingerprintKey: key });
    await settings.saveSettings({ actor: { userId, sessionId: "synthetic-session", primaryAuthenticatedAt: at }, pageId, expectedRevision: 0, expectedPolicyRevision: 1, enabled: true, presetsVnd: [20_000, 50_000, 100_000], idempotencyKey: randomUUID(), requestId: randomUUID() });
  } finally { await database.close(); }
}
