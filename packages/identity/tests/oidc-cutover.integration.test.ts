import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { adminAuditEvents, identityAccounts, identityEmailHandoffs, identityOidcCutover, identityRoleGrants, identitySessions, identityStepUpProofs, identityUsers, identityVerifications } from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import { performOidcCutover, oidcCutoverConfirmation } from "../src/oidc-cutover.js";
import { prepareOidcOwnerLink, oidcOwnerLinkConfirmation } from "../src/oidc-owner-link.js";
import { queueSecurityEmailHandoff } from "../src/security-email-handoff.js";
import { createOidcSessionStore } from "../src/oidc-session-store.js";
import { createOidcSessionResolver } from "../src/oidc-session.js";
import { createOidcTransactionRepository } from "../src/oidc-transactions.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase(); const { db } = database;
const now = new Date(); const provider = { issuer: "https://idp.example/pawket/", clientId: "synthetic", providerRevision: "v1" };
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
const ownerId = randomUUID(); const legacyId = randomUUID(); const subject = randomUUID();
const opaque = () => randomBytes(32).toString("base64url");
const common = { provider, ownerUserId: ownerId, operatorReference: "operator-test", acceptanceReference: "acceptance-test", backupReference: "restore-drill-test",
  recoveryReference: "recovery-test", applicationRevision: "candidate-test", confirmedRevision: "candidate-test", now,
  rollbackUntil: new Date(now.getTime() + 86_400_000), backupRetainedUntil: new Date(now.getTime() + 172_800_000) };
const apply = { ...common, mode: "apply" as const, oldIssuersStopped: true as const, confirmation: oidcCutoverConfirmation(common) };
const legacySession = { id: legacyId, userId: ownerId, token: opaque(), assuranceState: "active", primaryAuthenticatedAt: now, mfaVerifiedAt: now,
  createdAt: now, updatedAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + 3_600_000),
  idleExpiresAt: new Date(now.getTime() + 3_600_000), absoluteExpiresAt: new Date(now.getTime() + 3_600_000) };
const emailId = randomUUID(); const credentialId = randomUUID(); const challengeId = randomUUID();
beforeAll(async () => {
  await database.setup();
  await db.insert(identityUsers).values({ id: ownerId, name: "Synthetic Owner", email: "owner-cutover@example.test", canonicalEmail: "owner-cutover@example.test", emailVerified: true,
    emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge", createdAt: now, updatedAt: now });
  await db.insert(identityRoleGrants).values({ userId: ownerId, role: "owner", grantSource: "bootstrap_cli" });
  await db.insert(identityAccounts).values({ id: credentialId, userId: ownerId, providerId: "credential", issuer: "local:credential", accountId: ownerId,
    password: "synthetic-historical-hash", passwordHashVersion: 1, createdAt: now, updatedAt: now });
  await db.insert(identitySessions).values(legacySession);
  await db.insert(identityStepUpProofs).values({ userId: ownerId, sessionId: legacyId, actionClass: "owner.synthetic", assuranceMethod: "totp", issuedAt: now, expiresAt: new Date(now.getTime() + 300_000) });
  await db.insert(identityVerifications).values({ id: challengeId, identifier: opaque(), value: opaque(), purpose: "password_reset", userId: ownerId, createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 300_000) });
  await db.transaction((tx) => queueSecurityEmailHandoff(tx, { id: emailId, userId: ownerId, purpose: "password_reset", destination: "owner-cutover@example.test", secret: opaque(), now, keyring }));
}, 30_000);
afterAll(() => database.close());

test("cutover dry run, conflict, delivery drain, apply and SSO-only rollback rehearsal", async () => {
  const beforeUser = await db.select().from(identityUsers); const beforeRole = await db.select().from(identityRoleGrants);
  const beforeCredential = await db.select().from(identityAccounts);
  await expect(performOidcCutover(db, { ...common, mode: "dry_run" })).rejects.toMatchObject({ code: "OWNER_NOT_READY" });
  const pin = { provider, userId: ownerId, subject, operatorReference: "operator-test", evidenceReference: "acceptance-test", applicationRevision: common.applicationRevision, confirmedRevision: common.applicationRevision, now };
  await prepareOidcOwnerLink(db, { ...pin, mode: "apply", invitation: opaque(), confirmation: oidcOwnerLinkConfirmation(pin) });
  const dry = await performOidcCutover(db, { ...common, mode: "dry_run" });
  expect(dry).toMatchObject({ alreadyApplied: false, totals: { sessions: 1, proofs: 1, challenges: 1, retiredEmails: 1 } });
  expect(await db.select().from(identityOidcCutover)).toHaveLength(0);
  expect((await db.select().from(identitySessions))[0]!.revokedAt).toBeNull();
  await expect(performOidcCutover(db, { ...apply, confirmation: "wrong" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  await expect(performOidcCutover(db, { ...apply, confirmedRevision: "wrong" })).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
  await db.update(identityEmailHandoffs).set({ status: "processing", lockedAt: now, lockedBy: "old-worker", leaseExpiresAt: new Date(now.getTime() + 30_000) }).where(eq(identityEmailHandoffs.id, emailId));
  await expect(performOidcCutover(db, apply)).rejects.toMatchObject({ code: "DELIVERY_IN_FLIGHT" });
  await db.update(identityEmailHandoffs).set({ status: "pending", lockedAt: null, lockedBy: null, leaseExpiresAt: null }).where(eq(identityEmailHandoffs.id, emailId));
  const outcomes = await Promise.allSettled([performOidcCutover(db, apply), performOidcCutover(db, apply)]);
  for (const result of outcomes) { if (result.status === "rejected") throw result.reason; }
  const results = outcomes.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  expect(results.filter((r) => !r.alreadyApplied)).toHaveLength(1);
  expect(await db.select().from(identityUsers)).toEqual(beforeUser); expect(await db.select().from(identityRoleGrants)).toEqual(beforeRole);
  expect(await db.select().from(identityAccounts)).toEqual(beforeCredential);
  expect((await db.select().from(identitySessions))[0]).toMatchObject({ id: legacyId, revokedAt: now, revocationReason: "auth_moved" });
  expect((await db.select().from(identityStepUpProofs))[0]!.consumedAt).toEqual(now);
  expect((await db.select().from(identityVerifications))[0]!.consumedAt).toEqual(now);
  expect((await db.select().from(identityEmailHandoffs))[0]).toMatchObject({ status: "attention_required", failureCode: "auth_moved", destinationEnvelope: null, secretEnvelope: null });
  expect(await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.action, "identity.oidc_cutover"))).toHaveLength(1);
  await expect(performOidcCutover(db, { ...apply, backupReference: "changed" })).rejects.toMatchObject({ code: "CUTOVER_CONFLICT" });
  // Restoring the old binary cannot issue/restore its credential sessions or challenges.
  await expect(db.insert(identitySessions).values({ ...legacySession, id: randomUUID(), token: opaque() })).rejects.toThrow();
  await expect(db.update(identitySessions).set({ revokedAt: null, revocationReason: null }).where(eq(identitySessions.id, legacyId))).rejects.toThrow();
  await expect(db.insert(identityVerifications).values({ id: randomUUID(), identifier: opaque(), value: opaque(), createdAt: now, expiresAt: new Date(now.getTime() + 1000) })).rejects.toThrow();
  await expect(db.delete(identityOidcCutover)).rejects.toThrow();
  // A compatible SSO binary still mints a fresh session with a deferred sidecar.
  const config = { ...provider, clientSecret: opaque(), redirectUri: "http://localhost:3000/callback", accountPortalUrl: "https://idp.example/" };
  const transactions = createOidcTransactionRepository({ db, keyring, config }); const sessions = createOidcSessionStore({ db, config });
  const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque(); const newToken = opaque();
  const at = new Date(); const txn = await transactions.start({ material, browserBinding, intent: { purpose: "login" }, returnPath: "/", now: at });
  await transactions.claim({ state: material.state, browserBinding, now: at });
  const buyerSubject = randomUUID();
  const minted = await transactions.complete({ id: txn.id, now: at }, (tx, transaction) => sessions.accept(tx, { transaction, now: at, newSessionToken: newToken,
    evidence: { issuer: provider.issuer, subject: buyerSubject, sid: randomUUID(), email: "buyer-cutover@example.test", canonicalEmail: "buyer-cutover@example.test", emailVerified: true,
      name: "Buyer", primaryAt: at, primaryMethod: "password", totpStatus: "not_enrolled", totpAt: null, providerRevision: provider.providerRevision } }));
  expect(minted.ok).toBe(true);
  expect(await createOidcSessionResolver({ db, provider })({ token: newToken, now: new Date() })).not.toBeNull();
  expect((await db.select().from(identityAccounts).where(eq(identityAccounts.id, credentialId)))[0]).toEqual(beforeCredential[0]);
}, 30_000);
