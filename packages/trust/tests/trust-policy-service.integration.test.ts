import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createTrustPolicyService } from "../src/trust-policy-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for trust policy service tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Trust policy service tests require a dedicated local test database");
}
const schemaName = `trust_policy_service_${process.pid}_${Date.now()}`; const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
const db = drizzle(client, { schema }); const at = new Date("2026-10-10T00:00Z");
const owner = { userId: `policy-owner-${randomUUID()}`, sessionId: `policy-session-${randomUUID()}` };
beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
  await db.insert(schema.identityUsers).values({ id: owner.userId, name: "Synthetic owner", email: `${owner.userId}@example.invalid`, canonicalEmail: `${owner.userId}@example.invalid`, createdAt: at, updatedAt: at });
  const expiresAt = new Date(at.getTime() + 86_400_000);
  await db.insert(schema.identitySessions).values({ id: owner.sessionId, userId: owner.userId, token: randomUUID(),
    expiresAt, absoluteExpiresAt: expiresAt, idleExpiresAt: expiresAt, createdAt: at, updatedAt: at, lastUsedAt: at });
}, 30_000);
afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
}, 30_000);
function service(options: Partial<Parameters<typeof createTrustPolicyService>[0]> = {}) {
  // A transaction-backed proof port pins action, owner, session, expiry and single consumption.
  const consumeStepUpProof = vi.fn<Parameters<typeof createTrustPolicyService>[0]["consumeStepUpProof"]>(async (tx, proof) => {
    const [consumed] = await tx.update(schema.identityStepUpProofs).set({ consumedAt: proof.now }).where(and(
      eq(schema.identityStepUpProofs.id, proof.proofId), eq(schema.identityStepUpProofs.sessionId, proof.sessionId),
      eq(schema.identityStepUpProofs.userId, proof.userId), eq(schema.identityStepUpProofs.actionClass, proof.actionClass),
      isNull(schema.identityStepUpProofs.consumedAt), gt(schema.identityStepUpProofs.expiresAt, proof.now),
    )).returning({ id: schema.identityStepUpProofs.id });
    return !!consumed;
  });
  return { consumeStepUpProof, instance: createTrustPolicyService({ db, applicationRevision: "synthetic-i8-b", now: () => at, consumeStepUpProof, ...options }) };
}
async function proof(actionClass = "owner.trust_policy_publish") {
  const id = randomUUID();
  await db.insert(schema.identityStepUpProofs).values({ id, ...owner, actionClass, assuranceMethod: "mfa", issuedAt: at, expiresAt: new Date(at.getTime() + 3_600_000) });
  return id;
}
async function command(kind: "community_rules" | "enforcement_appeals" = "community_rules") {
  const current = await service().instance.readCurrent(kind);
  return { owner, kind, stepUpProofId: await proof(), expectedRevisionNumber: current?.revisionNumber ?? 0,
    idempotencyKey: randomUUID(), requestId: randomUUID(), document: "Tiêu\nSynthetic community policy" };
}
const consumed = async (id: string) => (await db.select().from(schema.identityStepUpProofs).where(eq(schema.identityStepUpProofs.id, id)))[0]!.consumedAt;

describe("trust policy publishing", () => {
  test("empty current policies return null and null revision IDs", async () => {
    const s = service(); expect(await s.instance.readCurrent("community_rules")).toBeNull();
    expect(await db.transaction((tx) => s.instance.readCurrentIds(tx))).toEqual({ communityRulesRevisionId: null, enforcementRevisionId: null });
  });
  test("concurrent initial publication serializes the missing current pointer", async () => {
    const s = service(); const one = await command("enforcement_appeals"); const two = await command("enforcement_appeals");
    const results = await Promise.allSettled([s.instance.publish(one), s.instance.publish(two)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "version_conflict" }) })]);
  });
  test("publish requires a consumed owner.trust_policy_publish proof", async () => {
    const s = service(); const c = { ...await command(), stepUpProofId: await proof("owner.case_rule") };
    await expect(s.instance.publish(c)).rejects.toMatchObject({ code: "owner_step_up_required" });
    expect(s.consumeStepUpProof).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actionClass: "owner.trust_policy_publish" }));
    expect(await consumed(c.stepUpProofId)).toBeNull(); expect(await s.instance.readCurrent(c.kind)).toBeNull();
    const valid = await command(); await s.instance.publish(valid); expect(await consumed(valid.stepUpProofId)).toEqual(at);
  });
  test("publish with a stale expectedRevisionNumber gives version_conflict", async () => {
    const s = service(); const c = { ...await command(), expectedRevisionNumber: 0 };
    await expect(s.instance.publish(c)).rejects.toMatchObject({ code: "version_conflict" });
    expect(await consumed(c.stepUpProofId)).toBeNull();
    expect(await db.select().from(schema.systemCommandIdempotency).where(eq(schema.systemCommandIdempotency.actorUserId, owner.userId)))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "in_progress" })]));
  });
  test("replay returns the same revision without consuming a second proof", async () => {
    const s = service(); const c = await command(); const first = await s.instance.publish(c);
    const anotherProof = await proof();
    expect(await s.instance.publish({ ...c, stepUpProofId: anotherProof, requestId: randomUUID() })).toEqual(first);
    expect(s.consumeStepUpProof).toHaveBeenCalledTimes(1); expect(await consumed(anotherProof)).toBeNull();
    await expect(s.instance.publish({ ...c, document: "Different policy" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(s.consumeStepUpProof).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, first.revisionId))).toHaveLength(1);
    const newer = await s.instance.publish(await command()); expect(newer.revisionNumber).toBeGreaterThan(first.revisionNumber);
    expect(await s.instance.publish(c)).toEqual(first);
  });
  test("publish writes an admin audit row with kind and revision number but not the document", async () => {
    const s = service(); const c = await command("enforcement_appeals"); const result = await s.instance.publish(c);
    const [audit] = await db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, c.requestId));
    expect(audit).toMatchObject({ actorUserId: owner.userId, actorSessionId: owner.sessionId, action: "owner.trust_policy_publish",
      outcome: "succeeded", applicationRevision: "synthetic-i8-b", afterState: { kind: c.kind, revisionId: result.revisionId, revisionNumber: result.revisionNumber } });
    expect(JSON.stringify(audit)).not.toContain("Synthetic community policy"); expect(JSON.stringify(audit)).not.toContain("document");
    const current = await s.instance.readCurrent(c.kind); const document = c.document.normalize("NFC");
    expect(current).toEqual({ ...result, kind: c.kind, document, checksum: `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`, effectiveAt: at.toISOString() });
    const [row] = await db.select().from(schema.trustPolicyRevisions).where(eq(schema.trustPolicyRevisions.id, result.revisionId));
    expect(row).toMatchObject({ approvalKind: "owner_reviewed", actorUserId: owner.userId, actorSessionId: owner.sessionId, source: "synthetic-i8-b" });
    expect(await db.transaction((tx) => s.instance.readCurrentIds(tx))).toEqual({
      communityRulesRevisionId: (await s.instance.readCurrent("community_rules"))!.revisionId, enforcementRevisionId: result.revisionId,
    });
  });
  test("concurrent publication allows only one writer to advance the expected head", async () => {
    const s = service(); const one = await command(); const two = await command();
    const results = await Promise.allSettled([s.instance.publish(one), s.instance.publish(two)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "version_conflict" }) })]);
  });
  test("invalid commands do not evaluate accessors or consume proofs", async () => {
    const s = service(); const c = await command(); const getter = vi.fn(() => c.document);
    const invalid = { ...c }; Object.defineProperty(invalid, "document", { enumerable: true, get: getter });
    await expect(s.instance.publish(invalid)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(s.instance.publish({ ...c, document: "a\tb" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(s.instance.publish({ ...c, expectedRevisionNumber: -1 })).rejects.toMatchObject({ code: "invalid_request" });
    expect(getter).not.toHaveBeenCalled(); expect(s.consumeStepUpProof).not.toHaveBeenCalled();
  });
  test("failure after proof consumption rolls back the proof and policy writes", async () => {
    const c = await command(); const s = service({ idFactory: () => "invalid-id" });
    await expect(s.instance.publish(c)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(s.consumeStepUpProof).toHaveBeenCalledTimes(1); expect(await consumed(c.stepUpProofId)).toBeNull();
    expect((await s.instance.readCurrent(c.kind))!.revisionNumber).toBe(c.expectedRevisionNumber);
  });
});
