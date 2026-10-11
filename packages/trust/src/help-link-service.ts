import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { identityEmailAddresses, trustHelpLinkRequests, trustHelpLinks, trustHelpSessions, trustPenalties,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { canonicalizeEmailAddress } from "@pawket/identity/email-address";
import type { EnforcementNoticePort } from "@pawket/identity";
import { createLookupHmac } from "@pawket/security";
import { effectiveEnforcementDeadline } from "./enforcement-deadlines.js";
import { TRUST_ENFORCEMENT_POLICY as policy, TrustEnforcementError, trustFail, type TrustEnforcementMode } from "./enforcement-policy.js";
import { validUuid } from "./report-policy.js";

type Input = { db: PawketDatabase; mode: TrustEnforcementMode; lookupHmacKey: Uint8Array; notices: EnforcementNoticePort;
  now?(): Date; idFactory?(): string; randomBytes?(size: number): Uint8Array };
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const networkPattern = /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u;
const hash = (value: string) => `sha256:v1:${createHash("sha256").update(value).digest("hex")}`;
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);
function time(at: Date) {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) trustFail("invalid_request");
  return new Date(at);
}
function tokenValid(token: unknown): token is string {
  return typeof token === "string" && tokenPattern.test(token) && Buffer.from(token, "base64url").toString("base64url") === token;
}
type Penalty = typeof trustPenalties.$inferSelect;
function active(p: Penalty, at: Date) { return p.state === "active" && p.startsAt <= at && (p.endsAt === null || p.endsAt > at); }
function readable(p: Penalty, at: Date) {
  const until = plus(p.createdAt, policy.helpReadOnlyMs);
  return p.target === "account" && (p.kind === "suspension" || p.kind === "removal") && p.createdAt <= at && until > at
    && (active(p, at) || (p.state === "reversed" || p.state === "reduced") && p.endedAt !== null && p.endedAt <= at && p.endedAt < until);
}

export function createHelpLinkService(input: Input) {
  if (!["disabled", "enabled"].includes(input.mode) || input.lookupHmacKey.length < 32 || typeof input.notices?.queue !== "function") trustFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date());
  const factory = input.idFactory ?? randomUUID; const bytes = input.randomBytes ?? randomBytes;
  const id = () => { const value = factory(); if (!validUuid(value)) trustFail("dependency_unavailable"); return value; };
  const token = () => { const value = bytes(32); if (!(value instanceof Uint8Array) || value.length !== 32) trustFail("dependency_unavailable"); return Buffer.from(value).toString("base64url"); };
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) { if (error instanceof TrustEnforcementError) throw error; return trustFail("dependency_unavailable"); }
  }
  async function issue(tx: PawketTransaction, command: { userId: string; penaltyId: string; at: Date }): Promise<{ token: string }> {
    if (input.mode !== "enabled") trustFail("enforcement_disabled");
    const at = time(command.at);
    if (!validUuid(command.penaltyId) || typeof command.userId !== "string") trustFail("not_available");
    return boundary(async () => {
      // Serialize issuance for a penalty so concurrent resends leave exactly one live link.
      const [p] = await tx.select().from(trustPenalties).where(and(eq(trustPenalties.id, command.penaltyId), eq(trustPenalties.subjectUserId, command.userId))).limit(1).for("update");
      if (!p || !active(p, at) || !readable(p, at)) trustFail("not_available");
      const revoked = await tx.update(trustHelpLinks).set({ revokedAt: at }).where(and(eq(trustHelpLinks.penaltyId, p.id), isNull(trustHelpLinks.revokedAt))).returning({ id: trustHelpLinks.id });
      if (revoked.length) await tx.update(trustHelpSessions).set({ revokedAt: at }).where(and(inArray(trustHelpSessions.linkId, revoked.map((l) => l.id)), isNull(trustHelpSessions.revokedAt)));
      const secret = token();
      await tx.insert(trustHelpLinks).values({ id: id(), tokenHash: hash(secret), userId: p.subjectUserId, penaltyId: p.id,
        issuedAt: at, appealUntil: plus(p.createdAt, policy.helpLinkAppealMs), readUntil: plus(p.createdAt, policy.helpReadOnlyMs) });
      return { token: secret };
    });
  }
  return {
    issue,
    async openSession(command: { token: string; networkKeyHmac: string }): Promise<{ sessionToken: string; penaltyId: string; expiresAt: Date }> {
      if (!tokenValid(command.token) || !networkPattern.test(command.networkKeyHmac)) trustFail("not_available");
      return boundary(() => input.db.transaction(async (tx) => {
        // Lock the penalty before the link, matching issuance; neither path takes an identity/fence lock afterwards.
        const [candidate] = await tx.select({ penaltyId: trustHelpLinks.penaltyId }).from(trustHelpLinks).where(eq(trustHelpLinks.tokenHash, hash(command.token))).limit(1);
        if (!candidate) trustFail("not_available");
        const [p] = await tx.select().from(trustPenalties).where(eq(trustPenalties.id, candidate.penaltyId)).limit(1).for("share");
        const [link] = await tx.select().from(trustHelpLinks).where(and(eq(trustHelpLinks.tokenHash, hash(command.token)), isNull(trustHelpLinks.revokedAt))).limit(1).for("share");
        const at = time(clock());
        if (!p || !link || link.userId !== p.subjectUserId || link.penaltyId !== p.id || link.issuedAt > at || link.readUntil <= at || !readable(p, at)) trustFail("not_available");
        const sessionToken = token(); const expiresAt = plus(at, policy.helpSessionMs);
        await tx.insert(trustHelpSessions).values({ id: id(), sessionHash: hash(sessionToken), linkId: link.id, userId: link.userId, penaltyId: p.id, createdAt: at, expiresAt });
        return { sessionToken, penaltyId: p.id, expiresAt };
      }));
    },
    async readSession(sessionToken: string): Promise<{ userId: string; penaltyId: string; canAppeal: boolean; readOnlyUntil: Date } | null> {
      if (!tokenValid(sessionToken)) return null;
      return boundary(() => input.db.transaction(async (tx) => {
        const at = time(clock());
        const [row] = await tx.select({ session: trustHelpSessions, link: trustHelpLinks, penalty: trustPenalties }).from(trustHelpSessions)
          .innerJoin(trustHelpLinks, eq(trustHelpLinks.id, trustHelpSessions.linkId)).innerJoin(trustPenalties, eq(trustPenalties.id, trustHelpSessions.penaltyId))
          .where(and(eq(trustHelpSessions.sessionHash, hash(sessionToken)), isNull(trustHelpSessions.revokedAt), isNull(trustHelpLinks.revokedAt),
            lte(trustHelpSessions.createdAt, at), gt(trustHelpSessions.expiresAt, at), gt(trustHelpLinks.readUntil, at))).limit(1);
        if (!row || row.session.userId !== row.link.userId || row.link.penaltyId !== row.penalty.id || row.session.userId !== row.penalty.subjectUserId || !readable(row.penalty, at)) return null;
        const deadline = await effectiveEnforcementDeadline(tx, plus(row.penalty.createdAt, policy.appealWindowMs));
        return { userId: row.session.userId, penaltyId: row.penalty.id, canAppeal: input.mode === "enabled" && active(row.penalty, at) && deadline !== null && deadline > at, readOnlyUntil: row.link.readUntil };
      }));
    },
    async requestLink(command: { email: string; networkKeyHmac: string }): Promise<void> {
      if (typeof command.email !== "string" || !networkPattern.test(command.networkKeyHmac)) return;
      let canonical: string;
      try { canonical = canonicalizeEmailAddress(command.email).canonical; } catch { return; }
      const addressHmac = createLookupHmac({ key, context: "trust-help-link-address", value: canonical });
      await boundary(() => input.db.transaction(async (tx) => {
        // Address then network advisory locks serialize both independent quotas, including unknown addresses.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trust:help-address:${addressHmac}`}, 0))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trust:help-network:${command.networkKeyHmac}`}, 0))`);
        const at = time(clock());
        const [counts] = await tx.select({ address: sql<number>`count(*) filter (where ${trustHelpLinkRequests.addressHmac} = ${addressHmac})::int`,
          network: sql<number>`count(*) filter (where ${trustHelpLinkRequests.networkKeyHmac} = ${command.networkKeyHmac} and ${trustHelpLinkRequests.createdAt} > ${plus(at, -policy.linkNetworkWindowMs).toISOString()}::timestamptz)::int` })
          .from(trustHelpLinkRequests).where(and(gt(trustHelpLinkRequests.createdAt, plus(at, -policy.linkAddressWindowMs)), lte(trustHelpLinkRequests.createdAt, at),
            or(eq(trustHelpLinkRequests.addressHmac, addressHmac), eq(trustHelpLinkRequests.networkKeyHmac, command.networkKeyHmac))));
        if (!counts) trustFail("dependency_unavailable");
        const limited = counts.address >= policy.linkRequestsPerAddress || counts.network >= policy.linkRequestsPerNetwork;
        // One joined lookup for every valid address, even when rate limited or disabled. No early account-existence branch.
        const [p] = await tx.select({ penalty: trustPenalties }).from(identityEmailAddresses)
          .innerJoin(trustPenalties, eq(trustPenalties.subjectUserId, identityEmailAddresses.userId))
          .where(and(eq(identityEmailAddresses.canonicalEmail, canonical), eq(identityEmailAddresses.status, "primary"), isNotNull(identityEmailAddresses.verifiedAt),
            eq(trustPenalties.target, "account"), inArray(trustPenalties.kind, ["suspension", "removal"]), eq(trustPenalties.state, "active"), lte(trustPenalties.startsAt, at),
            or(isNull(trustPenalties.endsAt), gt(trustPenalties.endsAt, at)), gt(sql`${trustPenalties.createdAt} + interval '90 days'`, at.toISOString())))
          .orderBy(desc(trustPenalties.createdAt), desc(trustPenalties.id)).limit(1);
        let outcome: "issued" | "ignored" | "rate_limited" = limited ? "rate_limited" : "ignored";
        if (!limited && input.mode === "enabled" && p) {
          // Recheck after acquiring the penalty lock: it may have ended during the lookup.
          const [current] = await tx.select().from(trustPenalties).where(eq(trustPenalties.id, p.penalty.id)).limit(1).for("update");
          const issuedAt = time(clock());
          if (current && active(current, issuedAt) && readable(current, issuedAt)) {
            const { token } = await issue(tx, { userId: current.subjectUserId, penaltyId: current.id, at: issuedAt });
            await input.notices.queue(tx, { userId: current.subjectUserId, penaltyId: current.id, token, kind: current.kind as "suspension" | "removal", endsAt: current.endsAt, at: issuedAt });
            outcome = "issued";
          }
        }
        await tx.insert(trustHelpLinkRequests).values({ id: id(), networkKeyHmac: command.networkKeyHmac, addressHmac, outcome, createdAt: at, expiresAt: plus(at, policy.linkAddressWindowMs) });
      })).catch(() => undefined); // Dependency/delivery failures also disclose no address outcome on resends.
    },
  };
}
export type HelpLinkService = ReturnType<typeof createHelpLinkService>;
