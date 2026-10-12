import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { decryptSensitiveField, encryptSensitiveField } from "@pawket/security";
import { createEnforcementNoticePort } from "@pawket/identity";
import { createHelpLinkService } from "../src/help-link-service.js";
import { createHelpCaseService } from "../src/help-case-service.js";
import type { EnforcementNoticePort } from "../src/index.js";
import { createPenaltyService } from "../src/penalty-service.js";
import { createAppealService } from "../src/appeal-service.js";
import { createContentHideService } from "../src/content-hide-service.js";
import { recordEnforcementModeTransition } from "../src/enforcement-deadlines.js";
import { createReportFixture, fixtureKeyring, fixtureLookupKey, reportAt } from "./report-fixture.js";
import { canonicalizeHelpEmail, penaltyContext } from "./penalty-service-fixture.js";
const f = createReportFixture("help_links"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const network = (n = 1) => `hmac-sha256:v1:${Buffer.alloc(32, n).toString("base64url")}`;
const digest = (token: string) => `sha256:v1:${createHash("sha256").update(token).digest("hex")}`;
const helpInput = { canonicalizeEmail: canonicalizeHelpEmail, logger: { error: vi.fn() } };
async function context(verified = true, shape: { kind: "suspension" | "removal"; target: "account" | "creator_capability"; endsAt?: string } = { kind: "suspension", target: "account" }) {
  const c = await penaltyContext(f); const email = `locked-${randomUUID()}@example.invalid`;
  if (verified) await f.db.insert(schema.identityEmailAddresses).values({ userId: c.p.creator.userId, displayEmail: email, canonicalEmail: email, status: "primary", verifiedAt: reportAt, verificationProvenance: "provider_assertion" });
  let at = reportAt; const notices: EnforcementNoticePort = createEnforcementNoticePort({ keyring: fixtureKeyring });
  const helpLinks = createHelpLinkService({ ...helpInput, db: f.db, mode: "enabled", lookupHmacKey: fixtureLookupKey, notices, now: () => at });
  const service = createPenaltyService({ ...c.input, helpLinks, notices }); const command = { ...await c.command(), ...shape };
  const result = await service.apply(command);
  const [handoff] = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, c.p.creator.userId));
  const token = handoff?.secretEnvelope ? decryptSensitiveField({ envelope: handoff.secretEnvelope, keyring: fixtureKeyring,
    binding: { recordType: "identity_email_handoff", recordId: handoff.id, fieldName: "secret" } }) : null;
  return { ...c, email, helpLinks, service, command, ...result, handoff, token, setTime: (value: Date) => { at = value; } };
}
test("account suspension queues one enforcement_notice handoff with the token only in the secret envelope", async () => {
  const c = await context(); await c.service.apply(c.command);
  const handoffs = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, c.p.creator.userId));
  expect(handoffs).toHaveLength(1); expect(c.handoff).toMatchObject({ purpose: "enforcement_notice", templateData: { kind: "suspension", endsAt: "" }, status: "pending" });
  expect(c.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const [link] = await f.db.select().from(schema.trustHelpLinks).where(eq(schema.trustHelpLinks.penaltyId, c.penaltyId));
  expect(link).toMatchObject({ userId: c.p.creator.userId, tokenHash: digest(c.token!), appealUntil: new Date(reportAt.getTime() + 14 * 86_400_000), readUntil: new Date(reportAt.getTime() + 90 * 86_400_000) });
  const outbox = await f.db.select().from(schema.systemOutbox); const audit = await f.db.select().from(schema.adminAuditEvents);
  expect(JSON.stringify([link, outbox, audit, c.handoff?.templateData])).not.toContain(c.token!);
  expect(JSON.stringify([outbox, audit, c.handoff])).not.toContain(c.email);
  expect(JSON.stringify(c.handoff)).not.toContain("Private explanation");
});
test("account removal sends a removal notice; creator-capability suspension sends no email", async () => {
  const removed = await context(true, { kind: "removal", target: "account" }); expect(removed.handoff?.templateData).toEqual({ kind: "removal", endsAt: "" });
  const c = await context(true, { kind: "suspension", target: "creator_capability" }); expect(c.handoff).toBeUndefined();
  expect(await f.db.select().from(schema.trustHelpLinks).where(eq(schema.trustHelpLinks.penaltyId, c.penaltyId))).toEqual([]);
});
test("no primary verified destination records attention_required without a token or destination", async () => {
  const c = await context(false); expect(c.handoff).toMatchObject({ status: "attention_required", failureCode: "no_verified_destination", secretEnvelope: null, destinationEnvelope: null });
});
test("openSession returns a 30-minute session for a fresh token; session expires at its boundary", async () => {
  const c = await context(); const opened = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() });
  expect(opened.expiresAt).toEqual(new Date(reportAt.getTime() + 1_800_000)); expect(opened.penaltyId).toBe(c.penaltyId);
  expect(await c.helpLinks.readSession(opened.sessionToken)).toMatchObject({ userId: c.p.creator.userId, penaltyId: c.penaltyId, canAppeal: true });
  const [stored] = await f.db.select().from(schema.trustHelpSessions).where(eq(schema.trustHelpSessions.penaltyId, c.penaltyId)); expect(stored?.sessionHash).toBe(digest(opened.sessionToken));
  c.setTime(opened.expiresAt); expect(await c.helpLinks.readSession(opened.sessionToken)).toBeNull();
});

test("help case read is session-scoped, allowlisted and unavailable while disabled or revoked", async () => {
  const c = await context(); const opened = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() });
  const help = createHelpCaseService({ db: f.db, keyring: fixtureKeyring, mode: "enabled", helpLinks: c.helpLinks });
  const view = await help.read(opened.sessionToken);
  expect(view).toMatchObject({ penaltyId: c.penaltyId, kind: "suspension", explanation: c.command.explanation.normalize("NFC"), canAppeal: true, appeal: null });
  expect(Object.keys(view!).sort()).toEqual(["penaltyId", "kind", "state", "explanation", "startsAt", "endsAt", "enforcementPolicyRevisionId", "canAppeal", "appeal", "readOnlyUntil"].sort());
  for (const secret of [c.p.creator.userId, c.p.buyer.userId, c.token!, opened.sessionToken, c.command.source.caseId]) expect(JSON.stringify(view)).not.toContain(secret);
  expect(await help.read("invalid")).toBeNull();
  expect(await createHelpCaseService({ db: f.db, keyring: fixtureKeyring, mode: "disabled", helpLinks: c.helpLinks }).read(opened.sessionToken)).toBeNull();
  await c.helpLinks.revokeSession(opened.sessionToken); await c.helpLinks.revokeSession(opened.sessionToken);
  expect(await c.helpLinks.readSession(opened.sessionToken)).toBeNull(); expect(await help.read(opened.sessionToken)).toBeNull();
  // Ending one session must not revoke the signed link or other independently exchanged sessions.
  expect(await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() })).toMatchObject({ penaltyId: c.penaltyId });
});
test("help case read includes only appeal status and decided reasoning, and suppresses a second appeal", async () => {
  const c = await context(); const opened = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() });
  const help = createHelpCaseService({ db: f.db, keyring: fixtureKeyring, mode: "enabled", helpLinks: c.helpLinks });
  const appeals = createAppealService({ ...c.input, penalties: c.service, hides: createContentHideService(c.input), helpLinks: c.helpLinks });
  const result = await appeals.submit({ appellant: { kind: "help_session", sessionToken: opened.sessionToken }, target: { penaltyId: c.penaltyId }, statement: "Private appeal statement", idempotencyKey: randomUUID(), requestId: randomUUID() });
  expect(await help.read(opened.sessionToken)).toMatchObject({ canAppeal: false, appeal: { state: "open", reasoning: null, decidedAt: null } });
  const decidedAt = reportAt;
  await appeals.decide({ ...await c.base("owner.trust_appeal_decide"), caseId: result.caseId, expectedCaseVersion: 1, decision: "upheld", reasoning: "Published decision" });
  const view = await help.read(opened.sessionToken);
  expect(view?.appeal).toEqual({ state: "upheld", reasoning: "Published decision", decidedAt: decidedAt.toISOString() });
  for (const secret of [result.caseId, result.appealId, "Private appeal statement"]) expect(JSON.stringify(view)).not.toContain(secret);
});

test("help canAppeal and signed-in appeal use startsAt even when createdAt differs", async () => {
  const c = await penaltyContext(f); const penaltyId = randomUUID();
  const startsAt = new Date(reportAt.getTime() + 86_400_000); let at = startsAt;
  await f.db.insert(schema.trustPenalties).values({ id: penaltyId, subjectUserId: c.p.creator.userId, kind: "suspension", target: "account", reasonCategory: "other", sourceCaseId: c.caseId,
    explanationEnvelope: encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "Synthetic explanation", binding: { recordType: "trust_penalties", recordId: penaltyId, fieldName: "explanation" } }),
    startsAt, createdAt: reportAt, ownerUserId: c.owner.userId, ownerSessionId: c.owner.sessionId, stepUpProofId: randomUUID(), requestId: randomUUID() });
  const now = () => at;
  const helpLinks = createHelpLinkService({ ...c.input, ...helpInput, now });
  const appeals = createAppealService({ ...c.input, now, penalties: c.service, hides: createContentHideService(c.input), helpLinks });
  const { token } = await f.db.transaction((tx) => helpLinks.issue(tx, { userId: c.p.creator.userId, penaltyId, at }));
  const deadline = new Date(startsAt.getTime() + 14 * 86_400_000);
  at = new Date(deadline.getTime() - 1);
  const { sessionToken } = await helpLinks.openSession({ token, networkKeyHmac: network() });
  const command = { appellant: { kind: "session" as const, actor: c.p.creator }, target: { penaltyId }, statement: "Appeal", idempotencyKey: randomUUID(), requestId: randomUUID() };
  // Check the exact boundary before submitting just inside it, so duplicate detection cannot mask the window.
  at = deadline;
  expect((await helpLinks.readSession(sessionToken))?.canAppeal).toBe(false);
  await expect(appeals.submit(command)).rejects.toMatchObject({ code: "window_closed" });
  at = new Date(deadline.getTime() - 1);
  expect((await helpLinks.readSession(sessionToken))?.canAppeal).toBe(true);
  await expect(appeals.submit(command)).resolves.toMatchObject({ appealId: expect.any(String) });
});
test("a link permits five sessions per rolling 30 minutes, including concurrent opens and revoked sessions", async () => {
  const c = await context();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network(60 + i) })));
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  for (const r of attempts.filter((r) => r.status === "rejected")) expect(r.reason).toMatchObject({ code: "not_available" });
  const sessions = await f.db.select().from(schema.trustHelpSessions).where(eq(schema.trustHelpSessions.penaltyId, c.penaltyId));
  expect(sessions).toHaveLength(5);
  await f.db.update(schema.trustHelpSessions).set({ revokedAt: reportAt }).where(eq(schema.trustHelpSessions.id, sessions[0]!.id));
  c.setTime(new Date(reportAt.getTime() + 1_799_999));
  await expect(c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network(70) })).rejects.toMatchObject({ code: "not_available" });
  const other = await context();
  await expect(other.helpLinks.openSession({ token: other.token!, networkKeyHmac: network(70) })).resolves.toMatchObject({ penaltyId: other.penaltyId });
  c.setTime(new Date(reportAt.getTime() + 1_800_000));
  await expect(c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network(70) })).resolves.toMatchObject({ penaltyId: c.penaltyId });
});

test.each(["session", "resend", "issue"] as const)("a lift holding the user row and a concurrent help %s finish without deadlock", async (operation) => {
  const c = await context(); const held = Promise.withResolvers<void>(); const readerStarted = Promise.withResolvers<number>();
  let firstLock = true;
  const identity = { ...c.identity, async lockSubject(tx: schema.PawketTransaction, userId: string) {
    const subject = await c.identity.lockSubject(tx, userId);
    if (firstLock) {
      firstLock = false;
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const [writer] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      held.resolve(); const readerPid = await readerStarted.promise;
      // Observe the second connection blocked on this writer before the lift locks the penalty.
      const deadline = Date.now() + 4_000;
      for (;;) {
        const [row] = await tx.execute<{ blocked: boolean }>(sql`select ${writer!.pid} = any(pg_blocking_pids(${readerPid})) as blocked`);
        if (row?.blocked) break;
        if (Date.now() >= deadline) throw new Error("Help connection did not wait for the user lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return subject;
  } };
  const db = { transaction: <T>(run: (tx: schema.PawketTransaction) => Promise<T>) => f.db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '8s'`);
    const [reader] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    readerStarted.resolve(reader!.pid); return run(tx);
  }) } as schema.PawketDatabase;
  const logger = { error: vi.fn() };
  const helpLinks = createHelpLinkService({ ...helpInput, ...c.input, db, logger });
  const service = createPenaltyService({ ...c.input, identity });
  const liftCommand = { ...await c.base("owner.trust_penalty_lift"), penaltyId: c.penaltyId, reason: "Reviewed" };
  const lift = service.lift(liftCommand);
  await Promise.race([held.promise, lift]);
  const help = operation === "session" ? helpLinks.openSession({ token: c.token!, networkKeyHmac: network(71) })
    : operation === "resend" ? helpLinks.requestLink({ email: c.email, networkKeyHmac: network(71) })
    : db.transaction((tx) => helpLinks.issue(tx, { userId: c.p.creator.userId, penaltyId: c.penaltyId, at: reportAt }));
  const [liftResult, helpResult] = await Promise.allSettled([lift, help]);
  expect(liftResult).toEqual({ status: "fulfilled", value: undefined });
  if (operation === "resend") expect(helpResult).toEqual({ status: "fulfilled", value: undefined });
  else {
    expect(helpResult.status).toBe("rejected");
    if (helpResult.status === "rejected") expect(helpResult.reason).toMatchObject({ code: "not_available" });
  }
  expect(logger.error).not.toHaveBeenCalled();
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, c.penaltyId)))[0]?.state).toBe("lifted");
  expect(await f.db.select().from(schema.trustHelpSessions).where(eq(schema.trustHelpSessions.penaltyId, c.penaltyId))).toEqual([]);
  expect(await f.db.select().from(schema.trustHelpLinks).where(eq(schema.trustHelpLinks.penaltyId, c.penaltyId))).toHaveLength(1);
}, 15_000);
test("revoked, expired and foreign tokens are refused without revealing the case; resends revoke sessions too", async () => {
  const c = await context(); const opened = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() });
  const fresh = await f.db.transaction((tx) => c.helpLinks.issue(tx, { userId: c.p.creator.userId, penaltyId: c.penaltyId, at: reportAt }));
  for (const token of [c.token!, Buffer.alloc(32, 99).toString("base64url"), "foreign#token"]) await expect(c.helpLinks.openSession({ token, networkKeyHmac: network() })).rejects.toMatchObject({ code: "not_available" });
  expect(await c.helpLinks.readSession(opened.sessionToken)).toBeNull();
  await expect(f.db.transaction((tx) => c.helpLinks.issue(tx, { userId: c.p.buyer.userId, penaltyId: c.penaltyId, at: reportAt }))).rejects.toMatchObject({ code: "not_available" });
  c.setTime(new Date(reportAt.getTime() + 90 * 86_400_000)); await expect(c.helpLinks.openSession({ token: fresh.token, networkKeyHmac: network() })).rejects.toMatchObject({ code: "not_available" });
});
test("requestLink answers identically for unknown, active-account and locked emails and revokes earlier links", async () => {
  const c = await context(); const active = await f.person(); const email = `active-${randomUUID()}@example.invalid`;
  await f.db.insert(schema.identityEmailAddresses).values({ userId: active, displayEmail: email, canonicalEmail: email, status: "primary", verifiedAt: reportAt, verificationProvenance: "provider_assertion" });
  for (const address of [`unknown-${randomUUID()}@example.invalid`, email, `  ${c.email.toUpperCase()}  `]) expect(await c.helpLinks.requestLink({ email: address, networkKeyHmac: network(2) })).toBeUndefined();
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, c.p.creator.userId))).toHaveLength(2);
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, active))).toEqual([]);
  await expect(c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() })).rejects.toMatchObject({ code: "not_available" });
});
test("requestLink limits to 3 per address per day and 10 per network per hour, including concurrent requests", async () => {
  const c = await context(); await Promise.all(Array.from({ length: 6 }, (_, i) => c.helpLinks.requestLink({ email: c.email, networkKeyHmac: network(10 + i) })));
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, c.p.creator.userId))).toHaveLength(4);
  const d = await context(); for (let i = 0; i < 10; i++) await d.helpLinks.requestLink({ email: `unknown-${randomUUID()}@example.invalid`, networkKeyHmac: network(30) });
  await d.helpLinks.requestLink({ email: d.email, networkKeyHmac: network(30) });
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, d.p.creator.userId))).toHaveLength(1);
  d.setTime(new Date(reportAt.getTime() + 3_600_000)); await d.helpLinks.requestLink({ email: d.email, networkKeyHmac: network(30) });
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, d.p.creator.userId))).toHaveLength(2);
  c.setTime(new Date(reportAt.getTime() + 86_400_000)); await c.helpLinks.requestLink({ email: c.email, networkKeyHmac: network(31) });
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, c.p.creator.userId))).toHaveLength(5);
});
test("rate-limited requests never grow the request ledger", async () => {
  const c = await context(); const networkKeyHmac = network(99);
  for (let i = 0; i < 3; i++) await c.helpLinks.requestLink({ email: c.email, networkKeyHmac });
  const rows = () => f.db.select().from(schema.trustHelpLinkRequests).where(eq(schema.trustHelpLinkRequests.networkKeyHmac, networkKeyHmac));
  expect(await rows()).toHaveLength(3);
  await Promise.all(Array.from({ length: 6 }, () => c.helpLinks.requestLink({ email: c.email, networkKeyHmac })));
  expect(await rows()).toHaveLength(3);
});
test("disabled, unverified, creator-only and past-read-window resends are ignored with the same result", async () => {
  const c = await context();
  const disabled = createHelpLinkService({ ...helpInput, db: f.db, mode: "disabled", lookupHmacKey: fixtureLookupKey, notices: createEnforcementNoticePort({ keyring: fixtureKeyring }), now: () => reportAt });
  expect(await disabled.requestLink({ email: c.email, networkKeyHmac: network(40) })).toBeUndefined();
  c.setTime(new Date(reportAt.getTime() + 90 * 86_400_000)); expect(await c.helpLinks.requestLink({ email: c.email, networkKeyHmac: network(41) })).toBeUndefined();
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, c.p.creator.userId))).toHaveLength(1);
  const unverified = await context(false); await f.db.insert(schema.identityEmailAddresses).values({ userId: unverified.p.creator.userId, displayEmail: unverified.email, canonicalEmail: unverified.email, status: "primary" });
  expect(await unverified.helpLinks.requestLink({ email: unverified.email, networkKeyHmac: network(42) })).toBeUndefined();
  expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, unverified.p.creator.userId))).toHaveLength(1);
  const creator = await context(true, { kind: "suspension", target: "creator_capability" });
  expect(await creator.helpLinks.requestLink({ email: creator.email, networkKeyHmac: network(43) })).toBeUndefined(); expect(creator.handoff).toBeUndefined();
});
test("a still-live session cannot outlast the original 90-day read window", async () => {
  const c = await context(); c.setTime(new Date(reportAt.getTime() + 90 * 86_400_000 - 60_000));
  const opened = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() });
  expect(await c.helpLinks.readSession(opened.sessionToken)).not.toBeNull();
  c.setTime(new Date(reportAt.getTime() + 90 * 86_400_000)); expect(await c.helpLinks.readSession(opened.sessionToken)).toBeNull();
});
test.each(["expired", "lifted", "reversed", "reduced"] as const)("ended penalty %s only remains readable for reversal or reduction", async (state) => {
  const at = state === "expired" ? new Date(reportAt.getTime() + 1_000) : reportAt;
  const c = await context(true, { kind: "suspension", target: "account", ...(state === "expired" ? { endsAt: at.toISOString() } : {}) }); c.setTime(at);
  await f.db.transaction((tx) => c.service.end(tx, { penaltyId: c.penaltyId, state, actor: null, requestId: randomUUID(), at, reason: null }));
  if (state === "reversed" || state === "reduced") {
    const opened = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() }); expect((await c.helpLinks.readSession(opened.sessionToken))?.canAppeal).toBe(false);
  } else await expect(c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() })).rejects.toMatchObject({ code: "not_available" });
});
test("appeal checks effective deadline while read-only expiry and penalty expiry keep running", async () => {
  const c = await context(); await recordEnforcementModeTransition(f.db, { mode: "disabled", at: new Date(reportAt.getTime() + 13 * 86_400_000) });
  c.setTime(new Date(reportAt.getTime() + 15 * 86_400_000));
  const disabled = createHelpLinkService({ ...helpInput, db: f.db, mode: "disabled", lookupHmacKey: fixtureLookupKey, notices: createEnforcementNoticePort({ keyring: fixtureKeyring }), now: () => new Date(reportAt.getTime() + 15 * 86_400_000) });
  const session = await disabled.openSession({ token: c.token!, networkKeyHmac: network() }); expect((await disabled.readSession(session.sessionToken))?.canAppeal).toBe(false);
  await recordEnforcementModeTransition(f.db, { mode: "enabled", at: new Date(reportAt.getTime() + 15 * 86_400_000) });
  expect((await c.helpLinks.readSession(session.sessionToken))?.canAppeal).toBe(true);
  c.setTime(new Date(reportAt.getTime() + 17 * 86_400_000)); const after = await c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() }); expect((await c.helpLinks.readSession(after.sessionToken))?.canAppeal).toBe(false);
  const expiring = await context(true, { kind: "suspension", target: "account", endsAt: new Date(reportAt.getTime() + 1_000).toISOString() });
  expiring.setTime(new Date(reportAt.getTime() + 1_000)); await expect(expiring.helpLinks.openSession({ token: expiring.token!, networkKeyHmac: network() })).rejects.toMatchObject({ code: "not_available" });
});
test("notice dependency failure rolls back standing, penalty, links, proof and handoff", async () => {
  const c = await penaltyContext(f); const notices = { queue: vi.fn().mockRejectedValue(new Error("private dependency")) };
  const helpLinks = createHelpLinkService({ ...helpInput, db: f.db, mode: "enabled", lookupHmacKey: fixtureLookupKey, notices });
  const service = createPenaltyService({ ...c.input, notices, helpLinks }); const command = { ...await c.command(), kind: "suspension" as const, target: "account" as const };
  await expect(service.apply(command)).rejects.toMatchObject({ code: "dependency_unavailable" });
  expect(await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.subjectUserId, c.p.creator.userId))).toEqual([]);
  expect((await f.db.select().from(schema.identityUsers).where(eq(schema.identityUsers.id, c.p.creator.userId)))[0]?.accessStatus).toBe("active");
  expect((await f.db.select().from(schema.identityStepUpProofs).where(eq(schema.identityStepUpProofs.id, command.stepUpProofId)))[0]?.consumedAt).toBeNull();
});
test("resend delivery dependency failure resolves identically and rolls back link revocation", async () => {
  const c = await context(); const notices = { queue: vi.fn().mockRejectedValue(new Error(`${c.email} ${c.token} ${c.p.creator.userId}`)) };
  const logger = { error: vi.fn() };
  const helpLinks = createHelpLinkService({ ...helpInput, db: f.db, mode: "enabled", lookupHmacKey: fixtureLookupKey, notices, logger, now: () => reportAt });
  expect(await helpLinks.requestLink({ email: c.email, networkKeyHmac: network(50) })).toBeUndefined();
  expect(logger.error.mock.calls).toEqual([["Help-link resend failed"]]);
  await expect(c.helpLinks.openSession({ token: c.token!, networkKeyHmac: network() })).resolves.toMatchObject({ penaltyId: c.penaltyId });
  expect(await f.db.select().from(schema.trustHelpLinks).where(eq(schema.trustHelpLinks.penaltyId, c.penaltyId))).toHaveLength(1);
});
test("database rejects a foreign session, wrong durations and mismatched link ownership", async () => {
  const c = await context(); const [link] = await f.db.select().from(schema.trustHelpLinks).where(and(eq(schema.trustHelpLinks.penaltyId, c.penaltyId), eq(schema.trustHelpLinks.tokenHash, digest(c.token!))));
  const session = { id: randomUUID(), sessionHash: digest(Buffer.alloc(32, 80).toString("base64url")), linkId: link!.id, userId: c.p.creator.userId, penaltyId: c.penaltyId, createdAt: reportAt, expiresAt: new Date(reportAt.getTime() + 1_800_000) };
  await expect(f.db.insert(schema.trustHelpSessions).values({ ...session, userId: c.p.buyer.userId })).rejects.toThrow();
  await expect(f.db.insert(schema.trustHelpSessions).values({ ...session, expiresAt: new Date(reportAt.getTime() + 1) })).rejects.toThrow();
  await expect(f.db.insert(schema.trustHelpLinks).values({ id: randomUUID(), tokenHash: session.sessionHash, userId: c.p.buyer.userId, penaltyId: c.penaltyId, issuedAt: reportAt, appealUntil: link!.appealUntil, readUntil: link!.readUntil })).rejects.toThrow();
});
