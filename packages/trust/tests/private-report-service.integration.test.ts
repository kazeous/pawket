import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createBriefReportTargetPort } from "@pawket/orders";
import { createThreadReportTargetPort } from "@pawket/commission-files";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField } from "@pawket/security";
import { createPrivateReportService } from "../src/private-report-service.js";
import { createTrustRestrictionPort } from "../src/penalty-port.js";
import { createTrustCasePort } from "../src/case-port.js";
import { issueReportChallenge, issueReportChallengeToken } from "../src/report-service.js";
import type { TrustReportTarget, TrustReportTargetPort } from "../src/report-target-port.js";
import { createReportFixture, fixtureKeyring, fixtureLookupKey, reportAt } from "./report-fixture.js";

const fixture = createReportFixture("service");
beforeAll(fixture.initialize, 60_000); afterAll(fixture.dispose);
const brief = createBriefReportTargetPort(); const thread = createThreadReportTargetPort();
const targets: TrustReportTargetPort = { resolve: (tx, target, reporter) => target.kind === "commission_brief" ? brief.resolve(tx, target, reporter) : thread.resolve(tx, target, reporter) };
function service(extra: Partial<Parameters<typeof createPrivateReportService>[0]> = {}) {
  return createPrivateReportService({ db: fixture.db, mode: "enabled", keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey, challengeKey: fixtureLookupKey,
    targets, restrictions: createTrustRestrictionPort({ mode: "enabled" }), policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) }, now: () => reportAt, ...extra });
}
function command(actor: { userId: string; sessionId: string }, target: TrustReportTarget) {
  return { requester: { kind: "authenticated" as const, actor }, target, reason: "other" as const, detail: "Private report detail\ne\u0301", idempotencyKey: randomUUID(), requestId: randomUUID() };
}
function solve(token: string) {
  for (let solution = 0; solution < 20_000_000; solution++) { const hash = createHash("sha256").update(`${token}.${solution}`).digest(); if (hash[0] === 0 && hash[1] === 0 && hash[2]! < 64) return solution; }
  throw new Error("Synthetic proof search exhausted");
}
describe("private reports", () => {
  test("buyer reports creator message, encrypted detail, event and private outbox commit together; replay is stable", async () => {
    const p = await fixture.paidOrder(); const messageId = await fixture.message(p.orderId, p.creator.userId); const s = service();
    const c = command(p.buyer, { kind: "commission_message", orderId: p.orderId, messageId }); const result = await s.submit(c);
    expect(result).toMatchObject({ accepted: true, reportReference: expect.stringMatching(/^report:v2:[A-Za-z0-9_-]{32}$/u) });
    expect(await s.submit({ ...c, requestId: randomUUID() })).toEqual(result);
    const [row] = await fixture.db.select().from(schema.trustReports).where(eq(schema.trustReports.reportReference, result.reportReference));
    expect(JSON.stringify(row!.detailEnvelope)).not.toContain("Private report detail");
    expect(decryptSensitiveField({ keyring: fixtureKeyring, envelope: row!.detailEnvelope!, binding: { recordType: "trust_reports", recordId: row!.id, fieldName: "detail" } })).toBe("Private report detail\né");
    const [caseRow] = await fixture.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, result.caseId));
    expect(caseRow).toMatchObject({ kind: "report", orderId: p.orderId, sourceType: "commission_message", sourceId: messageId });
    const events = await fixture.db.select().from(schema.trustCaseEvents).where(and(eq(schema.trustCaseEvents.caseId, result.caseId), eq(schema.trustCaseEvents.action, "report_added")));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ actorUserId: null, actorSessionId: null, reason: null });
    const outbox = await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, row!.id));
    expect(outbox).toHaveLength(1); expect(outbox[0]!.payload).toEqual({ reportId: row!.id, caseId: result.caseId, targetKind: "commission_message" });
    expect(await s.listFiledBy(p.creator.userId)).toEqual([]);
    expect(await s.listFiledBy(p.buyer.userId)).toEqual([{ reportReference: result.reportReference, targetKind: "commission_message", state: "received", createdAt: reportAt.toISOString() }]);
    await expect(s.submit({ ...c, detail: "changed" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  test("creator reports brief once; buyer cannot report own message or brief and unrelated users cannot report private targets", async () => {
    const p = await fixture.paidOrder(); const s = service(); const target = { kind: "commission_brief" as const, orderId: p.orderId };
    await s.submit(command(p.creator, target)); await expect(s.submit(command(p.creator, target))).rejects.toMatchObject({ code: "duplicate" });
    await expect(s.submit(command(p.buyer, target))).rejects.toMatchObject({ code: "not_available" });
    const messageId = await fixture.message(p.orderId, p.buyer.userId); const message = { kind: "commission_message" as const, orderId: p.orderId, messageId };
    await expect(s.submit(command(p.buyer, message))).rejects.toMatchObject({ code: "not_available" });
    const fileId = await fixture.threadFile(p.orderId, p.buyer.userId, messageId); const other = { userId: await fixture.person(), sessionId: "synthetic" };
    for (const t of [message, { kind: "commission_file" as const, orderId: p.orderId, fileId }]) await expect(s.submit(command(other, t))).rejects.toMatchObject({ code: "not_available" });
  });
  test("two reporters on one message share one open case and two anonymous report_added events", async () => {
    const p = await fixture.paidOrder(); const messageId = await fixture.message(p.orderId, p.creator.userId); const other = { userId: await fixture.person(), sessionId: "synthetic" };
    // The real participant adapter permits one counterparty. A structural port isolates grouping with two authorized reporters.
    const s = service({ targets: { resolve: async () => ({ kind: "commission_message", targetId: messageId, orderId: p.orderId, contentOwnerUserId: p.creator.userId, packageRevisionId: null }) } });
    const target = { kind: "commission_message" as const, orderId: p.orderId, messageId };
    const [a, b] = await Promise.all([s.submit(command(p.buyer, target)), s.submit(command(other, target))]); expect(a.caseId).toBe(b.caseId);
    expect(await fixture.db.select().from(schema.trustCaseEvents).where(and(eq(schema.trustCaseEvents.caseId, a.caseId), eq(schema.trustCaseEvents.action, "report_added")))).toHaveLength(2);
  });
  test("reporting restriction refuses authenticated reports and disabled service refuses before reads", async () => {
    const p = await fixture.paidOrder(); const target = { kind: "commission_brief" as const, orderId: p.orderId };
    const cases = createTrustCasePort(); const source = await fixture.db.transaction((tx) => cases.openCase(tx, { kind: "report", orderId: p.orderId,
      sourceType: "commission_brief", sourceId: p.orderId, policyRevisionId: null, requestId: randomUUID(), at: reportAt }));
    const id = randomUUID(); await fixture.db.insert(schema.trustPenalties).values({ id, subjectUserId: p.creator.userId, kind: "restriction", restriction: "reporting", reasonCategory: "other",
      explanationEnvelope: encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "Synthetic", binding: { recordType: "trust_penalties", recordId: id, fieldName: "explanation" } }),
      sourceCaseId: source.caseId, startsAt: reportAt, endsAt: new Date(reportAt.getTime() + 60_000), ownerUserId: p.buyer.userId, ownerSessionId: "synthetic", stepUpProofId: randomUUID(), requestId: randomUUID(), createdAt: reportAt });
    await expect(service().submit(command(p.creator, target))).rejects.toMatchObject({ code: "restricted" });
    await expect(service({ mode: "disabled" }).submit(command(p.creator, target))).rejects.toMatchObject({ code: "enforcement_disabled" });
    await expect(service({ mode: "disabled" }).issueChallenge({ networkKeyHmac: `hmac-sha256:v1:${"a".repeat(43)}` })).rejects.toMatchObject({ code: "enforcement_disabled" });
  });
  test("a file report binds the attached file; empty detail is absent and invalid text rolls back", async () => {
    const p = await fixture.paidOrder(); const messageId = await fixture.message(p.orderId, p.creator.userId); const fileId = await fixture.threadFile(p.orderId, p.creator.userId, messageId);
    const s = service(); const c = command(p.buyer, { kind: "commission_file", orderId: p.orderId, fileId });
    for (const detail of ["x".repeat(1_001), "control\r", "lone\ud800"]) await expect(s.submit({ ...c, detail })).rejects.toMatchObject({ code: "invalid_request" });
    const result = await s.submit({ ...c, detail: "" });
    const [row] = await fixture.db.select().from(schema.trustReports).where(eq(schema.trustReports.reportReference, result.reportReference));
    expect(row).toMatchObject({ targetKind: "commission_file", targetId: fileId, contentOwnerUserId: p.creator.userId, detailEnvelope: null });
  });
  test("case policy snapshots remain unchanged when subsequent package reports join it", async () => {
    const p = await fixture.paidOrder(); const other = { userId: await fixture.person(), sessionId: "synthetic" };
    const revisions = [randomUUID(), randomUUID()];
    await fixture.db.insert(schema.trustPolicyRevisions).values(revisions.map((id, i) => ({ id, kind: i === 0 ? "community_rules" as const : "enforcement_appeals" as const,
      revisionNumber: 100, document: "Synthetic policy", checksum: `sha256:${"a".repeat(64)}`, approvalKind: "synthetic" as const, source: "synthetic", effectiveAt: reportAt, createdAt: reportAt })));
    let current = { communityRulesRevisionId: revisions[0]!, enforcementRevisionId: revisions[1]! } as { communityRulesRevisionId: string | null; enforcementRevisionId: string | null };
    const s = service({ targets: { resolve: async () => ({ kind: "commission_package", targetId: p.packageId, orderId: null, contentOwnerUserId: p.creator.userId, packageRevisionId: p.packageRevisionId }) },
      policies: { readCurrentIds: async () => current } });
    const target = { kind: "commission_package" as const, packageId: p.packageId, revisionId: p.packageRevisionId };
    const a = await s.submit(command(p.buyer, target)); current = { communityRulesRevisionId: null, enforcementRevisionId: null };
    const b = await s.submit(command(other, target)); expect(b.caseId).toBe(a.caseId);
    const [row] = await fixture.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, a.caseId));
    expect(row).toMatchObject({ communityPolicyRevisionId: revisions[0], enforcementPolicyRevisionId: revisions[1], orderId: null });
  });
  test.each(["invalid token", "invalid signature", "invalid proof"] as const)(
    "guest submit with %s is refused before opening a transaction or resolving targets",
    async (failure) => {
      const resolve = vi.fn<TrustReportTargetPort["resolve"]>(async () => null);
      const s = service({ targets: { resolve } });
      const challenge = issueReportChallengeToken(reportAt, randomUUID().replaceAll("-", ""),
        failure === "invalid signature" ? new Uint8Array(32).fill(75) : fixtureLookupKey, "trust-private-report-challenge");
      const token = failure === "invalid token" ? "invalid" : challenge.token;
      let solution = 0;
      while (true) {
        const hash = createHash("sha256").update(`${token}.${solution}`).digest();
        if (hash[0] !== 0 || hash[1] !== 0 || hash[2]! >= 64) break;
        solution++;
      }
      if (failure === "invalid signature") solution = solve(token);
      const transaction = vi.spyOn(fixture.db, "transaction");
      try {
        await expect(s.submit({
          requester: { kind: "guest", networkKeyHmac: `hmac-sha256:v1:${"a".repeat(43)}`, challenge: { token, solution } },
          target: { kind: "commission_package", packageId: randomUUID(), revisionId: randomUUID() },
          reason: "other", detail: null, idempotencyKey: "guest", requestId: randomUUID(),
        })).rejects.toMatchObject({ code: "invalid_request" });
        expect(resolve).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }
    },
    60_000,
  );
  test("guest package challenge binds network, revision and context, is single use, and enforces 24h duplicate", async () => {
    const p = await fixture.paidOrder(); const networkKeyHmac = `hmac-sha256:v1:${"a".repeat(43)}`;
    const packageTarget: TrustReportTargetPort = { resolve: async (_tx, t) => t.kind === "commission_package" && t.revisionId === p.packageRevisionId
      ? { kind: t.kind, targetId: p.packageId, orderId: null, contentOwnerUserId: p.creator.userId, packageRevisionId: p.packageRevisionId } : null };
    const s = service({ targets: packageTarget }); const target = { kind: "commission_package" as const, packageId: p.packageId, revisionId: p.packageRevisionId };
    const submit = (token: string, solution: number, t: TrustReportTarget = target, network = networkKeyHmac) => s.submit({ target: t, reason: "other", detail: null, idempotencyKey: "guest", requestId: randomUUID(), requester: { kind: "guest", networkKeyHmac: network, challenge: { token, solution } } });
    await expect(submit("invalid", 0)).rejects.toMatchObject({ code: "invalid_request" });
    const challenge = await s.issueChallenge({ networkKeyHmac }); const solution = solve(challenge.token);
    await expect(submit(challenge.token, solution, target, `hmac-sha256:v1:${"b".repeat(43)}`)).rejects.toMatchObject({ code: "invalid_request" });
    const accepted = await submit(challenge.token, solution);
    await expect(submit(challenge.token, solution)).rejects.toMatchObject({ code: "invalid_request" });
    const second = await s.issueChallenge({ networkKeyHmac }); await expect(submit(second.token, solve(second.token))).rejects.toMatchObject({ code: "duplicate" });
    const [row] = await fixture.db.select().from(schema.trustReports).where(eq(schema.trustReports.reportReference, accepted.reportReference));
    expect(row).toMatchObject({ reporterUserId: null, reporterNetworkHmac: networkKeyHmac, packageRevisionId: p.packageRevisionId, orderId: null });
    const stale = await s.issueChallenge({ networkKeyHmac }); const staleSolution = solve(stale.token);
    await expect(submit(stale.token, staleSolution, { ...target, revisionId: randomUUID() })).rejects.toMatchObject({ code: "not_available" });
    await expect(submit(stale.token, staleSolution, { kind: "commission_brief", orderId: p.orderId })).rejects.toMatchObject({ code: "not_available" });
  }, 60_000);
  test("authenticated 15-minute limit is ten and exact idempotent replay does not consume quota", async () => {
    const p = await fixture.paidOrder(); const s = service(); let first: ReturnType<typeof command> | undefined;
    for (let i = 0; i < 11; i++) { const messageId = await fixture.message(p.orderId, p.creator.userId); const c = command(p.buyer, { kind: "commission_message", orderId: p.orderId, messageId });
      if (i < 10) { await s.submit(c); first ??= c; } else await expect(s.submit(c)).rejects.toMatchObject({ code: "rate_limited" }); }
    await expect(s.submit(first!)).resolves.toMatchObject({ accepted: true });
  });
  test("guest limit is five per 15 minutes and I3 challenges cannot be used on private reports", async () => {
    const networkKeyHmac = createLookupHmac({ key: fixtureLookupKey, context: "synthetic-report-test", value: randomUUID() });
    const packages = await Promise.all(Array.from({ length: 6 }, () => fixture.paidOrder()));
    const s = service({ targets: { resolve: async (_tx, target) => {
      const p = target.kind === "commission_package" ? packages.find((p) => p.packageId === target.packageId && p.packageRevisionId === target.revisionId) : null;
      return p ? { kind: "commission_package", targetId: p.packageId, orderId: null, contentOwnerUserId: p.creator.userId, packageRevisionId: p.packageRevisionId } : null;
    } } });
    async function submit(index: number, challenge: { token: string }) {
      const p = packages[index]!;
      return s.submit({ requester: { kind: "guest", networkKeyHmac, challenge: { token: challenge.token, solution: solve(challenge.token) } },
        target: { kind: "commission_package", packageId: p.packageId, revisionId: p.packageRevisionId }, reason: "other", detail: null, idempotencyKey: "guest", requestId: randomUUID() });
    }
    const publicChallenge = await issueReportChallenge({ db: fixture.db, key: fixtureLookupKey, networkKeyHmac, now: reportAt, nonce: randomUUID().replaceAll("-", "") });
    await expect(submit(0, publicChallenge)).rejects.toMatchObject({ code: "invalid_request" });
    for (let i = 0; i < 6; i++) {
      const challenge = await s.issueChallenge({ networkKeyHmac });
      if (i < 5) expect(await submit(i, challenge)).toMatchObject({ accepted: true }); else await expect(submit(i, challenge)).rejects.toMatchObject({ code: "rate_limited" });
    }
  }, 60_000);
  test("database guard permits closing once and forbids all other updates or deletion", async () => {
    const p = await fixture.paidOrder(); const result = await service().submit(command(p.creator, { kind: "commission_brief", orderId: p.orderId }));
    const where = eq(schema.trustReports.reportReference, result.reportReference);
    await expect(fixture.db.update(schema.trustReports).set({ reason: "privacy" }).where(where)).rejects.toThrow();
    await fixture.db.update(schema.trustReports).set({ state: "closed", closedAt: reportAt }).where(where);
    expect((await service().listFiledBy(p.creator.userId))[0]!.state).toBe("closed");
    await expect(fixture.db.update(schema.trustReports).set({ closedAt: new Date(reportAt.getTime() + 1) }).where(where)).rejects.toThrow();
    await expect(fixture.db.delete(schema.trustReports).where(where)).rejects.toThrow();
    await expect(fixture.db.execute(sql`update trust_reports set state = 'open', closed_at = null where report_reference = ${result.reportReference}`)).rejects.toThrow();
  });
});
