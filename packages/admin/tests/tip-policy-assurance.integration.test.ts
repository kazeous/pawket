import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPlatformTipPolicyService } from "@pawket/catalog";
import { createDatabase, identityUsers, identitySessions, identityRoleGrants, identityTotpAuthenticators,
  identityStepUpProofs, adminAuditEvents, type PawketDatabase } from "@pawket/database";
import { createStepUpProof, consumeStepUpProof } from "@pawket/identity";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import { createOwnerTipPolicyAssurancePort } from "../src/tip-policy-assurance.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for policy assurance tests");
const schema = `tip_policy_assurance_${process.pid}_${Date.now()}`;
const admin = createDatabase(databaseUrl);
let db: PawketDatabase; let close: () => Promise<void>;
const at = new Date(); const actor = { userId: "policy-owner", sessionId: "policy-owner-session" };
const key = new Uint8Array(32).fill(71);
const ports = createOwnerTipPolicyAssurancePort();
const keyring = createEncryptionKeyring({ activeKeyId: "policy-test", keys: { "policy-test": key } });
const service = () => createPlatformTipPolicyService({ db, applicationRevision: "policy-assurance-test", commandFingerprintKey: key, ...ports, now: () => at });
async function command() {
  const current = await service().getPolicy({ actor });
  return { actor, expectedRevision: current!.revisionNumber, minimumVnd: 10_000, maximumVnd: 5_000_000,
    allowedPresetsVnd: [20_000, 50_000, 100_000], reason: "Test owner policy assurance", idempotencyKey: randomUUID(), requestId: randomUUID() };
}
beforeAll(async () => {
  await admin.db.execute(sql.raw(`create schema "${schema}"`));
  const url = new URL(databaseUrl); url.searchParams.set("options", `-csearch_path=${schema},public`);
  const connection = createDatabase(url.toString()); db = connection.db; close = connection.close;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: `${schema}_journal` });
  await db.insert(identityUsers).values({ id: actor.userId, name: "Synthetic policy owner", email: "policy-owner@example.invalid", canonicalEmail: "policy-owner@example.invalid",
    emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", twoFactorEnabled: true, authorizationVersion: 1 });
  await db.insert(identityRoleGrants).values({ userId: actor.userId, role: "owner", state: "active", grantSource: "bootstrap_cli" });
  await db.insert(identityTotpAuthenticators).values({ id: "policy-authenticator", userId: actor.userId, verified: true,
    secret: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC-TOTP-SEED", binding: { recordType: "identity_totp_authenticator", recordId: "policy-authenticator", fieldName: "secret" } }) });
  await db.insert(identitySessions).values({ id: actor.sessionId, userId: actor.userId, token: "synthetic-policy-session-hash", assuranceState: "active", authorizationVersion: 1, createdAt: at, updatedAt: at,
    primaryAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 3_600_000), idleExpiresAt: new Date(at.getTime() + 3_600_000), absoluteExpiresAt: new Date(at.getTime() + 3_600_000), lastUsedAt: at });
});
beforeEach(async () => {
  await db.update(identityUsers).set({ twoFactorEnabled: true, accessStatus: "active", authorizationVersion: 1, emailVerified: true }).where(eq(identityUsers.id, actor.userId));
  await db.update(identitySessions).set({ revokedAt: null, revocationReason: null, mfaVerifiedAt: at, primaryAuthenticatedAt: at, authorizationVersion: 1, expiresAt: new Date(at.getTime() + 3_600_000) }).where(eq(identitySessions.id, actor.sessionId));
  await db.update(identityRoleGrants).set({ state: "active", revokedAt: null }).where(eq(identityRoleGrants.userId, actor.userId));
  await db.update(identityTotpAuthenticators).set({ verified: true }).where(eq(identityTotpAuthenticators.userId, actor.userId));
});
afterAll(async () => {
  await close?.();
  await admin.db.execute(sql.raw(`drop schema if exists "${schema}" cascade`));
  await admin.db.execute(sql.raw(`drop schema if exists "${schema}_journal" cascade`));
  await admin.close();
});

describe("platform policy real owner assurance", () => {
  test("commits exactly one proof/audit/revision, and retries after MFA ages without another proof", async () => {
    const input = await command();
    const before = await db.select().from(identityStepUpProofs);
    const result = await service().savePolicy(input);
    const proofs = await db.select().from(identityStepUpProofs);
    expect(proofs.length).toBe(before.length + 1);
    expect(proofs.at(-1)).toMatchObject({ actionClass: "owner.tip_policy_update", consumedAt: at });
    await db.update(identitySessions).set({ mfaVerifiedAt: new Date(at.getTime() - 600_000) }).where(eq(identitySessions.id, actor.sessionId));
    expect(await service().savePolicy(input)).toEqual(result);
    expect(await db.select().from(identityStepUpProofs)).toHaveLength(proofs.length);
    expect(await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.subjectId, result.revisionId))).toHaveLength(1);
    await expect(service().savePolicy({ ...input, expectedRevision: result.revisionNumber, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "OWNER_STEP_UP_REQUIRED" });
  });
  test.each(["revoked_session", "role_revoked", "stale_version", "disabled_mfa", "unverified_totp", "blocked", "expired"])("rejects %s at transaction time", async (state) => {
    const input = await command();
    if (state === "revoked_session") await db.update(identitySessions).set({ revokedAt: at, revocationReason: "user_revoked" }).where(eq(identitySessions.id, actor.sessionId));
    if (state === "role_revoked") await db.update(identityRoleGrants).set({ state: "revoked", revokedAt: at }).where(eq(identityRoleGrants.userId, actor.userId));
    if (state === "stale_version") await db.update(identityUsers).set({ authorizationVersion: 2 }).where(eq(identityUsers.id, actor.userId));
    if (state === "disabled_mfa") await db.update(identityUsers).set({ twoFactorEnabled: false }).where(eq(identityUsers.id, actor.userId));
    if (state === "unverified_totp") await db.update(identityTotpAuthenticators).set({ verified: false }).where(eq(identityTotpAuthenticators.userId, actor.userId));
    if (state === "blocked") await db.update(identityUsers).set({ accessStatus: "access_suspended" }).where(eq(identityUsers.id, actor.userId));
    if (state === "expired") await db.update(identitySessions).set({ expiresAt: at }).where(eq(identitySessions.id, actor.sessionId));
    await expect(service().savePolicy(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("denies another user's session and future-dated MFA", async () => {
    const input = await command();
    await expect(service().savePolicy({ ...input, actor: { userId: "unrelated-user", sessionId: actor.sessionId } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.update(identitySessions).set({ mfaVerifiedAt: new Date(at.getTime() + 60_000) }).where(eq(identitySessions.id, actor.sessionId));
    await expect(service().savePolicy(input)).rejects.toMatchObject({ code: "OWNER_STEP_UP_REQUIRED" });
  });
  test("a purpose-bound proof cannot authorize another owner action or be consumed twice", async () => {
    await db.transaction(async (tx) => {
      const proof = await createStepUpProof(tx, { ...actor, now: at, actionClass: "owner.tip_policy_update", assuranceMethod: "totp" });
      expect(await consumeStepUpProof(tx, { ...actor, now: at, proofId: proof.id, actionClass: "owner.creator_application_approve" })).toBe(false);
      expect(await consumeStepUpProof(tx, { ...actor, now: at, proofId: proof.id, actionClass: "owner.tip_policy_update" })).toBe(true);
      expect(await consumeStepUpProof(tx, { ...actor, now: at, proofId: proof.id, actionClass: "owner.tip_policy_update" })).toBe(false);
    });
  });
  test("revoked owners cannot replay a previously committed change", async () => {
    const input = await command(); await service().savePolicy(input);
    await db.update(identitySessions).set({ revokedAt: at, revocationReason: "user_revoked" }).where(eq(identitySessions.id, actor.sessionId));
    await expect(service().savePolicy(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
