import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { adminAuditEvents, identityAccounts, identityOidcOwnerLinks, identityRoleGrants, identityUsers } from "@pawket/database";
import { oidcOwnerLinkConfirmation, prepareOidcOwnerLink } from "../src/oidc-owner-link.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase(); const { db } = database;
const now = new Date("2026-09-27T10:00:00Z");
const provider = { issuer: "https://idp.example/pawket/", clientId: "synthetic", providerRevision: "v1" };
beforeAll(() => database.setup(), 30_000); afterAll(() => database.close());
beforeEach(() => db.update(identityRoleGrants).set({ state: "revoked", revokedAt: now }).where(eq(identityRoleGrants.state, "active")));
async function fixture(owner = true) {
  const userId = randomUUID(); const email = `${userId}@example.test`;
  await db.insert(identityUsers).values({ id: userId, name: "Synthetic", email, canonicalEmail: email, emailVerified: true,
    emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge" });
  if (owner) await db.insert(identityRoleGrants).values({ userId, role: "owner", grantSource: "bootstrap_cli" });
  const common = { provider, userId, subject: randomUUID(), operatorReference: "operator-fixture", evidenceReference: "provider-acceptance-fixture",
    applicationRevision: "synthetic-revision", confirmedRevision: "synthetic-revision", now };
  const apply = { ...common, mode: "apply" as const, invitation: randomBytes(32).toString("base64url"), confirmation: oidcOwnerLinkConfirmation(common) };
  return { common, apply };
}
describe("operator-pinned owner OIDC invitation", () => {
  test("dry run changes no user, role, mapping, invitation or audit", async () => {
    const { common } = await fixture();
    expect(await prepareOidcOwnerLink(db, { ...common, mode: "dry_run" })).toMatchObject({ mode: "dry_run", userId: common.userId, authorizationVersion: 1 });
    expect(await db.select().from(identityOidcOwnerLinks).where(eq(identityOidcOwnerLinks.userId, common.userId))).toHaveLength(0);
    expect(await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.actorUserId, common.userId))).toHaveLength(0);
    expect(await db.select().from(identityAccounts).where(eq(identityAccounts.userId, common.userId))).toHaveLength(0);
  });
  test("apply stores only a hash and audit metadata and never creates a session or role", async () => {
    const { apply } = await fixture(); const result = await prepareOidcOwnerLink(db, apply);
    expect(result).toMatchObject({ mode: "apply", authorizationVersion: 1 });
    const [pin] = await db.select().from(identityOidcOwnerLinks).where(eq(identityOidcOwnerLinks.userId, apply.userId));
    const audits = await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.actorUserId, apply.userId));
    expect(pin).toMatchObject({ subject: apply.subject, consumedAt: null, expiresAt: new Date(now.getTime() + 1_800_000) });
    expect(pin!.invitationHash).not.toBe(apply.invitation); expect(JSON.stringify([pin, audits, result])).not.toContain(apply.invitation);
    expect(audits).toHaveLength(1); expect(audits[0]?.action).toBe("identity.oidc_owner_link_prepared");
    expect(await db.select().from(identityRoleGrants).where(eq(identityRoleGrants.userId, apply.userId))).toHaveLength(1);
  });
  test("wrong revision, confirmation, non-owner and conflicting mapping fail closed", async () => {
    const { apply } = await fixture(); const nonOwner = await fixture(false);
    await expect(prepareOidcOwnerLink(db, { ...apply, confirmedRevision: "another" })).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    await expect(prepareOidcOwnerLink(db, { ...apply, confirmation: "wrong" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(prepareOidcOwnerLink(db, nonOwner.apply)).rejects.toMatchObject({ code: "OWNER_INELIGIBLE" });
    await db.insert(identityAccounts).values({ id: randomUUID(), userId: nonOwner.apply.userId, providerId: "authentik", issuer: provider.issuer, accountId: apply.subject, createdAt: now, updatedAt: now });
    await expect(prepareOidcOwnerLink(db, apply)).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  });
  test("concurrent pins do not overwrite each other and expired invitations can be replaced", async () => {
    const { apply } = await fixture();
    const results = await Promise.allSettled([prepareOidcOwnerLink(db, apply), prepareOidcOwnerLink(db, apply)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await prepareOidcOwnerLink(db, { ...apply, invitation: randomBytes(32).toString("base64url"), now: new Date(now.getTime() + 1_800_000) });
    const pins = await db.select().from(identityOidcOwnerLinks).where(eq(identityOidcOwnerLinks.userId, apply.userId));
    expect(pins).toHaveLength(2); expect(pins.filter((pin) => pin.consumedAt === null)).toHaveLength(1);
    expect(await db.select().from(adminAuditEvents).where(and(eq(adminAuditEvents.actorUserId, apply.userId), eq(adminAuditEvents.action, "identity.oidc_owner_link_prepared")))).toHaveLength(2);
  });
});
