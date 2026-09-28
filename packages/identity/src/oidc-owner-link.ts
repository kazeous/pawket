import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { appendAdminAuditEvent, identityAccounts, identityOidcOwnerLinks, identityRoleGrants, identityUsers, type PawketDatabase } from "@pawket/database";
import { hashOpaqueToken } from "@pawket/security";
import type { OidcSessionProvider } from "./oidc-session.js";
import { lockOidcRevocationScope } from "./oidc-transactions.js";

export class OidcOwnerLinkError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "REVISION_MISMATCH" | "OWNER_INELIGIBLE" | "IDENTITY_CONFLICT" | "INVITATION_EXISTS" | "CONFIRMATION_REQUIRED") { super(code); }
}
export type OidcOwnerLinkInput = {
  provider: OidcSessionProvider; userId: string; subject: string; operatorReference: string; evidenceReference: string;
  applicationRevision: string; confirmedRevision: string; now: Date;
} & ({ mode: "dry_run" } | { mode: "apply"; invitation: string; confirmation: string });
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const oidcOwnerLinkConfirmation = (input: Pick<OidcOwnerLinkInput, "userId" | "subject" | "applicationRevision">) =>
  `LINK_OWNER:${input.userId}:${input.subject}:${input.applicationRevision}`;

/** Pins an existing owner only. A signed fresh browser round still proves control. */
export async function prepareOidcOwnerLink(db: PawketDatabase, input: OidcOwnerLinkInput) {
  if (![input.userId, input.operatorReference, input.evidenceReference, input.applicationRevision, input.confirmedRevision].every((value) => identifier.test(value)) ||
    !uuid.test(input.subject) || !Number.isFinite(input.now.getTime())) throw new OidcOwnerLinkError("INVALID_INPUT");
  const issuer = new URL(input.provider.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash ||
    !identifier.test(input.provider.clientId) || !identifier.test(input.provider.providerRevision)) throw new OidcOwnerLinkError("INVALID_INPUT");
  if (input.applicationRevision !== input.confirmedRevision) throw new OidcOwnerLinkError("REVISION_MISMATCH");
  if (input.mode === "apply" && (input.confirmation !== oidcOwnerLinkConfirmation(input) || !/^[A-Za-z0-9_-]{43}$/u.test(input.invitation))) throw new OidcOwnerLinkError("CONFIRMATION_REQUIRED");
  return db.transaction(async (tx) => {
    await lockOidcRevocationScope(tx, { issuer: input.provider.issuer, clientId: input.provider.clientId, subject: input.subject });
    const [user] = await tx.select().from(identityUsers).where(eq(identityUsers.id, input.userId)).for("update");
    const [owner] = await tx.select().from(identityRoleGrants).where(and(eq(identityRoleGrants.userId, input.userId),
      eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active"))).for("share");
    if (!user || !owner || user.accessStatus !== "active" || !user.emailVerified) throw new OidcOwnerLinkError("OWNER_INELIGIBLE");
    const mapped = await tx.select({ id: identityAccounts.id }).from(identityAccounts).where(and(
      eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, input.provider.issuer),
      or(eq(identityAccounts.userId, input.userId), eq(identityAccounts.accountId, input.subject))));
    if (mapped.length) throw new OidcOwnerLinkError("IDENTITY_CONFLICT");
    const pending = await tx.select().from(identityOidcOwnerLinks).where(and(isNull(identityOidcOwnerLinks.consumedAt),
      or(eq(identityOidcOwnerLinks.userId, input.userId), and(eq(identityOidcOwnerLinks.issuer, input.provider.issuer), eq(identityOidcOwnerLinks.subject, input.subject))))).for("update");
    if (pending.some((item) => item.expiresAt > input.now)) throw new OidcOwnerLinkError("INVITATION_EXISTS");
    const result = { userId: user.id, subject: input.subject, issuer: input.provider.issuer, clientId: input.provider.clientId,
      providerRevision: input.provider.providerRevision, authorizationVersion: user.authorizationVersion, mode: input.mode };
    if (input.mode === "dry_run") return result;
    for (const expired of pending) await tx.update(identityOidcOwnerLinks).set({ consumedAt: input.now }).where(eq(identityOidcOwnerLinks.id, expired.id));
    const id = randomUUID(); const expiresAt = new Date(input.now.getTime() + 1_800_000);
    await tx.insert(identityOidcOwnerLinks).values({ id, ...input.provider, userId: user.id, subject: input.subject,
      invitationHash: hashOpaqueToken(input.invitation, "oidc-owner-link"), approvedAt: input.now, expiresAt });
    await appendAdminAuditEvent(tx, { actorUserId: user.id, actorSessionId: null, subjectType: "identity_oidc_owner_link", subjectId: id,
      action: "identity.oidc_owner_link_prepared", outcome: "succeeded", reasonCode: "operator_pinned_mapping",
      beforeState: { accessRevision: user.authorizationVersion }, afterState: { userId: user.id, subject: input.subject, issuer: input.provider.issuer,
        clientId: input.provider.clientId, providerRevision: input.provider.providerRevision, accessRevision: user.authorizationVersion, expiresAt: expiresAt.toISOString(),
        operatorReference: input.operatorReference, evidenceReference: input.evidenceReference },
      assurance: { method: "operational_cli", browserProof: "required" }, applicationRevision: input.applicationRevision,
      requestId: `oidc-owner-link:${id}`, occurredAt: input.now });
    return { ...result, expiresAt: expiresAt.toISOString() };
  });
}
