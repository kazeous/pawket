import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { createCommissionThreadPort, encryptCommissionFileName } from "@pawket/commission-files";
import { importConfiguredBusinessCalendarVersion } from "@pawket/database";
import { createCommissionOrderService, createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createProposalService, createResolutionCommandKit, createResolutionHoldPort, effectiveResolutionDeadline, type ResolutionOrderPort, type ResolutionRefundPort,
  type ResolutionPaymentFactsPort, type ResolutionCasePort } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const DAY = 86_400_000;
const refundCalendarVersion = "vn-proposals-test";
export const resolutionRefundDeadlines = { effectiveDeadline: effectiveResolutionDeadline };
type Paid = Awaited<ReturnType<ReturnType<typeof createCommissionOrderTestFixture>["paidOrder"]>>;
type Options = Partial<Parameters<typeof createCommissionOrderService>[0]>;
export function service(p: Paid, options: Options = {}) {
  return createCommissionOrderService({ ...p.s.input, fulfillmentMode: "enabled",
    thread: createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled" }), holds: createResolutionHoldPort(), ...options });
}
type ProposalOptions = Partial<Parameters<typeof createProposalService>[1]>;
type KitOptions = Partial<Parameters<typeof createResolutionCommandKit>[0]>;
export function resolutions(p: Paid, options: ProposalOptions = {}, kitOptions: KitOptions = {}) {
  const orders: ResolutionOrderPort = createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
  const refunds: ResolutionRefundPort = createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: refundCalendarVersion });
  const payments: ResolutionPaymentFactsPort = createCommissionPaymentFactsPort();
  const cases: ResolutionCasePort = createTrustCasePort();
  const kit = createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, ...kitOptions });
  return createProposalService(kit, { orders, refunds, payments, cases, mode: "enabled", ...options });
}
const order = (p: Paid) => p.s.input.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const submissions = (p: Paid) => p.s.input.db.select().from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.orderId, p.orderId));
export async function cleanFile(p: Paid, options: { context?: "thread" | "submission"; ownerUserId?: string; state?: "scanning" | "clean" } = {}) {
  const id = randomUUID(); const at = p.s.creator.now(); const db = p.s.input.db;
  await db.insert(schema.commissionFiles).values({ id, ownerUserId: options.ownerUserId ?? p.creator.userId,
    context: options.context ?? "submission", uploadOrderId: p.orderId, declaredBytes: 16,
    filenameEnvelope: encryptCommissionFileName(p.s.input.keyring, id, "Synthetic artwork"), objectKey: `commission/${id}`,
    uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
  await db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + DAY), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
  if (options.state !== "scanning") await db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`,
    detectedType: "png", quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
  return id;
}
export async function submitCommand(p: Paid, kind: "draft" | "final" = "draft") {
  return { actor: p.creator, orderId: p.orderId, expectedVersion: (await order(p)).version,
    kind, note: "Synthetic note <3", fileIds: [await cleanFile(p)], ...commandIds() };
}
export async function submit(p: Paid, kind: "draft" | "final" = "draft", instance = service(p)) {
  const command = await submitCommand(p, kind);
  expect(await instance.submit(command)).toBe(p.orderId);
  return (await submissions(p)).find((row) => row.requestId === command.requestId)!;
}
export async function responseCommand(p: Paid, submissionId: string, response: "approve" | "request_changes" | "accept" = "accept") {
  return { actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version, submissionId, response,
    note: response === "request_changes" ? "Synthetic change request" : undefined, ...commandIds() };
}
export async function respond(p: Paid, submissionId: string, response: "approve" | "request_changes" | "accept", instance = service(p)) {
  return instance.respondToSubmission(await responseCommand(p, submissionId, response));
}
export function createCommissionResolutionTestFixture(label: string) {
  const base = createCommissionOrderTestFixture(label);
  async function initialize() {
    await base.initialize();
    await base.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: refundCalendarVersion, holidayDates: [] }));
  }
  async function deliveredOrder(options: Parameters<typeof base.paidOrder>[0] = {}) {
    const p = await base.paidOrder(options); const instance = service(p); const final = await submit(p, "final", instance);
    return { ...p, service: instance, finalId: final.id };
  }
  return { ...base, initialize, deliveredOrder, service, cleanFile, submit, respond, resolutions };
}
