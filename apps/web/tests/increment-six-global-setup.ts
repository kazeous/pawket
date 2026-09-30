import { randomUUID } from "node:crypto";
import { createCommissionPackageService, createPublicCatalogQuery } from "@pawket/catalog";
import { commissionPolicyCurrent, commissionPolicyRevisions, createDatabase, creatorPages, identityEmailAddresses, identitySessions, identityUsers } from "@pawket/database";
import { createIdentityCommissionAssurancePort, createIdentityCreatorSeedPort, hashSessionToken } from "@pawket/identity";
import { commissionPolicyChecksum, createCommissionPolicyReadPort } from "@pawket/orders";
import { createTipReceivingAccountEligibilityPort } from "@pawket/payments";
import { createEncryptionKeyring } from "@pawket/security";
import { eq } from "drizzle-orm";
import { browserDatabaseUrl } from "./increment-three-database";
import { seedCreatorPaymentBrowserFixture, tipBrowserSessionId, tipBrowserUserId } from "./increment-four-global-setup";
import { attachSyntheticOidcSession, syntheticOidcProvider } from "./oidc-test-support";

export const commissionBuyerToken = (index: number) => `commission-browser-buyer-token-${index}-00000000000000000000`;
export const commissionBuyerId = (index: number) => `commission-browser-buyer-${index}`;
export default async function setup() {
  await seedCreatorPaymentBrowserFixture("pawket_increment6_commissions_browser");
  const database = createDatabase(browserDatabaseUrl); const { db } = database; const at = new Date(); const expiresAt = new Date(at.getTime() + 3_600_000);
  const policyId = randomUUID(); const key = new Uint8Array(32).fill(2);
  const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
  try {
    await db.transaction(async (tx) => {
      const facts = { technicalVersion: "commission-v1", minimumVnd: 50_000, maximumVnd: 50_000_000, approvalKind: "synthetic", document: "CHỈ DỮ LIỆU KIỂM THỬ. Điều khoản tổng hợp để kiểm tra chấp thuận; không áp dụng thanh toán thật." };
      await tx.insert(commissionPolicyRevisions).values({ id: policyId, revisionNumber: 2, ...facts, source: "synthetic-increment-six-browser", checksum: commissionPolicyChecksum(facts), effectiveAt: at, createdAt: at });
      await tx.update(commissionPolicyCurrent).set({ revisionId: policyId, updatedAt: at });
      for (let index = 0; index < 20; index++) {
        const userId = commissionBuyerId(index); const email = `${userId}@example.invalid`;
        await tx.insert(identityUsers).values({ id: userId, name: `Người đặt kiểm thử ${index}`, email, canonicalEmail: email, emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
        await tx.insert(identityEmailAddresses).values({ userId, displayEmail: email, canonicalEmail: email, status: "primary", verifiedAt: at, verificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
        await tx.insert(identitySessions).values({ id: `${userId}-session`, token: hashSessionToken(commissionBuyerToken(index)), userId, expiresAt, absoluteExpiresAt: expiresAt, idleExpiresAt: expiresAt,
          assuranceState: "active", authorizationVersion: 1, primaryAuthenticatedAt: at, createdAt: at, updatedAt: at, lastUsedAt: at });
        await attachSyntheticOidcSession(tx, { userId, sessionId: `${userId}-session`, now: at });
      }
    });
    const visibility = createPublicCatalogQuery({ db, publishingMode: "general_audience", creatorSeeds: createIdentityCreatorSeedPort(),
      visibility: { async readHolds() { return { pageHeld: false, heldShowcaseIds: new Set<string>() }; }, async readHoldsBatch(_db, requests) { return new Map(requests.map((r) => [r.pageId, { pageHeld: false, heldShowcaseIds: new Set<string>() }])); } },
      mediaCatalog: { async resolveReadyAssets() { return new Map(); }, async resolveReadyAssetsBatch(_db, requests) { return new Map(requests.map((r) => [r.ownerUserId, new Map()])); } } });
    const catalog = createCommissionPackageService({ db, applicationRevision: "synthetic-increment-six-browser", lookupHmacKey: key,
      intakeMode: "enabled", paymentsMode: "manual_only", publishingMode: "general_audience", policy: createCommissionPolicyReadPort({ environment: "test" }),
      identity: createIdentityCommissionAssurancePort(syntheticOidcProvider), visibility, receivingAccount: createTipReceivingAccountEligibilityPort({ paymentsMode: "manual_only", keyring, lookupHmacKey: key }) });
    const [page] = await db.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, tipBrowserUserId));
    if (!page) throw new Error("Missing synthetic artist page");
    const actor = { userId: tipBrowserUserId, sessionId: tipBrowserSessionId }; const ids = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });
    const terms = { amountVnd: 500_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7, scope: "Một tranh chân dung nhân vật", deliverables: "Tệp PNG độ phân giải cao", usageRights: "Sử dụng cá nhân", artistTerms: "Thống nhất bố cục trong phạm vi đã chọn.", policyRevisionId: policyId };
    for (const route of ["fixed_immediate", "fixed_approval", "custom_quote"] as const) {
      const packageId = await catalog.saveDraft({ ...ids(), actor, packageId: null, pageId: page.id, expectedVersion: 0,
        draft: { title: `Gói kiểm thử ${route}`, description: "Nội dung tổng hợp cho luồng commission.", discipline: "illustration", route, briefInstructions: "Mô tả nhân vật và ý tưởng.", terms: route === "custom_quote" ? null : terms, showcaseId: null } });
      await catalog.changePackage({ ...ids(), actor, packageId, expectedVersion: 1, action: "publish", policyRevisionId: policyId });
    }
    await catalog.saveSettings({ ...ids(), actor, expectedVersion: 0, enabled: true, capacityLimit: 20 });
  } finally { await database.close(); }
}
