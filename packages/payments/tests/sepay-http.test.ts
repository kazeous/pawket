import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createSePayHttpHandlers } from "../src/sepay-http.js";
import { SePayServiceError } from "../src/sepay-service-support.js";
import { SePayWebhookError } from "../src/sepay-webhook.js";

const origin = "https://pawket.example.invalid";
const actor = { userId: "synthetic-creator", sessionId: "synthetic-session" };
const connectionId = randomUUID();
type Input = Parameters<typeof createSePayHttpHandlers>[0];
function fixture(overrides: Partial<Pick<Input, "paymentsMode" | "ingressEnabled">> = {}) {
  const input = {
    appBaseUrl: origin, paymentsMode: "sepay_optional", ingressEnabled: true, lookupHmacKey: new Uint8Array(32).fill(43),
    authenticate: vi.fn<Input["authenticate"]>(async () => actor), throttle: vi.fn<Input["throttle"]>(async () => true),
    connections: { getSnapshot: vi.fn(async () => ({ available: false, blockReason: "provider_contract_pending" as const, connection: null })),
      start: vi.fn(async () => ({ authorizationUrl: null, restartRequired: true })), callback: vi.fn(async () => {}),
      listAccounts: vi.fn(async () => ({ connectionVersion: 1, accounts: [] })), bindAccount: vi.fn<Input["connections"]["bindAccount"]>(), change: vi.fn<Input["connections"]["change"]>() },
    reviews: { list: vi.fn(async () => ({ items: [], nextCursor: null })), decide: vi.fn(async () => {}), diagnostics: vi.fn(async () => ({ items: [] })) },
    reconciliation: { confirmReviewed: vi.fn(async () => "confirmed" as const) },
    inbox: { receive: vi.fn<Input["inbox"]["receive"]>(async () => "accepted") }, onOperation: vi.fn(),
    ...overrides,
  } satisfies Input;
  return { input, handlers: createSePayHttpHandlers(input) };
}
function request(path: string, value?: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL(path, origin), { method: value === undefined ? "GET" : "POST", headers: {
    "x-real-ip": "127.0.0.1", ...(value === undefined ? {} : { origin, "content-type": "application/json", "idempotency-key": randomUUID() }), ...headers,
  }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ code });
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("SePay HTTP trust and durable acknowledgement", () => {
  test("private GETs reject extra query fields and cross-site reads without serializing an error as success", async () => {
    const { input, handlers } = fixture();
    await expectCode(await handlers.snapshot(request("/snapshot?token=synthetic")), 400, "invalid_request");
    await expectCode(await handlers.snapshot(request("/snapshot", undefined, { "sec-fetch-site": "cross-site" })), 403, "untrusted_origin");
    expect(input.connections.getSnapshot).not.toHaveBeenCalled();
    const response = await handlers.accounts(request("/accounts"), connectionId);
    expect(response.status).toBe(200);
    expect(input.connections.listAccounts).toHaveBeenCalledWith({ actor, connectionId });
    expect(input.connections.start).not.toHaveBeenCalled();
  });

  test("commands require trusted origin, live session, bounded network identity and idempotency", async () => {
    const { input, handlers } = fixture();
    await expectCode(await handlers.start(request("/start", {}, { origin: "https://attacker.example.invalid" })), 403, "untrusted_origin");
    await expectCode(await handlers.start(request("/start", {}, { "x-real-ip": "untrusted" })), 503, "dependency_unavailable");
    await expectCode(await handlers.start(request("/start", {}, { "idempotency-key": "" })), 400, "invalid_request");
    expect(input.connections.start).not.toHaveBeenCalled();
    input.authenticate.mockResolvedValueOnce(null);
    await expectCode(await handlers.start(request("/start", {})), 401, "authentication_required");
    input.throttle.mockResolvedValueOnce(false);
    await expectCode(await handlers.start(request("/start", {})), 429, "rate_limited");
    expect(input.connections.start).not.toHaveBeenCalled();
    expect((await handlers.start(request("/start", {}))).status).toBe(200);
    expect(input.connections.start).toHaveBeenCalledWith({ actor, idempotencyKey: expect.any(String), requestId: expect.any(String) });
    expect(input.throttle.mock.calls.at(-1)?.[0]).toMatchObject({ actorUserId: actor.userId, operation: "write", networkKeyHash: expect.stringMatching(/^hmac-sha256:/u) });
  });

  test("command body and routing fields cannot expand privileges or override actor identity", async () => {
    const { input, handlers } = fixture();
    await expectCode(await handlers.start(request("/start", { actor: { userId: "owner" } })), 400, "invalid_request");
    await expectCode(await handlers.change(request("/change", { expectedVersion: 1, action: "force_confirm" }), connectionId), 400, "invalid_request");
    await expectCode(await handlers.confirm(request("/confirm", { expectedVersion: 1, attestedReceived: false, reason: "Checked receipt" }), randomUUID()), 400, "invalid_request");
    await expectCode(await handlers.decide(request("/decide", { expectedVersion: 1, action: "dismiss", reason: "x".repeat(5_000) }), randomUUID()), 413, "invalid_request");
    expect(input.connections.start).not.toHaveBeenCalled(); expect(input.connections.change).not.toHaveBeenCalled();
    expect(input.reconciliation.confirmReviewed).not.toHaveBeenCalled(); expect(input.reviews.decide).not.toHaveBeenCalled();
  });

  test("disabled mode blocks commands while authenticated history remains readable", async () => {
    const { input, handlers } = fixture({ paymentsMode: "disabled", ingressEnabled: false });
    await expectCode(await handlers.start(request("/start", {})), 503, "payments_disabled");
    expect((await handlers.reviews(request("/reviews"))).status).toBe(200);
    await expectCode(await handlers.webhook(request("/webhook", {}), connectionId), 404, "not_available");
    expect(input.connections.start).not.toHaveBeenCalled(); expect(input.inbox.receive).not.toHaveBeenCalled();
    expect(input.onOperation).toHaveBeenCalledWith({ operation: "ingress", outcome: "disabled" });
  });

  test("callback consumes exact state and code once through its command and never reflects them", async () => {
    const { input, handlers } = fixture();
    const response = await handlers.callback(request("/callback?state=synthetic-state&code=synthetic-code", undefined, { "sec-fetch-site": "cross-site" }));
    expect(input.connections.callback).toHaveBeenCalledWith({ actor, state: "synthetic-state", code: "synthetic-code", requestId: expect.any(String) });
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(`${origin}/creator/tips/sepay?oauth=connected`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    input.connections.callback.mockClear();
    for (const query of ["state=a&state=b&code=c", "state=a&code=b&redirect=https://attacker.invalid", "error=raw-provider-error"]) {
      const invalid = await handlers.callback(request(`/callback?${query}`));
      expect(invalid.headers.get("location")).toBe(`${origin}/creator/tips/sepay?oauth=failed`);
      expect(await invalid.text()).toBe("");
    }
    expect(input.connections.callback).not.toHaveBeenCalled();
  });

  test("fixed errors do not disclose provider bodies or distinguish another creator's resources", async () => {
    const { input, handlers } = fixture();
    input.connections.getSnapshot.mockRejectedValueOnce(new Error("sensitive provider payload"));
    await expectCode(await handlers.snapshot(request("/snapshot")), 503, "dependency_unavailable");
    input.connections.getSnapshot.mockRejectedValueOnce(new SePayServiceError("not_authorized"));
    await expectCode(await handlers.snapshot(request("/snapshot")), 404, "not_available");
    input.connections.getSnapshot.mockRejectedValueOnce(new SePayServiceError("provider_unavailable", 30));
    const waiting = await handlers.snapshot(request("/snapshot"));
    expect(waiting.headers.get("retry-after")).toBe("30");
    await expectCode(waiting, 503, "provider_unavailable");
  });

  test.each(["accepted", "ignored", "duplicate", "conflict"] as const)("acks durable %s only after receipt completes and passes exact bytes", async (outcome) => {
    const { input, handlers } = fixture(); let release!: () => void; let entered!: () => void;
    const receiving = new Promise<void>((resolve) => { entered = resolve; }); const committed = new Promise<void>((resolve) => { release = resolve; });
    input.inbox.receive.mockImplementationOnce(async () => { entered(); await committed; return outcome; });
    const raw = '{ "unicode": "🎨", "id":9007199254740993 }\n';
    let replied = false;
    const pending = handlers.webhook(new Request(`${origin}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-sepay-timestamp": "123", "x-sepay-signature": "synthetic-signature" }, body: raw }), connectionId).then((response) => { replied = true; return response; });
    await receiving; expect(replied).toBe(false); expect(input.onOperation).not.toHaveBeenCalled(); release();
    const response = await pending; expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
    expect(new TextDecoder().decode(input.inbox.receive.mock.calls[0]![0].rawBody)).toBe(raw);
    expect(input.onOperation).toHaveBeenCalledWith({ operation: "ingress", outcome });
    expect(input.authenticate).not.toHaveBeenCalled();
  });

  test("database and authentication failures never acknowledge success", async () => {
    const { input, handlers } = fixture();
    input.inbox.receive.mockRejectedValueOnce(new Error("synthetic database unavailable"));
    await expectCode(await handlers.webhook(request("/webhook", {}), connectionId), 503, "dependency_unavailable");
    input.inbox.receive.mockRejectedValueOnce(new SePayWebhookError("invalid_authentication"));
    await expectCode(await handlers.webhook(request("/webhook", {}), connectionId), 401, "invalid_authentication");
    expect(input.onOperation.mock.calls).toEqual([[{ operation: "ingress", outcome: "failed" }], [{ operation: "ingress", outcome: "auth_failed" }]]);
  });

  test("webhook input is bounded even when Content-Length is absent or dishonest", async () => {
    const { input, handlers } = fixture();
    await expectCode(await handlers.webhook(request("/webhook", {}, { "content-length": "16385" }), connectionId), 413, "invalid_request");
    await expectCode(await handlers.webhook(request("/webhook", "x".repeat(16_385)), connectionId), 413, "invalid_request");
    await expectCode(await handlers.webhook(request("/webhook", {}, { "content-length": "1" }), connectionId), 400, "invalid_request");
    await expectCode(await handlers.webhook(request("/webhook", {}, { "content-encoding": "gzip" }), connectionId), 415, "invalid_request");
    expect(input.inbox.receive).not.toHaveBeenCalled();
  });

  test("unauthenticated floods are bounded before database access", async () => {
    const { input, handlers } = fixture();
    for (let index = 0; index < 120; index++) expect((await handlers.webhook(request("/webhook", {}), connectionId)).status).toBe(200);
    await expectCode(await handlers.webhook(request("/webhook", {}), randomUUID()), 429, "rate_limited");
    expect(input.inbox.receive).toHaveBeenCalledTimes(120);
  });
});
