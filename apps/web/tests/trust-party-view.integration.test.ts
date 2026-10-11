import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { trustCases } from "@pawket/database";
import { createThreadReportTargetPort } from "@pawket/commission-files";
import { createPrivateReportService, createContentHideService, createAppealService } from "@pawket/trust";
import { createReportFixture, fixtureKeyring, fixtureLookupKey, reportAt } from "../../../packages/trust/tests/report-fixture.js";
import { penaltyContext } from "../../../packages/trust/tests/penalty-service-fixture.js";
import { createTrustPartyView } from "../src/platform/trust-party-view.js";
import { myTrustCasesSchema } from "../src/ui/trust/trust-client.js";

const f = createReportFixture("party_views");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
test("real party queries isolate filed reports, penalties, hides and appeals and omit every report source", async () => {
  const c = await penaltyContext(f); const messageId = await f.message(c.p.orderId, c.p.creator.userId);
  const reports = createPrivateReportService({ db: f.db, mode: "enabled", keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey, challengeKey: fixtureLookupKey,
    policies: c.input.policies, targets: createThreadReportTargetPort(), now: () => reportAt });
  const report = await reports.submit({ requester: { kind: "authenticated", actor: c.p.buyer }, target: { kind: "commission_message", orderId: c.p.orderId, messageId },
    reason: "privacy", detail: "Private reporter detail", idempotencyKey: randomUUID(), requestId: randomUUID() });
  const source = { caseId: report.caseId };
  const warning = await c.service.apply({ ...await c.command(), source });
  const restriction = await c.service.apply({ ...await c.command(), source, kind: "restriction", restriction: "reporting" });
  const hides = createContentHideService(c.input);
  const [caseRow] = await f.db.select().from(trustCases).where(eq(trustCases.id, report.caseId));
  const hide = await hides.hide({ ...await c.base("owner.trust_hide"), caseId: report.caseId, expectedCaseVersion: caseRow!.version, reason: "Private owner hide reason" });
  const appeals = createAppealService({ ...c.input, penalties: c.service, hides, helpLinks: c.input.helpLinks });
  const appeal = await appeals.submit({ appellant: { kind: "session", actor: c.p.creator }, target: hide, statement: "Private appeal statement", idempotencyKey: randomUUID(), requestId: randomUUID() });
  const view = createTrustPartyView({ db: f.db, penalties: c.service, appeals, reports });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(reportAt.getTime() + 1));
  try {
    const creator = myTrustCasesSchema.parse(await view.listForUser(c.p.creator.userId));
    const buyer = myTrustCasesSchema.parse(await view.listForUser(c.p.buyer.userId));
    expect(creator.reportsFiled).toEqual([]); expect(creator.penalties).toHaveLength(2); expect(creator.hides).toHaveLength(1); expect(creator.appeals).toHaveLength(1);
    expect(creator.penalties.find((row) => row.penaltyId === restriction.penaltyId)).toMatchObject({ canAppeal: true, reasonCategoryLabel: "Lý do khác" });
    expect(creator.penalties.find((row) => row.penaltyId === warning.penaltyId)).toMatchObject({ canAppeal: false, acknowledgedAt: null });
    expect(creator.hides[0]).toMatchObject({ hideId: hide.hideId, canAppeal: false, appealState: "open", explanation: "Nội dung này đã bị Pawket ẩn vì vi phạm quy định cộng đồng." });
    expect(creator.appeals[0]).toMatchObject({ appealId: appeal.appealId, state: "open", reasoning: null });
    const forbidden = [c.p.buyer.userId, c.p.buyer.sessionId, c.owner.userId, report.reportReference, report.caseId, appeal.caseId, "Private internal note", "Private reporter detail", "Private owner hide reason", "Private appeal statement", "sourceCaseId", "sourcePublicReportId", "reporterUserId", "reporterRole"];
    for (const value of forbidden) expect(JSON.stringify(creator)).not.toContain(value);
    expect(buyer).toEqual({ penalties: [], hides: [], appeals: [], reportsFiled: [{ reportReference: report.reportReference, targetKind: "commission_message", state: "received" }] });
    expect(await view.listForUser(await f.person())).toEqual({ penalties: [], hides: [], appeals: [], reportsFiled: [] });
    await c.service.acknowledgeWarning({ actor: c.p.creator, penaltyId: warning.penaltyId, idempotencyKey: randomUUID(), requestId: randomUUID() });
    expect((await view.listForUser(c.p.creator.userId)).penalties.find((row) => row.penaltyId === warning.penaltyId)?.acknowledgedAt).toBe(reportAt.toISOString());
  } finally { vi.useRealTimers(); }
}, 30_000);
