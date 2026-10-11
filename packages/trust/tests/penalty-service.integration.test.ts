import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { decryptSensitiveField } from "@pawket/security";
import { createPenaltyService } from "../src/penalty-service.js";
import { createTrustCasePort } from "../src/case-port.js";
import { createReportFixture } from "./report-fixture.js";
import { penaltyContext, fixtureKeyring, reportAt } from "./penalty-service-fixture.js";
const f = createReportFixture("penalties"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);

test("explanation and internal note are encrypted and absent from audit/outbox; replay needs no second proof", async () => {
  const c = await penaltyContext(f); const command = await c.command(); const result = await c.service.apply(command);
  expect(await c.service.apply({ ...command, stepUpProofId: randomUUID(), requestId: randomUUID() })).toEqual(result); expect(c.consume).toHaveBeenCalledOnce();
  const [row] = await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, result.penaltyId));
  for (const field of ["explanation", "internal_note"] as const) expect(decryptSensitiveField({ keyring: fixtureKeyring, envelope: field === "explanation" ? row!.explanationEnvelope : row!.internalNoteEnvelope!, binding: { recordType: "trust_penalties", recordId: result.penaltyId, fieldName: field } })).toBe(field === "explanation" ? command.explanation.normalize("NFC") : command.internalNote);
  const audit = await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, result.penaltyId));
  const outbox = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, result.penaltyId));
  expect(audit).toHaveLength(1); expect(outbox).toMatchObject([{ eventType: "trust.penalty_applied.v1", payload: { penaltyId: result.penaltyId, subjectUserId: c.p.creator.userId, kind: "warning" } }]);
  expect(JSON.stringify([audit, outbox])).not.toMatch(/Private explanation|Private internal note/u);
  expect(await f.db.select().from(schema.trustCaseEvents).where(eq(schema.trustCaseEvents.caseId, c.caseId)).orderBy(asc(schema.trustCaseEvents.resultingVersion))).toMatchObject([{ action: "opened" }, { action: "penalty_applied" }]);
  await expect(c.service.apply({ ...command, explanation: "changed" })).rejects.toMatchObject({ code: "idempotency_conflict" });
});
test("owner subject and non-party are refused atomically", async () => {
  const c = await penaltyContext(f);
  await expect(c.service.apply({ ...await c.command(), subjectUserId: c.owner.userId })).rejects.toMatchObject({ code: "not_authorized" });
  await expect(c.service.apply({ ...await c.command(), subjectUserId: await f.person() })).rejects.toMatchObject({ code: "not_available" });
  expect(await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.sourceCaseId, c.caseId))).toEqual([]);
});

test("public reports authorize their reported creator, while orderless package cases authorize the package owner", async () => {
  const c = await penaltyContext(f); const publicationId = randomUUID(); const publicReportId = randomUUID();
  await f.db.insert(schema.creatorPublicationRevisions).values({ id: publicationId, pageId: c.p.pageId, revisionNumber: 1, canonicalHandle: `artist-${publicationId.slice(0, 8)}`, displayName: "Artist", shortIntroduction: "Introduction", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: c.p.creator.userId, actorSessionId: c.p.creator.sessionId, expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: reportAt });
  await f.db.insert(schema.publicContentReports).values({ id: publicReportId, reportReference: `report:v1:${randomUUID().replaceAll("-", "")}`, targetType: "page", targetId: c.p.pageId, publicationRevisionId: publicationId, reason: "other", reporterUserId: c.p.buyer.userId, createdAt: reportAt, updatedAt: reportAt });
  const publicCommand = { ...await c.command(), source: { publicReportId } };
  await expect(c.service.apply({ ...publicCommand, subjectUserId: c.p.buyer.userId })).rejects.toMatchObject({ code: "not_available" });
  const publicPenalty = await c.service.apply(publicCommand);
  expect((await c.service.listActive({ subjectUserId: c.p.creator.userId }))[0]).toMatchObject({ penaltyId: publicPenalty.penaltyId, sourcePublicReportId: publicReportId });
  const { caseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind: "report", orderId: null, policyRevisionId: null, sourceType: "commission_package", sourceId: c.p.packageId, requestId: randomUUID(), at: reportAt }));
  const packageCommand = { ...await c.command(), source: { caseId } };
  await expect(c.service.apply({ ...packageCommand, subjectUserId: c.p.buyer.userId })).rejects.toMatchObject({ code: "not_available" });
  await c.service.apply(packageCommand);
  expect(JSON.stringify(await c.service.listForSubject(c.p.creator.userId))).not.toContain(c.p.buyer.userId);
});
test("resolved cases remain valid sources; wrong proofs, disabled mode and invalid shapes refuse", async () => {
  const c = await penaltyContext(f); await f.db.transaction((tx) => createTrustCasePort().resolveCase(tx, { caseId: c.caseId, actor: c.owner, reason: null, resolutionKind: "withdrawn", requestId: randomUUID(), at: reportAt }));
  await c.service.apply(await c.command());
  await expect(c.service.apply({ ...await c.command(), ...await c.base("owner.trust_penalty_lift") })).rejects.toMatchObject({ code: "owner_step_up_required" });
  await expect(createPenaltyService({ ...c.input, mode: "disabled" }).apply(await c.command())).rejects.toMatchObject({ code: "enforcement_disabled" });
  for (const changes of [{ endsAt: reportAt.toISOString() }, { kind: "restriction" as const }, { kind: "removal" as const, target: "account" as const, endsAt: new Date(reportAt.getTime() + 1).toISOString() }, { explanation: "\r" }, { internalNote: "x".repeat(2001) }, { kind: "suspension" as const, target: "account" as const, endsAt: new Date(reportAt.getTime() + 3651 * 86_400_000).toISOString() }]) await expect(c.service.apply({ ...await c.command(), ...changes })).rejects.toMatchObject({ code: "invalid_request" });
});
test("duplicate active target refuses; warnings acknowledge once, privately and with replay", async () => {
  const c = await penaltyContext(f); await c.service.apply({ ...await c.command(), kind: "suspension", target: "account" });
  await expect(c.service.apply({ ...await c.command(), kind: "suspension", target: "account" })).rejects.toMatchObject({ code: "duplicate" });
  const { penaltyId } = await c.service.apply(await c.command()); const command = { actor: c.p.creator, penaltyId, idempotencyKey: randomUUID(), requestId: randomUUID() };
  await expect(c.service.acknowledgeWarning({ ...command, actor: c.p.buyer })).rejects.toMatchObject({ code: "not_available" });
  await c.service.acknowledgeWarning(command); await c.service.acknowledgeWarning(command);
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, penaltyId)))[0]).toMatchObject({ acknowledgedAt: reportAt, version: 2 });
  expect(await f.db.select().from(schema.trustPenaltyEvents).where(eq(schema.trustPenaltyEvents.penaltyId, penaltyId))).toHaveLength(2);
  expect(JSON.stringify(await c.service.listForSubject(c.p.creator.userId))).not.toContain("Private internal note");
});
