import { and, count, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { appendAdminAuditEvent, identityAccounts, identityEmailHandoffs, identityExternalLinkTransactions,
  identityOidcCutover, identityOidcOwnerLinks, identityOidcPendingCommands, identityOidcTransactions,
  identityRoleGrants, identitySessions, identityStepUpProofs, identityUsers, identityVerifications,
  insertOutboxEvent, type PawketDatabase } from "@pawket/database";
import type { OidcSessionProvider } from "./oidc-session.js";

export class OidcCutoverError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "REVISION_MISMATCH" | "CONFIRMATION_REQUIRED" | "CUTOVER_CONFLICT" | "OWNER_NOT_READY" | "DELIVERY_IN_FLIGHT") { super(code); }
}
export type OidcCutoverInput = {
  provider: OidcSessionProvider; ownerUserId: string; operatorReference: string;
  acceptanceReference: string; backupReference: string; recoveryReference: string;
  applicationRevision: string; confirmedRevision: string; rollbackUntil: Date; backupRetainedUntil: Date; now: Date;
} & ({ mode: "dry_run" } | { mode: "apply"; confirmation: string; oldIssuersStopped: true });
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const credentials = ["email_verification", "password_reset", "email_change"];
export const oidcCutoverConfirmation = (input: Pick<OidcCutoverInput, "provider" | "applicationRevision">) => `CUTOVER_OIDC:${input.provider.clientId}:${input.applicationRevision}`;

/** Offline operation: drain/stop old web and delivery workers before apply.
 * Table locks bound the final database transition; they do not stop an SMTP send
 * already accepted by a provider. The explicit drain attestation is mandatory. */
export async function performOidcCutover(db: PawketDatabase, input: OidcCutoverInput) {
  const references = [input.ownerUserId, input.operatorReference, input.acceptanceReference, input.backupReference,
    input.recoveryReference, input.applicationRevision, input.confirmedRevision, input.provider.clientId, input.provider.providerRevision];
  let issuer: URL; try { issuer = new URL(input.provider.issuer); } catch { throw new OidcCutoverError("INVALID_INPUT"); }
  if (!references.every((v) => identifier.test(v)) || issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash ||
    ![input.now, input.rollbackUntil, input.backupRetainedUntil].every((v) => Number.isFinite(v.getTime())) ||
    input.rollbackUntil <= input.now || input.backupRetainedUntil < input.rollbackUntil) throw new OidcCutoverError("INVALID_INPUT");
  if (input.applicationRevision !== input.confirmedRevision) throw new OidcCutoverError("REVISION_MISMATCH");
  if (input.mode === "apply" && (input.confirmation !== oidcCutoverConfirmation(input) || !input.oldIssuersStopped)) throw new OidcCutoverError("CONFIRMATION_REQUIRED");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '30s'`);
    if (input.mode === "dry_run") await tx.execute(sql`set transaction read only`);
    else await tx.execute(sql`lock table identity_oidc_cutover, identity_users, identity_sessions, identity_accounts,
      identity_oidc_sessions, identity_oidc_transactions, identity_oidc_pending_commands, identity_oidc_owner_links,
      identity_step_up_proofs, identity_verifications, identity_external_link_transactions, identity_email_handoffs,
      identity_role_grants in exclusive mode`);
    const [existing] = await tx.select().from(identityOidcCutover).where(eq(identityOidcCutover.id, 1));
    if (existing) {
      if (existing.issuer !== input.provider.issuer || existing.clientId !== input.provider.clientId ||
        existing.providerRevision !== input.provider.providerRevision || existing.applicationRevision !== input.applicationRevision ||
        existing.ownerUserId !== input.ownerUserId || existing.operatorReference !== input.operatorReference ||
        existing.acceptanceReference !== input.acceptanceReference || existing.backupReference !== input.backupReference ||
        existing.recoveryReference !== input.recoveryReference || existing.rollbackUntil.getTime() !== input.rollbackUntil.getTime() ||
        existing.backupRetainedUntil.getTime() !== input.backupRetainedUntil.getTime()) throw new OidcCutoverError("CUTOVER_CONFLICT");
      return { mode: input.mode, alreadyApplied: true, activatedAt: existing.activatedAt.toISOString() };
    }
    const [owner] = await tx.select({ id: identityUsers.id }).from(identityUsers).innerJoin(identityRoleGrants, eq(identityUsers.id, identityRoleGrants.userId))
      .where(and(eq(identityUsers.id, input.ownerUserId), eq(identityUsers.accessStatus, "active"), eq(identityUsers.emailVerified, true), eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active")));
    const [pin] = await tx.select({ id: identityOidcOwnerLinks.id }).from(identityOidcOwnerLinks).where(and(eq(identityOidcOwnerLinks.userId, input.ownerUserId),
      eq(identityOidcOwnerLinks.issuer, input.provider.issuer), eq(identityOidcOwnerLinks.clientId, input.provider.clientId),
      eq(identityOidcOwnerLinks.providerRevision, input.provider.providerRevision), isNull(identityOidcOwnerLinks.consumedAt), gt(identityOidcOwnerLinks.expiresAt, input.now)));
    const [mapped] = await tx.select({ id: identityAccounts.id }).from(identityAccounts).where(and(eq(identityAccounts.userId, input.ownerUserId), eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, input.provider.issuer)));
    if (!owner || (!pin && !mapped)) throw new OidcCutoverError("OWNER_NOT_READY");
    const [processing] = await tx.select({ total: count() }).from(identityEmailHandoffs).where(and(inArray(identityEmailHandoffs.purpose, credentials), eq(identityEmailHandoffs.status, "processing"), gt(identityEmailHandoffs.leaseExpiresAt, input.now)));
    if (processing!.total > 0) throw new OidcCutoverError("DELIVERY_IN_FLIGHT");
    const [sessions] = await tx.select({ total: count() }).from(identitySessions).where(isNull(identitySessions.revokedAt));
    const [proofs] = await tx.select({ total: count() }).from(identityStepUpProofs).where(isNull(identityStepUpProofs.consumedAt));
    const [challenges] = await tx.select({ total: count() }).from(identityVerifications).where(isNull(identityVerifications.consumedAt));
    const handoffs = await tx.select({ id: identityEmailHandoffs.id, purpose: identityEmailHandoffs.purpose }).from(identityEmailHandoffs)
      .where(and(inArray(identityEmailHandoffs.purpose, credentials), isNull(identityEmailHandoffs.sentAt), ne(identityEmailHandoffs.status, "attention_required")));
    const totals = { sessions: sessions!.total, proofs: proofs!.total, challenges: challenges!.total, retiredEmails: handoffs.length };
    if (input.mode === "dry_run") return { mode: input.mode, alreadyApplied: false, totals };
    await tx.update(identitySessions).set({ revokedAt: input.now, revocationReason: "auth_moved", updatedAt: input.now }).where(isNull(identitySessions.revokedAt));
    await tx.update(identityStepUpProofs).set({ consumedAt: sql`greatest(${input.now.toISOString()}::timestamptz, issued_at)` }).where(isNull(identityStepUpProofs.consumedAt));
    await tx.update(identityVerifications).set({ consumedAt: input.now, updatedAt: input.now }).where(isNull(identityVerifications.consumedAt));
    await tx.update(identityExternalLinkTransactions).set({ status: "expired", resultCode: "auth_moved", consumedAt: input.now, updatedAt: input.now }).where(eq(identityExternalLinkTransactions.status, "pending"));
    await tx.update(identityOidcTransactions).set({ status: "failed", verifierEnvelope: null, completedAt: input.now }).where(inArray(identityOidcTransactions.status, ["pending", "exchanging"]));
    await tx.update(identityOidcPendingCommands).set({ consumedAt: input.now, payloadEnvelope: null }).where(isNull(identityOidcPendingCommands.consumedAt));
    for (const handoff of handoffs) {
      await tx.update(identityEmailHandoffs).set({ status: "attention_required", failureCode: "auth_moved", destinationEnvelope: null, secretEnvelope: null,
        lockedAt: null, lockedBy: null, leaseExpiresAt: null, updatedAt: input.now }).where(eq(identityEmailHandoffs.id, handoff.id));
      await insertOutboxEvent(tx, { eventType: "identity.credential_email_retired.v1", eventVersion: 1, aggregateType: "security_email_handoff", aggregateId: handoff.id,
        payload: { handoffId: handoff.id, purpose: handoff.purpose, reason: "auth_moved" }, occurredAt: input.now });
    }
    await tx.insert(identityOidcCutover).values({ id: 1, ...input.provider, applicationRevision: input.applicationRevision, ownerUserId: input.ownerUserId,
      operatorReference: input.operatorReference, acceptanceReference: input.acceptanceReference, backupReference: input.backupReference,
      recoveryReference: input.recoveryReference, activatedAt: input.now, rollbackUntil: input.rollbackUntil, backupRetainedUntil: input.backupRetainedUntil });
    await appendAdminAuditEvent(tx, { actorUserId: input.ownerUserId, actorSessionId: null, subjectType: "identity_oidc_cutover", subjectId: "1",
      action: "identity.oidc_cutover", outcome: "succeeded", reasonCode: "old_issuers_drained", beforeState: totals,
      afterState: { ...input.provider, operatorReference: input.operatorReference, acceptanceReference: input.acceptanceReference,
        backupReference: input.backupReference, recoveryReference: input.recoveryReference, rollbackUntil: input.rollbackUntil.toISOString(), backupRetainedUntil: input.backupRetainedUntil.toISOString() },
      assurance: { method: "operational_cli", oldIssuersStopped: true }, applicationRevision: input.applicationRevision,
      requestId: `oidc-cutover:${input.applicationRevision}`, occurredAt: input.now });
    return { mode: input.mode, alreadyApplied: false, totals, activatedAt: input.now.toISOString() };
  });
}
