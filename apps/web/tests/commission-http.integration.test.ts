import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionFileAccessPort, createCommissionOrderService, CommissionError, type CommissionRoute } from "@pawket/orders";
import { CommissionFileError, createCommissionThreadPort, createCommissionThreadService, encryptCommissionFileName } from "@pawket/commission-files";
import { createCreatorCommissionPaymentService, TipPaymentError } from "@pawket/payments";
import { createCommissionHttpHandlers } from "../src/platform/commission-http.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const platform = vi.hoisted(() => ({ commissionHandlers: {} as ReturnType<typeof createCommissionHttpHandlers> }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => platform }));

const f = createCommissionOrderTestFixture("commission_http");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);
const origin = "https://pawket.example.invalid";
async function setup(route: CommissionRoute = "fixed_immediate") {
  const s = await f.setup(route); const throttle = vi.fn(async () => true);
  const manual = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", recentAuthMs: 900_000,
    mfaAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle });
  const input = { appBaseUrl: origin, lookupHmacKey: s.creator.common.lookupHmacKey, intakeMode: "enabled" as const, paymentsMode: "manual_only" as const,
    fulfillmentMode: "disabled" as const,
    authenticate: async (headers: Headers) => {
      const userId = headers.get("x-synthetic-user"); const sessionId = headers.get("x-synthetic-session");
      return userId && sessionId && s.users.get(userId) === sessionId ? { userId, sessionId } : null;
    }, throttle, orders: s.service, catalog: s.catalog, manual };
  const handlers = createCommissionHttpHandlers(input);
  const req = (method = "GET", payload?: unknown, actor = s.buyerActor, query = "") => new Request(`${origin}/api/v1/commissions${query}`, { method,
    headers: { origin, "x-real-ip": "192.0.2.60", "x-synthetic-user": actor.userId, "x-synthetic-session": actor.sessionId,
      "content-type": "application/json", "idempotency-key": randomUUID() }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const requestBody = () => { const command = s.request(); return { packageId: command.packageId, revisionId: command.revisionId, policyRevisionId: command.policyRevisionId,
    acceptTerms: command.acceptTerms, brief: command.brief }; };
  return { ...s, orderInput: s.input, input, handlers, req, requestBody, throttle };
}
async function json(response: Response, status = 200) {
  expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer"); return response.json();
}
describe("commission HTTP boundary", () => {
  const routes = [
    ["buyer", "thread", "GET", "../src/app/api/v1/commissions/[orderId]/thread/route.js"],
    ["creator", "thread", "GET", "../src/app/api/v1/creator/commissions/[orderId]/thread/route.js"],
    ["buyer", "message", "POST", "../src/app/api/v1/commissions/[orderId]/messages/route.js"],
    ["creator", "message", "POST", "../src/app/api/v1/creator/commissions/[orderId]/messages/route.js"],
    ["creator", "submit", "POST", "../src/app/api/v1/creator/commissions/[orderId]/submissions/route.js"],
    ["buyer", "respond", "POST", "../src/app/api/v1/commissions/[orderId]/submissions/[submissionId]/respond/route.js"],
  ] as const;
  async function fulfillment() {
    const p = await f.paidOrder(); const s = p.s;
    const orders = createCommissionOrderService({ ...s.input, fulfillmentMode: "enabled", thread: createCommissionThreadPort({ keyring: s.input.keyring, mode: "enabled" }) });
    const thread = createCommissionThreadService({ db: f.db, keyring: s.input.keyring, lookupHmacKey: s.input.lookupHmacKey, filesMode: "enabled",
      fulfillmentMode: "enabled", sessions: s.input.identity, orders: createCommissionFileAccessPort({ catalog: s.catalog }), now: s.creator.now });
    const authenticate = async (headers: Headers) => {
      const userId = headers.get("x-synthetic-user"); const sessionId = headers.get("x-synthetic-session");
      return userId && sessionId && s.users.get(userId) === sessionId ? { userId, sessionId } : null;
    };
    const input = { appBaseUrl: origin, lookupHmacKey: s.input.lookupHmacKey, intakeMode: "enabled" as const, paymentsMode: "manual_only" as const,
      fulfillmentMode: "enabled" as const, authenticate, throttle: vi.fn(async () => true), orders, thread, catalog: s.catalog, manual: {} as never };
    const http = createCommissionHttpHandlers(input); platform.commissionHandlers = http;
    const req = (path: string, method = "GET", body?: unknown, actor = p.buyer) => new Request(`${origin}${path}`, { method,
      headers: { origin, "x-real-ip": "192.0.2.61", "x-synthetic-user": actor.userId, "x-synthetic-session": actor.sessionId,
        "content-type": "application/json", "idempotency-key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ...p, http, input, req };
  }
  test.each(routes)("%s %s route enforces the private HTTP boundary", async (role, operation, method, modulePath) => {
    const p = await fulfillment(); const adapter = await import(modulePath);
    const actor = role === "creator" ? p.creator : p.buyer; const opposite = role === "creator" ? p.buyer : p.creator;
    const submissionId = randomUUID(); const context = { params: Promise.resolve({ orderId: p.orderId, submissionId }) };
    const path = `/api/v1/${role === "creator" ? "creator/" : ""}commissions/${p.orderId}/${operation === "message" ? "messages" : operation === "submit" ? "submissions" : operation === "respond" ? `submissions/${submissionId}/respond` : "thread"}`;
    const payload = operation === "message" ? { text: "Synthetic private text" } : operation === "submit" ? { expectedVersion: 2, kind: "draft", fileIds: [randomUUID()] }
      : { expectedVersion: 2, response: "approve" };
    const request = () => p.req(path, method, method === "POST" ? payload : undefined, actor);
    const execute = (q: Request) => adapter[method](q, context) as Promise<Response>;
    await json(await execute(p.req(path, method === "POST" ? "GET" : "POST", undefined, actor)), 405);
    for (const headers of [{ origin: "https://foreign.example.invalid" }, { "sec-fetch-site": "cross-site" }]) {
      const q = request(); for (const [name, value] of Object.entries(headers)) q.headers.set(name, value!); await json(await execute(q), 403);
    }
    const guest = request(); guest.headers.delete("x-synthetic-user"); await json(await execute(guest), 401);
    await json(await execute(p.req(path, method, method === "POST" ? payload : undefined, await p.s.buyer())), 404);
    await json(await execute(p.req(path, method, method === "POST" ? payload : undefined, opposite)), 404);
    await json(await execute(method === "POST" ? p.req(path, method, { ...payload, unexpected: true }, actor) : p.req(`${path}?unexpected=1`, method, undefined, actor)), 400);
    if (method === "GET") { const read = request(); read.headers.delete("origin"); await json(await execute(read)); }
  });
  test("messages, submissions, responses and paginated thread reads share the committed services", async () => {
    const p = await fulfillment();
    const first = await json(await p.http.message(p.req(`/api/v1/commissions/${p.orderId}/messages`, "POST", { text: "Synthetic private text <3" }), p.orderId, "buyer"));
    expect(first.message.sequence).toBe(1);
    const fileId = randomUUID(); const at = p.s.creator.now();
    await f.db.insert(schema.commissionFiles).values({ id: fileId, context: "submission", uploadOrderId: p.orderId, ownerUserId: p.creator.userId,
      declaredBytes: 16, filenameEnvelope: encryptCommissionFileName(p.s.input.keyring, fileId, "Synthetic artwork"), objectKey: `commission/${fileId}`,
      uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
    await f.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2 }).where(eq(schema.commissionFiles.id, fileId));
    await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png", quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3 }).where(eq(schema.commissionFiles.id, fileId));
    await json(await p.http.submit(p.req(`/api/v1/creator/commissions/${p.orderId}/submissions`, "POST", { expectedVersion: 2, kind: "final", fileIds: [fileId] }, p.creator), p.orderId));
    const result = await json(await p.http.thread(p.req(`/api/v1/commissions/${p.orderId}/thread?limit=1`), p.orderId, "buyer"));
    expect(result.thread.items).toHaveLength(1); const item = result.thread.items[0]; expect(item.kind).toBe("submission");
    const older = await json(await p.http.thread(p.req(`/api/v1/commissions/${p.orderId}/thread?before=${result.thread.nextBeforeSequence}&limit=1`), p.orderId, "buyer"));
    expect(older.thread.items[0].text === "Synthetic private text <3").toBe(true);
    await json(await p.http.respond(p.req(`/api/v1/commissions/${p.orderId}/submissions/${item.id}/respond`, "POST", { expectedVersion: 3, response: "accept" }), p.orderId, item.id));
    expect((await json(await p.http.detail(p.req(`/api/v1/commissions/${p.orderId}`), p.orderId, "buyer"))).controls.fulfillmentMode).toBe("enabled");
    expect((await json(await p.http.thread(p.req(`/api/v1/commissions/${p.orderId}/thread`), p.orderId, "buyer"))).thread.writable).toBe(false);
  });
  test("fulfillment errors are bounded and never echo private input", async () => {
    const p = await fulfillment();
    for (const [code, status] of [["fulfillment_disabled", 503], ["invalid_attachment_files", 400], ["revisions_exhausted", 409], ["completion_held", 409]] as const) {
      const http = createCommissionHttpHandlers({ ...p.input, orders: { ...p.input.orders, submit: async () => { throw new CommissionError(code); } } });
      expect(await json(await http.submit(p.req(`/api/v1/creator/commissions/${p.orderId}/submissions`, "POST", { expectedVersion: 2, kind: "draft", note: "Synthetic private note", fileIds: [randomUUID()] }, p.creator), p.orderId), status)).toEqual({ code });
    }
    const http = createCommissionHttpHandlers({ ...p.input, thread: { sendMessage: async () => { throw new CommissionFileError("invalid_attachment_files"); } } });
    expect(await json(await http.message(p.req(`/api/v1/commissions/${p.orderId}/messages`, "POST", { text: "Synthetic private text" }), p.orderId, "buyer"), 400)).toEqual({ code: "invalid_attachment_files" });
    const publicHttp = createCommissionHttpHandlers({ ...p.input, catalog: { ...p.input.catalog, listPublic: async () => [] } });
    const publicRead = p.req("/api/v1/public/creators/synthetic/commissions"); publicRead.headers.set("origin", "https://foreign.example.invalid");
    expect((await publicHttp.publicPackages(publicRead, "synthetic")).status).toBe(200);
  });
  test.each(["fixed_immediate", "fixed_approval", "custom_quote"] as const)("%s exposes the complete authenticated request-to-payment journey", async (route) => {
    const s = await setup(route); const request = s.req("POST", s.requestBody());
    const { orderId } = await json(await s.handlers.request(request.clone()));
    expect(await json(await s.handlers.request(request.clone()))).toEqual({ orderId });
    if (route === "fixed_approval") await json(await s.handlers.mutate(s.req("POST", { expectedVersion: 1, quoteRevisionId: null, policyRevisionId: s.policyId, acceptTerms: true }, s.creator.actor), orderId, "creator", "accept"));
    if (route === "custom_quote") {
      await json(await s.handlers.mutate(s.req("POST", { expectedVersion: 1, terms: s.terms, ttlMs: 86_400_000 }, s.creator.actor), orderId, "creator", "quote"));
      const { order } = await json(await s.handlers.detail(s.req(), orderId, "buyer"));
      await json(await s.handlers.mutate(s.req("POST", { expectedVersion: 2, quoteRevisionId: order.quote.id, policyRevisionId: s.policyId, acceptTerms: true }), orderId, "buyer", "accept"));
    }
    const { order } = await json(await s.handlers.detail(s.req(), orderId, "buyer")); expect(order.payment.instruction.qrPayload).toBeTruthy();
    await json(await s.handlers.mutate(s.req("POST", { expectedVersion: order.version }), orderId, "buyer", "claim"));
    const command = s.req("POST", { observedAmountVnd: order.payment.amountVnd, observedTransferReference: order.payment.reference,
      observedBankTransactionId: randomUUID(), attestedReceived: true }, s.creator.actor);
    await json(await s.handlers.confirm(command.clone(), orderId)); await json(await s.handlers.confirm(command.clone(), orderId));
    expect((await json(await s.handlers.detail(s.req(), orderId, "buyer"))).order).toMatchObject({ state: "in_progress", payment: { instruction: null, confirmationSource: "creator_manual" } });
    expect((await json(await s.handlers.list(s.req(), "buyer"))).orders.items).toHaveLength(1);
    await json(await s.handlers.history(s.req(), orderId, "buyer", "quotes")); await json(await s.handlers.history(s.req(), orderId, "buyer", "timeline"));
  });
  test("guests, unrelated accounts and wrong route roles cannot read or confirm private orders", async () => {
    const s = await setup(); const { orderId } = await json(await s.handlers.request(s.req("POST", s.requestBody())));
    const guest = s.req(); guest.headers.delete("x-synthetic-user");
    await json(await s.handlers.detail(guest, orderId, "buyer"), 401);
    const stranger = await s.buyer();
    for (const id of [orderId, randomUUID()]) expect(await json(await s.handlers.detail(s.req("GET", undefined, stranger), id, "buyer"), 404)).toEqual({ code: "not_available" });
    await json(await s.handlers.detail(s.req(), orderId, "creator"), 404);
    await json(await s.handlers.confirm(s.req("POST", {}), orderId), 404);
    await json(await s.handlers.workspace(s.req()), 404);
    const spoofed = { ...s.requestBody(), actor: s.creator.actor }; await json(await s.handlers.request(s.req("POST", spoofed)), 400);
  });
  test("same-origin, network attribution, schema, media type and streaming size are enforced", async () => {
    const s = await setup();
    for (const [header, value, status] of [["origin", "https://untrusted.example.invalid", 403], ["sec-fetch-site", "cross-site", 403],
      ["x-real-ip", "garbage", 503], ["content-type", "text/plain", 415], ["content-encoding", "gzip", 400], ["idempotency-key", "", 400]] as const) {
      const request = s.req("POST", s.requestBody()); request.headers.set(header, value); await json(await s.handlers.request(request), status);
    }
    await json(await s.handlers.request(s.req("GET")), 405);
    await json(await s.handlers.request(s.req("POST", { ...s.requestBody(), brief: { text: "x".repeat(65_537), referenceLinks: [] } })), 413);
    // A valid Unicode brief is larger than the legacy tip body's 4 KiB limit.
    await json(await s.handlers.request(s.req("POST", { ...s.requestBody(), brief: { text: "🎨".repeat(3_000), referenceLinks: [] } })));
    for (const query of ["?role=creator", "?limit=1&limit=2", "?limit=0", "?beforeId=" + randomUUID(), "?limit=1e2"])
      await json(await s.handlers.list(s.req("GET", undefined, s.buyerActor, query), "buyer"), 400);
    expect(JSON.stringify(s.throttle.mock.calls)).not.toContain("192.0.2.60");
    s.throttle.mockResolvedValue(false); await json(await s.handlers.list(s.req(), "buyer"), 429);
  });
  test("pause preserves private history and closing, while disabling new intake and confirmation", async () => {
    const s = await setup(); const { orderId } = await json(await s.handlers.request(s.req("POST", s.requestBody())));
    const orders = createCommissionOrderService({ ...s.orderInput, intakeMode: "disabled", paymentsMode: "disabled" });
    const manual = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "disabled", recentAuthMs: 900_000,
      mfaAuthMs: 300_000, assurance: s.creator.assurance, commissions: orders.paymentsLifecycle });
    const paused = createCommissionHttpHandlers({ ...s.input, intakeMode: "disabled", paymentsMode: "disabled", orders, manual });
    const { order } = await json(await paused.detail(s.req(), orderId, "buyer")); expect(order.payment.instruction).toBeNull();
    expect(await json(await paused.request(s.req("POST", s.requestBody())), 503)).toEqual({ code: "intake_disabled" });
    expect(await json(await paused.confirm(s.req("POST", { observedAmountVnd: order.payment.amountVnd, observedTransferReference: order.payment.reference,
      observedBankTransactionId: randomUUID(), attestedReceived: true }, s.creator.actor), orderId), 503)).toEqual({ code: "payments_disabled" });
    await json(await paused.mutate(s.req("POST", { expectedVersion: order.version }), orderId, "buyer", "close"));
    expect((await json(await paused.detail(s.req(), orderId, "buyer"))).order.state).toBe("closed");
    await json(await paused.workspace(s.req("GET", undefined, s.creator.actor)));
  });
  test("recent authentication failures are bounded responses, without leaking internal error details", async () => {
    const s = await setup(); const { orderId } = await json(await s.handlers.request(s.req("POST", s.requestBody())));
    const handlers = createCommissionHttpHandlers({ ...s.input, manual: { confirm: async () => { throw new TipPaymentError("recent_auth_required"); } } });
    expect(await json(await handlers.confirm(s.req("POST", { observedAmountVnd: 500_000, observedTransferReference: "PW" + "A".repeat(20), observedBankTransactionId: "synthetic", attestedReceived: true }, s.creator.actor), orderId), 403)).toEqual({ code: "recent_auth_required" });
  });
});
