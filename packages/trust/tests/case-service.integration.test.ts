import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import * as trust from "../src/index.js";
import type { TrustCaseEvidencePort } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for trust case service tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Trust case service tests require a dedicated local test database");
}
const schemaName = `trust_case_service_${process.pid}_${Date.now()}`; const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
const fixture = { db: drizzle(client, { schema }) };
const at = new Date("2026-10-07T04:00:00Z");
const keyring = createEncryptionKeyring({ activeKeyId: "synthetic-case-tests", keys: { "synthetic-case-tests": new Uint8Array(32).fill(45) } });
const envelope = <F extends "text" | "links">(orderId: string, fieldName: F) => encryptSensitiveField({ keyring, binding: { recordType: "commission_briefs", recordId: orderId, fieldName }, plaintext: fieldName === "links" ? "[]" : "Synthetic brief" });
const owner = { userId: `case-owner-${randomUUID()}`, sessionId: "synthetic-owner-session" };
beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await migrate(fixture.db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
  await fixture.db.insert(schema.identityUsers).values({ id: owner.userId, name: "Synthetic owner", email: `${owner.userId}@example.invalid`, canonicalEmail: `${owner.userId}@example.invalid`, createdAt: at, updatedAt: at });
}, 30_000);
afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
}, 30_000);

async function order() {
  const creatorUserId = `case-creator-${randomUUID()}`; const buyerUserId = `case-buyer-${randomUUID()}`;
  const pageId = randomUUID(); const packageId = randomUUID(); const revisionId = randomUUID(); const orderId = randomUUID();
  const policyId = schema.COMMISSION_POLICY_BOOTSTRAP_ID;
  await fixture.db.insert(schema.identityUsers).values([creatorUserId, buyerUserId].map((id) => ({ id, name: "Synthetic party", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: at, updatedAt: at })));
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "custom_quote" as const, briefInstructions: "Describe the portrait", terms: null, showcaseId: null };
  await fixture.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: revisionId, packageId, creatorUserId, revisionNumber: 1, ...draft,
    policyRevisionId: policyId, actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: revisionId, updatedAt: at }).where(eq(schema.commissionPackages.id, packageId));
  await fixture.db.transaction(async (tx) => {
    await tx.insert(schema.commissionOrders).values({ id: orderId, creatorUserId, buyerUserId, packageId, packageRevisionId: revisionId,
      route: "custom_quote", expiresAt: new Date(at.getTime() + 7 * 86_400_000), createdAt: at, updatedAt: at });
    await tx.insert(schema.commissionBriefs).values({ orderId, textEnvelope: envelope(orderId, "text"), linksEnvelope: envelope(orderId, "links"), buyerSessionId: "synthetic-buyer", requestId: randomUUID(), createdAt: at });
    await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "requested", requestId: randomUUID(), occurredAt: at });
  });
  return { orderId, policyId };
}

function evidence() {
  return {
    orderSummary: vi.fn<TrustCaseEvidencePort["orderSummary"]>(async () => ({ available: true })),
    threadPage: vi.fn<TrustCaseEvidencePort["threadPage"]>(async () => ({ available: true })),
    resolutionRecords: vi.fn<TrustCaseEvidencePort["resolutionRecords"]>(async () => ({ available: true })),
    refundDestination: vi.fn<TrustCaseEvidencePort["refundDestination"]>(async () => ({ available: true })),
    fileGrant: vi.fn<TrustCaseEvidencePort["fileGrant"]>(async () => ({ url: "synthetic-grant" })),
  };
}
function service(options: { accepted?: boolean; throws?: boolean; evidence?: Pick<TrustCaseEvidencePort, "reportContext" | "packageRevision" | "brief" | "appealSource" | "fileInScope"> } = {}) {
  const port = { ...evidence(), ...options.evidence };
  const consumeStepUpProof = vi.fn(async () => { if (options.throws) throw new Error("Synthetic proof failure"); return options.accepted ?? true; });
  const instance = trust.createTrustCaseService({ db: fixture.db, applicationRevision: "synthetic-i8", consumeStepUpProof, evidence: port, now: () => at });
  return { instance, port, consumeStepUpProof };
}
async function open(kind: "dispute" | "refund_not_received" | "refund_overdue" | "late_payment" = "dispute") {
  const p = await order(); const port = trust.createTrustCasePort();
  const command = { kind, orderId: p.orderId, sourceType: kind === "dispute" ? "commission_dispute" as const : kind === "late_payment" ? "commission_late_payment_claim" as const : "commission_refund_obligation" as const,
    sourceId: randomUUID(), policyRevisionId: p.policyId, requestId: randomUUID(), at };
  const result = await fixture.db.transaction((tx) => port.openCase(tx, command));
  return { ...result, p, port, command };
}
const read = (caseId: string, section: Parameters<trust.TrustCaseService["readEvidence"]>[0]["section"] = "order_summary") =>
  ({ owner, stepUpProofId: randomUUID(), caseId, section, requestId: randomUUID() });
const accesses = (caseId: string) => fixture.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId));
const resolve = (c: Awaited<ReturnType<typeof open>>) => fixture.db.transaction((tx) => c.port.resolveCase(tx, {
  caseId: c.caseId, resolutionKind: "ruled", actor: owner, reason: "owner_ruling", requestId: randomUUID(), at,
}));

describe("case-scoped owner evidence", () => {
  async function openNew(kind: "report" | "appeal", sourceType: trust.TrustCaseSourceType, orderId: string | null = null) {
    const port = trust.createTrustCasePort();
    const command = { kind, sourceType, orderId, sourceId: randomUUID(), policyRevisionId: null, requestId: randomUUID(), at };
    return { ...await fixture.db.transaction((tx) => port.openCase(tx, command)), command, port };
  }
  test.each(["report", "appeal"] as const)("%s refuses order-wide evidence and files outside scope before proof or log", async (kind) => {
    const p = await order(); const c = await openNew(kind, kind === "report" ? "commission_file" : "trust_appeal", p.orderId);
    const fileInScope = vi.fn(async (_tx: schema.PawketTransaction, _caseId: string, fileId: string) => fileId === c.command.sourceId);
    const s = service({ evidence: { fileInScope } });
    for (const section of ["order_summary", "thread_page", "resolution_records"] as const) await expect(s.instance.readEvidence(read(c.caseId, section))).rejects.toMatchObject({ code: "not_available" });
    const grant = (fileId: string) => s.instance.fileGrant({ owner, stepUpProofId: randomUUID(), requestId: randomUUID(), caseId: c.caseId, fileId, disposition: "attachment" });
    await expect(grant(randomUUID())).rejects.toMatchObject({ code: "not_available" });
    expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(await accesses(c.caseId)).toEqual([]); expect(s.port.fileGrant).not.toHaveBeenCalled();
    expect(await grant(c.command.sourceId)).toEqual({ url: "synthetic-grant" }); expect(s.consumeStepUpProof).toHaveBeenCalledOnce();
    expect(await accesses(c.caseId)).toMatchObject([{ itemType: "file", itemId: c.command.sourceId }]);
  });
  test("listQueue filters kind report and appeal", async () => {
    const report = await openNew("report", "commission_package"); const appeal = await openNew("appeal", "trust_appeal");
    const s = service();
    const reports = await s.instance.listQueue({ kind: "report" }); const appeals = await s.instance.listQueue({ kind: "appeal" });
    expect(reports.some((row) => row.caseId === report.caseId)).toBe(true); expect(reports.every((row) => row.kind === "report")).toBe(true);
    expect(appeals.some((row) => row.caseId === appeal.caseId)).toBe(true); expect(appeals.every((row) => row.kind === "appeal")).toBe(true);
  });
  test("getCase returns orderId null for package report cases", async () => {
    const c = await openNew("report", "commission_package");
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ kind: "report", orderId: null, communityPolicyRevisionId: null, enforcementPolicyRevisionId: null });
    expect(await fixture.db.transaction((tx) => c.port.openCase(tx, c.command))).toEqual({ caseId: c.caseId, created: false });
  });
  test("openCase persists optional policy snapshots and rejects changed snapshots on replay", async () => {
    const communityPolicyRevisionId = randomUUID(); const enforcementPolicyRevisionId = randomUUID();
    await fixture.db.insert(schema.trustPolicyRevisions).values([
      { id: communityPolicyRevisionId, kind: "community_rules" as const }, { id: enforcementPolicyRevisionId, kind: "enforcement_appeals" as const },
    ].map((revision) => ({ ...revision, revisionNumber: 100, document: "Synthetic policy", approvalKind: "synthetic" as const,
      checksum: `sha256:${"a".repeat(64)}`, source: "synthetic-test", effectiveAt: at, createdAt: at })));
    const port = trust.createTrustCasePort();
    const command = { kind: "report" as const, sourceType: "commission_package" as const, orderId: null, sourceId: randomUUID(), policyRevisionId: null,
      communityPolicyRevisionId, enforcementPolicyRevisionId, requestId: randomUUID(), at };
    const c = await fixture.db.transaction((tx) => port.openCase(tx, command));
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ communityPolicyRevisionId, enforcementPolicyRevisionId });
    expect(await fixture.db.transaction((tx) => port.readCase(tx, c.caseId))).toMatchObject({ communityPolicyRevisionId, enforcementPolicyRevisionId });
    expect(await fixture.db.transaction((tx) => port.openCase(tx, command))).toEqual({ caseId: c.caseId, created: false });
    for (const column of ["communityPolicyRevisionId", "enforcementPolicyRevisionId"] as const) {
      await expect(fixture.db.transaction((tx) => port.openCase(tx, { ...command, [column]: null }))).rejects.toMatchObject({ code: "invalid_request" });
    }
  });
  test("appeal case can retain its original order", async () => {
    const orderId = (await order()).orderId; const c = await openNew("appeal", "trust_appeal", orderId);
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ kind: "appeal", orderId });
  });
  test("readEvidence refuses report_context on a dispute case with not_available", async () => {
    const c = await open(); const reportContext = vi.fn(async () => ({})); const s = service({ evidence: { reportContext } });
    await expect(s.instance.readEvidence(read(c.caseId, "report_context"))).rejects.toMatchObject({ code: "not_available" });
    expect(reportContext).not.toHaveBeenCalled(); expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(await accesses(c.caseId)).toHaveLength(0);
  });
  test.each([
    { kind: "report", source: "commission_package", section: "report_context", member: "reportContext", item: "case" },
    { kind: "report", source: "commission_package", section: "package_revision", member: "packageRevision", item: "case" },
    { kind: "report", source: "commission_brief", section: "brief", member: "brief", item: "order" },
    { kind: "appeal", source: "trust_appeal", section: "appeal_source", member: "appealSource", item: "case" },
  ] as const)("readEvidence of section $section writes its access-log item", async ({ kind, source, section, member, item }) => {
    const orderId = item === "order" ? (await order()).orderId : null;
    const c = await openNew(kind, source, orderId); const reader = vi.fn(async () => ({ synthetic: section }));
    const s = service({ evidence: { [member]: reader } }); const command = read(c.caseId, section);
    expect(await s.instance.readEvidence(command)).toEqual({ synthetic: section });
    expect(reader).toHaveBeenCalledWith(expect.anything(), item === "order" ? orderId : c.caseId);
    expect(await accesses(c.caseId)).toEqual([expect.objectContaining({ itemType: section, itemId: item === "order" ? orderId : c.caseId, requestId: command.requestId })]);
    expect(await fixture.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, c.caseId)))
      .toEqual([expect.objectContaining({ action: "owner.case_evidence", afterState: { caseId: c.caseId, itemType: section, itemId: item === "order" ? orderId : c.caseId } })]);
  });
  test.each(["report_added", "content_hidden", "content_restored", "penalty_applied"] as const)("recordCaseEvent accepts %s", async (action) => {
    const c = await openNew("report", "commission_package");
    await fixture.db.transaction((tx) => c.port.recordCaseEvent(tx, { caseId: c.caseId, action, actor: owner, reason: null, requestId: randomUUID(), at }));
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ state: "open", version: 2, events: [{ action: "opened" }, { action }] });
  });
  test.each([
    ["report", "commission_package", "dismissed"], ["report", "commission_package", "actioned"],
    ["appeal", "trust_appeal", "upheld"], ["appeal", "trust_appeal", "reduced"], ["appeal", "trust_appeal", "reversed"],
  ] as const)("%s resolves as %s / %s", async (kind, source, resolutionKind) => {
    const c = await openNew(kind, source);
    await expect(fixture.db.transaction((tx) => c.port.resolveCase(tx, { caseId: c.caseId, resolutionKind: "ruled", actor: owner, reason: null, requestId: randomUUID(), at })))
      .rejects.toMatchObject({ code: "invalid_request" });
    await fixture.db.transaction((tx) => c.port.resolveCase(tx, { caseId: c.caseId, resolutionKind, actor: owner, reason: null, requestId: randomUUID(), at }));
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ state: "resolved", resolutionKind, version: 2 });
  });
  test("queue deadline enrichment writes no access or audit entries and never reads evidence", async () => {
    const c = await open(); const s = service();
    const deadlines = { nextDeadlines: vi.fn(async () => new Map([[c.caseId, new Date("2026-10-13T04:00:00Z")]])) };
    const instance = trust.createTrustCaseService({ db: fixture.db, applicationRevision: "synthetic-test", evidence: s.port,
      consumeStepUpProof: s.consumeStepUpProof, deadlines });
    expect((await instance.listQueue()).find((row) => row.caseId === c.caseId)?.nextDeadline).toBe("2026-10-13T04:00:00.000Z");
    expect(await accesses(c.caseId)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, c.caseId))).toHaveLength(0);
    expect(s.consumeStepUpProof).not.toHaveBeenCalled(); for (const read of Object.values(s.port)) expect(read).not.toHaveBeenCalled();
  });
  test("readCase returns unlocked metadata in open and resolved states, or null", async () => {
    const c = await open();
    const expected = { caseId: c.caseId, kind: "dispute", orderId: c.p.orderId, sourceType: "commission_dispute",
      sourceId: c.command.sourceId, state: "open", resolutionKind: null, version: 1, policyRevisionId: c.p.policyId,
      communityPolicyRevisionId: null, enforcementPolicyRevisionId: null };
    expect(await fixture.db.transaction((tx) => c.port.readCase(tx, c.caseId))).toEqual(expected);
    // Holding the case row must not block this metadata-only read.
    await fixture.db.transaction(async (tx) => {
      await tx.select().from(schema.trustCases).where(eq(schema.trustCases.id, c.caseId)).for("update");
      expect(await fixture.db.transaction(async (reader) => {
        await reader.execute(sql`set local lock_timeout = '200ms'`);
        return c.port.readCase(reader, c.caseId);
      })).toEqual(expected);
    });
    await resolve(c);
    expect(await fixture.db.transaction((tx) => c.port.readCase(tx, c.caseId)))
      .toEqual({ ...expected, state: "resolved", resolutionKind: "ruled", version: 2 });
    expect(await fixture.db.transaction((tx) => c.port.readCase(tx, randomUUID()))).toBeNull();
  });
  test("openCase is idempotent and writes trust.case_opened.v1 with ids only", async () => {
    const c = await open();
    const replay = await fixture.db.transaction((tx) => c.port.openCase(tx, c.command));
    expect(replay).toEqual({ caseId: c.caseId, created: false });
    const events = await fixture.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.eventType, "trust.case_opened.v1"), eq(schema.systemOutbox.aggregateId, c.caseId)));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ caseId: c.caseId, orderId: c.p.orderId, sourceId: c.command.sourceId, policyRevisionId: c.command.policyRevisionId, correlationId: c.command.requestId });
    expect(await fixture.db.select().from(schema.trustCaseEvents).where(eq(schema.trustCaseEvents.caseId, c.caseId))).toHaveLength(1);
  });
  test("concurrent opens create one case, one event and one outbox record", async () => {
    const p = await order(); const port = trust.createTrustCasePort();
    const command = { kind: "dispute" as const, orderId: p.orderId, sourceType: "commission_dispute" as const, sourceId: randomUUID(), policyRevisionId: null, requestId: randomUUID(), at };
    const results = await Promise.all([0, 1].map(() => fixture.db.transaction((tx) => port.openCase(tx, command))));
    expect(results[0]!.caseId).toBe(results[1]!.caseId); expect(results.filter((row) => row.created)).toHaveLength(1);
    const caseId = results[0]!.caseId;
    expect(await fixture.db.select().from(schema.trustCaseEvents).where(eq(schema.trustCaseEvents.caseId, caseId))).toHaveLength(1);
    expect(await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, caseId))).toHaveLength(1);
  });
  test("a resolved source can open a fresh case without losing the earlier timeline", async () => {
    const c = await open(); await resolve(c);
    const fresh = await fixture.db.transaction((tx) => c.port.openCase(tx, c.command));
    expect(fresh.created).toBe(true); expect(fresh.caseId).not.toBe(c.caseId);
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ state: "resolved", version: 2, events: [{ action: "opened" }, { action: "resolved" }] });
  });
  test("readEvidence refuses a resolved case and writes nothing to the access log", async () => {
    const c = await open(); await resolve(c); const s = service();
    await expect(s.instance.readEvidence(read(c.caseId))).rejects.toMatchObject({ code: "not_available" });
    expect(await accesses(c.caseId)).toHaveLength(0); expect(s.port.orderSummary).not.toHaveBeenCalled();
  });
  test.each([{ accepted: false }, { throws: true }])("readEvidence with an unconsumable proof fails owner_step_up_required (%j)", async (options) => {
    const c = await open(); const s = service(options);
    await expect(s.instance.readEvidence(read(c.caseId))).rejects.toMatchObject({ code: "owner_step_up_required" });
    expect(await accesses(c.caseId)).toHaveLength(0); expect(s.port.orderSummary).not.toHaveBeenCalled();
  });
  test("readEvidence logs one access row per call with item type and request id", async () => {
    const c = await open(); const s = service();
    const command = read(c.caseId); await s.instance.readEvidence(command); await s.instance.readEvidence(command);
    await s.instance.readEvidence({ ...read(c.caseId, "thread_page"), cursor: 12 });
    await s.instance.readEvidence(read(c.caseId, "resolution_records"));
    const logs = await accesses(c.caseId); expect(logs).toHaveLength(4);
    expect(logs.filter((row) => row.requestId === command.requestId)).toHaveLength(2);
    expect(logs.find((row) => row.requestId === command.requestId)).toMatchObject({ itemType: "order_summary", itemId: c.p.orderId, ownerUserId: owner.userId, ownerSessionId: owner.sessionId, accessedAt: at });
    expect(s.consumeStepUpProof).toHaveBeenCalledWith(expect.anything(), { proofId: command.stepUpProofId, ...owner, actionClass: "owner.case_evidence", now: at });
    expect(s.port.threadPage).toHaveBeenCalledWith(expect.anything(), c.p.orderId, 12);
    expect(await fixture.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, c.caseId))).toHaveLength(4);
  });
  test("refund_destination is refused for a dispute case", async () => {
    const c = await open(); const s = service();
    await expect(s.instance.readEvidence(read(c.caseId, "refund_destination"))).rejects.toMatchObject({ code: "not_available" });
    expect(await accesses(c.caseId)).toHaveLength(0); expect(s.port.refundDestination).not.toHaveBeenCalled();
  });
  test.each(["refund_not_received", "refund_overdue"] as const)("%s evidence uses the case's obligation id", async (kind) => {
    const c = await open(kind); const s = service(); await s.instance.readEvidence(read(c.caseId, "refund_destination"));
    expect(s.port.refundDestination).toHaveBeenCalledWith(expect.anything(), c.command.sourceId);
    expect(await accesses(c.caseId)).toMatchObject([{ itemType: "refund_destination", itemId: c.command.sourceId }]);
  });
  test("fileGrant logs item type file with the file id", async () => {
    const c = await open(); const s = service(); const fileId = randomUUID(); const requestId = randomUUID(); const stepUpProofId = randomUUID();
    await s.instance.fileGrant({ owner, stepUpProofId, caseId: c.caseId, fileId, disposition: "attachment", requestId });
    expect(s.port.fileGrant).toHaveBeenCalledWith(expect.anything(), { orderId: c.p.orderId, fileId, disposition: "attachment" });
    expect(await accesses(c.caseId)).toMatchObject([{ itemType: "file", itemId: fileId, requestId }]);
    expect(s.consumeStepUpProof).toHaveBeenCalledWith(expect.anything(), { proofId: stepUpProofId, ...owner, actionClass: "owner.case_file", now: at });
  });
  test("fileGrant refuses resolved cases and rejected proofs", async () => {
    const c = await open(); const command = { owner, stepUpProofId: randomUUID(), caseId: c.caseId, fileId: randomUUID(), disposition: "inline" as const, requestId: randomUUID() };
    const refused = service({ accepted: false });
    await expect(refused.instance.fileGrant(command)).rejects.toMatchObject({ code: "owner_step_up_required" });
    await resolve(c); const closed = service();
    await expect(closed.instance.fileGrant(command)).rejects.toMatchObject({ code: "not_available" });
    expect(await accesses(c.caseId)).toHaveLength(0); expect(closed.port.fileGrant).not.toHaveBeenCalled();
  });
  test("an unavailable file grant leaves no access or audit entry", async () => {
    const c = await open(); const s = service(); s.port.fileGrant.mockRejectedValue(new trust.TrustCaseError("not_available"));
    await expect(s.instance.fileGrant({ owner, stepUpProofId: randomUUID(), caseId: c.caseId, fileId: randomUUID(), disposition: "inline", requestId: randomUUID() })).rejects.toMatchObject({ code: "not_available" });
    expect(await accesses(c.caseId)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, c.caseId))).toHaveLength(0);
  });
  test("failed evidence dependencies roll back access and audit rows", async () => {
    const c = await open(); const s = service(); s.port.orderSummary.mockRejectedValue(new Error("Synthetic dependency failure"));
    await expect(s.instance.readEvidence(read(c.caseId))).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await accesses(c.caseId)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, c.caseId))).toHaveLength(0);
  });
  test("case events increment versions and resolution closes the open lookup", async () => {
    const c = await open();
    for (const action of ["question_posted", "deadline_extended"] as const) await fixture.db.transaction((tx) => c.port.recordCaseEvent(tx, { caseId: c.caseId, action, actor: owner, reason: "owner_review", requestId: randomUUID(), at }));
    expect(await fixture.db.transaction((tx) => c.port.findOpenCase(tx, { kind: c.command.kind, sourceId: c.command.sourceId }))).toEqual({ caseId: c.caseId, version: 3 });
    await resolve(c);
    expect(await fixture.db.transaction((tx) => c.port.findOpenCase(tx, { kind: c.command.kind, sourceId: c.command.sourceId }))).toBeNull();
    expect(await service().instance.getCase(c.caseId)).toMatchObject({ caseId: c.caseId, state: "resolved", version: 4 });
    await expect(resolve(c)).rejects.toMatchObject({ code: "not_available" });
  });
  test("resolution waits for an evidence read and its audit to commit", async () => {
    const c = await open(); const s = service();
    let entered!: () => void; let release!: () => void;
    const reading = new Promise<void>((done) => { entered = done; }); const resume = new Promise<void>((done) => { release = done; });
    s.port.orderSummary.mockImplementation(async () => { entered(); await resume; return { available: true }; });
    const pending = s.instance.readEvidence(read(c.caseId));
    try {
      await reading;
      await expect(fixture.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '200ms'`);
        await c.port.resolveCase(tx, { caseId: c.caseId, resolutionKind: "ruled", actor: owner, reason: null, requestId: randomUUID(), at });
      })).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally { release(); await pending; }
    expect(await accesses(c.caseId)).toHaveLength(1); await resolve(c);
    await expect(s.instance.readEvidence(read(c.caseId))).rejects.toMatchObject({ code: "not_available" });
    expect(await accesses(c.caseId)).toHaveLength(1);
  });
  test("queue filters and stable cursors expose summaries without reading private evidence", async () => {
    await open("late_payment"); await open("late_payment"); const c = await open(); await resolve(c); const s = service();
    const all = await s.instance.listQueue({ kind: "late_payment" }); expect(all.length).toBeGreaterThanOrEqual(2);
    const first = await s.instance.listQueue({ kind: "late_payment", limit: 1 });
    expect(first).toEqual(all.slice(0, 1));
    const next = await s.instance.listQueue({ kind: "late_payment", before: { openedAt: first[0]!.openedAt, id: first[0]!.caseId } });
    expect(next).toEqual(all.slice(1));
    expect((await s.instance.listQueue({ state: "resolved", kind: "dispute" })).some((row) => row.caseId === c.caseId)).toBe(true);
    await s.instance.getCase(c.caseId); expect(s.port.orderSummary).not.toHaveBeenCalled(); expect(s.consumeStepUpProof).not.toHaveBeenCalled();
  });
  test("invalid external records are refused before proof consumption", async () => {
    const c = await open(); const s = service(); const command = read(c.caseId);
    const getter = vi.fn(() => command.owner);
    const invalid = { ...command }; Object.defineProperty(invalid, "owner", { enumerable: true, get: getter });
    await expect(s.instance.readEvidence(invalid)).rejects.toMatchObject({ code: "invalid_request" }); expect(getter).not.toHaveBeenCalled();
    await expect(s.instance.readEvidence({ ...command, section: "thread_page", cursor: -1 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(s.instance.listQueue({ limit: 101 })).rejects.toMatchObject({ code: "invalid_request" });
    expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(await accesses(c.caseId)).toHaveLength(0);
  });
  test("hasEvidenceHold is true while open, true 29 days after resolution, false after 30 days, false for an order without cases", async () => {
    const c = await open(); let time = new Date(at); const hold = trust.createCaseEvidenceHoldPort({ now: () => time });
    expect(trust.TRUST_CASE_EVIDENCE_TAIL_MS).toBe(2_592_000_000);
    expect(await hold.hasEvidenceHold(fixture.db, c.p.orderId)).toBe(true);
    expect(await hold.hasEvidenceHold(fixture.db, (await order()).orderId)).toBe(false);
    await resolve(c); time = new Date(at.getTime() + 29 * 86_400_000);
    expect(await hold.hasEvidenceHold(fixture.db, c.p.orderId)).toBe(true);
    time = new Date(at.getTime() + 30 * 86_400_000);
    expect(await hold.hasEvidenceHold(fixture.db, c.p.orderId)).toBe(false);
  });
});
