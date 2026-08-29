import { describe, expect, test, vi } from "vitest";

import { CatalogServiceError } from "../src/catalog-service.js";
import * as catalog from "../src/index.js";

type HandlerName = "workspace" | "saveDraft" | "handle" | "showcases" | "publish" | "unpublish";
type CatalogHttpHandlers = Record<HandlerName, (request: Request) => Promise<Response>>;
type Factory = {
  createCatalogHttpHandlers(input: Record<string, unknown>): CatalogHttpHandlers;
};

const api = catalog as unknown as Partial<Factory>;
const origin = "https://pawket.example";
const pageId = "10000000-0000-4000-8000-000000000001";
const showcaseId = "10000000-0000-4000-8000-000000000002";
const assetId = "10000000-0000-4000-8000-000000000003";
const revisionId = "10000000-0000-4000-8000-000000000004";
const userId = "10000000-0000-4000-8000-000000000005";
const session = {
  userId,
  sessionId: "authoritative-session",
  primaryAuthenticatedAt: new Date("2026-08-30T02:00:00.000Z"),
};

const draft = {
  displayName: "Fox Artist",
  introduction: "General-audience creator introduction.",
  primaryDiscipline: "illustration",
  secondaryDisciplines: ["animation"],
  avatarAssetId: assetId,
  coverAssetId: null,
};

const showcase = {
  position: 0,
  title: "Forest studies",
  description: "A quiet general-audience series.",
  discipline: "illustration",
  contentLabel: "general_audience",
  externalUrl: "https://example.com/portfolio",
  media: [{ assetId, alternativeText: "A fox beneath green leaves" }],
};

const workspace = {
  pageId,
  draftVersion: 3,
  publishedRevisionId: null,
  canonicalHandle: "fox-artist",
  aliases: ["older-fox"],
  renameAvailableAt: new Date("2026-09-30T02:00:00.000Z"),
  draft,
  showcases: [
    {
      id: showcaseId,
      ...showcase,
      externalUrl: "https://example.com/portfolio",
      media: [{ ...showcase.media[0], position: 0 }],
    },
  ],
  capabilityState: "suspended",
  enforcement: {
    pageHeld: true,
    heldShowcaseIds: [showcaseId],
    explanation: "Please revise the affected showcase before publishing.",
    privateOwnerNote: "never expose this owner note",
    reporterUserId: "never expose this reporter",
  },
  approvedRevisionId: "private-application-revision",
  receivingAccount: "private-bank-data",
};

function defaultService() {
  const commandResult = { pageId, draftVersion: 4 };
  return {
    initialize: vi.fn(async () => workspace),
    getWorkspace: vi.fn(async () => workspace),
    saveDraft: vi.fn(async () => commandResult),
    claimHandle: vi.fn(async () => commandResult),
    renameHandle: vi.fn(async () => commandResult),
    upsertShowcase: vi.fn(async () => commandResult),
    removeShowcase: vi.fn(async () => commandResult),
    reorderShowcases: vi.fn(async () => commandResult),
    publish: vi.fn(async () => ({
      pageId,
      revisionId,
      revisionNumber: 2,
      canonicalHandle: "fox-artist",
      draftVersion: 3,
      publishedAt: new Date("2026-08-30T02:05:00.000Z"),
    })),
    unpublish: vi.fn(async () => ({
      pageId,
      previousPublishedRevisionId: revisionId,
      draftVersion: 3,
      unpublishedAt: new Date("2026-08-30T02:06:00.000Z"),
    })),
  };
}

function serviceFixture(overrides: Record<string, unknown> = {}) {
  return Object.assign(defaultService(), overrides);
}

function fixture(input?: {
  authenticated?: boolean;
  authenticateError?: Error;
  service?: ReturnType<typeof defaultService>;
  publishingMode?: "disabled" | "general_audience";
}) {
  expect(typeof api.createCatalogHttpHandlers).toBe("function");
  const service = input?.service ?? defaultService();
  const events: unknown[] = [];
  const authenticate = vi.fn(async () => {
    if (input?.authenticateError) throw input.authenticateError;
    return input?.authenticated === false ? null : session;
  });
  const handlers = api.createCatalogHttpHandlers!({
    trustedOrigins: [origin],
    publishingMode: input?.publishingMode ?? "general_audience",
    authenticate,
    service,
    onEvent: (event: unknown) => events.push(event),
  });
  return { handlers, service, authenticate, events };
}

function mutationRequest(input?: {
  body?: unknown;
  rawBody?: string;
  method?: string;
  contentType?: string | null;
  origin?: string | null;
  ifMatch?: string | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
}): Request {
  const headers = new Headers();
  const contentType = input?.contentType === undefined ? "application/json" : input.contentType;
  const requestOrigin = input?.origin === undefined ? origin : input.origin;
  const ifMatch = input?.ifMatch === undefined ? "3" : input.ifMatch;
  const idempotencyKey = input?.idempotencyKey === undefined ? "catalog-command-one" : input.idempotencyKey;
  const requestId = input?.requestId === undefined ? "catalog-request-one" : input.requestId;
  if (contentType !== null) headers.set("content-type", contentType);
  if (requestOrigin !== null) headers.set("origin", requestOrigin);
  if (ifMatch !== null) headers.set("if-match", ifMatch);
  if (idempotencyKey !== null) headers.set("idempotency-key", idempotencyKey);
  if (requestId !== null) headers.set("x-request-id", requestId);
  const method = input?.method ?? "POST";
  return new Request(`${origin}/api/v1/creator-page`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: input?.rawBody ?? JSON.stringify(input?.body ?? { pageId, draft }) }),
  });
}

function requestWithTrackedBody(input: Parameters<typeof mutationRequest>[0]) {
  const request = mutationRequest(input);
  const body = request.body;
  let reads = 0;
  Object.defineProperty(request, "body", {
    configurable: true,
    get() {
      reads += 1;
      return body;
    },
  });
  return { request, reads: () => reads };
}

function streamingRequest(bytes: Uint8Array, splitPoints: readonly number[]): Request {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const splitPoint of splitPoints) {
    chunks.push(bytes.slice(offset, splitPoint));
    offset = splitPoint;
  }
  chunks.push(bytes.slice(offset));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = new Headers({
    origin,
    "content-type": "application/json; charset=utf-8",
    "if-match": "3",
    "idempotency-key": "catalog-stream-one",
    "x-request-id": "catalog-stream-request",
  });
  return new Request(`${origin}/api/v1/creator-page`, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe("creator catalog HTTP request controls", () => {
  test("exports the framework-neutral handler factory", () => {
    // Break caught: Task 6 is not reachable through the package boundary.
    expect(typeof api.createCatalogHttpHandlers).toBe("function");
  });

  test.each([
    ["workspace", "POST"],
    ["saveDraft", "GET"],
    ["handle", "PATCH"],
    ["showcases", "DELETE"],
    ["publish", "PUT"],
    ["unpublish", "PATCH"],
  ] as const)("rejects the wrong method on %s", async (handlerName, method) => {
    // Break caught: a route accepting an unplanned method or relying on framework routing alone.
    const { handlers, service } = fixture();
    const request = handlerName === "workspace"
      ? new Request(`${origin}/api/v1/creator-page`, { method })
      : mutationRequest({ method });
    const response = await handlers[handlerName](request);
    expect(response.status).toBe(405);
    expect(Object.values(service).every((candidate) => candidate.mock.calls.length === 0)).toBe(true);
  });

  test.each([
    ["missing origin", { origin: null }, 403],
    ["wrong media type", { contentType: "text/plain" }, 415],
    ["oversized body", { rawBody: "x".repeat(32_769) }, 413],
    ["missing idempotency", { idempotencyKey: null }, 400],
    ["invalid idempotency", { idempotencyKey: "short" }, 400],
    ["missing If-Match", { ifMatch: null }, 428],
    ["zero If-Match", { ifMatch: "0" }, 400],
    ["unsafe If-Match", { ifMatch: "9007199254740992" }, 400],
  ] as const)("rejects %s before invoking saveDraft", async (_label, requestInput, status) => {
    // Break caught: malformed command controls reaching the service or being collapsed into one status.
    const { handlers, service } = fixture();
    const response = await handlers.saveDraft(mutationRequest(requestInput));
    expect(response.status).toBe(status);
    expect(service.saveDraft).not.toHaveBeenCalled();
  });

  test("gives origin and authentication guards precedence without reading the body", async () => {
    // Break caught: consuming attacker-controlled bodies before CSRF/authentication rejection.
    const untrustedFixture = fixture({ authenticated: false });
    const untrusted = requestWithTrackedBody({ origin: "https://evil.example" });
    expect((await untrustedFixture.handlers.saveDraft(untrusted.request)).status).toBe(403);
    expect(untrusted.reads()).toBe(0);
    expect(untrustedFixture.authenticate).not.toHaveBeenCalled();

    const unauthenticatedFixture = fixture({ authenticated: false });
    const unauthenticated = requestWithTrackedBody({ contentType: "text/plain", ifMatch: null });
    expect((await unauthenticatedFixture.handlers.saveDraft(unauthenticated.request)).status).toBe(401);
    expect(unauthenticated.reads()).toBe(0);
    expect(unauthenticatedFixture.service.saveDraft).not.toHaveBeenCalled();
  });

  test.each([
    ["missing content type", { contentType: null }, 415],
    ["unknown parameter", { contentType: "application/json; profile=unsafe" }, 415],
    ["suffix media type", { contentType: "application/problem+json" }, 415],
    ["duplicate charset", { contentType: "application/json; charset=utf-8; charset=utf-8" }, 415],
    ["missing version", { ifMatch: null }, 428],
    ["malformed version", { ifMatch: "\"3\"" }, 400],
    ["missing key", { idempotencyKey: null }, 400],
  ] as const)("rejects header control %s without reading the body", async (_label, requestInput, status) => {
    // Break caught: parsing a body whose declaration/version/replay control is already invalid.
    const { handlers } = fixture();
    const tracked = requestWithTrackedBody(requestInput);
    expect((await handlers.saveDraft(tracked.request)).status).toBe(status);
    expect(tracked.reads()).toBe(0);
  });

  test.each(["application/json", "Application/JSON; Charset=UTF-8"])(
    "accepts the explicit JSON media type policy: %s",
    async (contentType) => {
      // Break caught: rejecting standard UTF-8 JSON or accepting it without reaching the command.
      const { handlers, service } = fixture();
      expect((await handlers.saveDraft(mutationRequest({ contentType }))).status).toBe(200);
      expect(service.saveDraft).toHaveBeenCalledOnce();
    },
  );

  test.each([
    "https://evil.example",
    "https://pawket.example.evil.example",
    "https://evil.example/https://pawket.example",
    "https://pawket.example/",
    "HTTPS://PAWKET.EXAMPLE",
  ])("requires byte-for-byte trusted Origin equality: %s", async (requestOrigin) => {
    // Break caught: prefix/suffix/canonicalization tricks bypassing exact trusted-origin policy.
    const { handlers, authenticate, service } = fixture();
    expect((await handlers.saveDraft(mutationRequest({ origin: requestOrigin }))).status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    expect(service.saveDraft).not.toHaveBeenCalled();
  });

  test("counts streamed UTF-8 bytes at the exact 32,768-byte boundary", async () => {
    // Break caught: counting UTF-16 code units, individual chunks, or trusting Content-Length.
    const encoder = new TextEncoder();
    const base = JSON.stringify({ pageId, draft: { ...draft, displayName: "Fox 🦊 Artist" } });
    const baseBytes = encoder.encode(base);
    const exactBytes = encoder.encode(`${base}${" ".repeat(32_768 - baseBytes.byteLength)}`);
    const foxByte = exactBytes.indexOf(0xf0);
    const acceptedFixture = fixture();
    const accepted = await acceptedFixture.handlers.saveDraft(
      streamingRequest(exactBytes, [foxByte + 1, foxByte + 3, 16_000]),
    );
    expect(accepted.status).toBe(200);
    expect(acceptedFixture.service.saveDraft).toHaveBeenCalledOnce();

    const rejectedFixture = fixture();
    const oversized = new Uint8Array(32_769);
    oversized.set(exactBytes);
    oversized[32_768] = 0x20;
    const rejected = await rejectedFixture.handlers.saveDraft(
      streamingRequest(oversized, [foxByte + 2, 20_000]),
    );
    expect(rejected.status).toBe(413);
    expect(rejectedFixture.service.saveDraft).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON after bounded streaming without invoking the service", async () => {
    // Break caught: handing invalid or truncated JSON to command logic.
    const { handlers, service } = fixture();
    const response = await handlers.saveDraft(mutationRequest({ rawBody: '{"pageId":' }));
    expect(response.status).toBe(400);
    expect(service.saveDraft).not.toHaveBeenCalled();
  });
});

describe("creator catalog HTTP exact schemas and command routing", () => {
  test.each([
    ["outer extra", { pageId, draft, actor: session }],
    ["draft extra", { pageId, draft: { ...draft, privateNote: "secret" } }],
    ["prototype key", JSON.parse(`{"pageId":"${pageId}","draft":${JSON.stringify(draft)},"__proto__":{}}`)],
    ["wrong page type", { pageId: 1, draft }],
    ["empty display name", { pageId, draft: { ...draft, displayName: "" } }],
    ["long display name", { pageId, draft: { ...draft, displayName: "a".repeat(81) } }],
    ["long introduction", { pageId, draft: { ...draft, introduction: "a".repeat(501) } }],
    ["bad discipline", { pageId, draft: { ...draft, primaryDiscipline: "private" } }],
    ["three secondary disciplines", { pageId, draft: { ...draft, secondaryDisciplines: ["animation", "drawing", "painting"] } }],
    ["duplicate secondary discipline", { pageId, draft: { ...draft, secondaryDisciplines: ["animation", "animation"] } }],
    ["malformed asset", { pageId, draft: { ...draft, avatarAssetId: "asset" } }],
  ])("rejects invalid save schema: %s", async (_label, body) => {
    // Break caught: extras, authority fields, wrong types, or out-of-policy bounds crossing HTTP.
    const { handlers, service } = fixture();
    expect((await handlers.saveDraft(mutationRequest({ body }))).status).toBe(400);
    expect(service.saveDraft).not.toHaveBeenCalled();
  });

  test.each([
    ["handle", { pageId, action: "replace", handle: "new-fox" }],
    ["showcases", { pageId, action: "archive", showcaseId }],
    ["publish", { pageId, action: "publish" }],
    ["unpublish", { pageId, sessionId: "attacker-session" }],
  ] as const)("rejects an invalid or extra %s action contract", async (handlerName, body) => {
    // Break caught: ambiguous action routing or accepting body-supplied authority.
    const { handlers, service } = fixture();
    expect((await handlers[handlerName](mutationRequest({ body }))).status).toBe(400);
    expect(Object.values(service).every((candidate) => candidate.mock.calls.length === 0)).toBe(true);
  });

  test.each([
    ["position", { ...showcase, position: 12 }],
    ["title", { ...showcase, title: "" }],
    ["description", { ...showcase, description: "a".repeat(1_001) }],
    ["discipline", { ...showcase, discipline: "private" }],
    ["label", { ...showcase, contentLabel: "age_restricted" }],
    ["destination", { ...showcase, externalUrl: "http://example.com" }],
    ["media count", { ...showcase, media: Array.from({ length: 5 }, () => showcase.media[0]) }],
    ["media extra", { ...showcase, media: [{ ...showcase.media[0], storageKey: "secret" }] }],
    ["alt text", { ...showcase, media: [{ assetId, alternativeText: "" }] }],
  ])("rejects an invalid showcase %s", async (_label, invalidShowcase) => {
    // Break caught: malformed showcase data reaching a creator-owned mutation.
    const { handlers, service } = fixture();
    const response = await handlers.showcases(
      mutationRequest({ body: { pageId, action: "upsert", showcase: invalidShowcase } }),
    );
    expect(response.status).toBe(400);
    expect(service.upsertShowcase).not.toHaveBeenCalled();
  });

  test("maps every service method from exact route actions and authoritative authentication", async () => {
    // Break caught: wrong command fields, wrong action dispatch, or body-supplied actor assurance.
    const { handlers, service } = fixture();
    const workspaceResponse = await handlers.workspace(
      new Request(`${origin}/api/v1/creator-page`, {
        method: "GET",
        headers: { "x-request-id": "workspace-request" },
      }),
    );
    expect(workspaceResponse.status).toBe(200);
    expect(service.initialize).toHaveBeenCalledWith({ userId, requestId: "workspace-request" });
    expect(service.getWorkspace).not.toHaveBeenCalled();

    await handlers.saveDraft(mutationRequest({ body: { pageId, draft } }));
    expect(service.saveDraft).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "catalog-request-one", draft,
    });

    await handlers.handle(
      mutationRequest({ body: { pageId, action: "claim", handle: "first-fox" }, requestId: "claim-request" }),
    );
    expect(service.claimHandle).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "claim-request", handle: "first-fox",
    });

    await handlers.handle(
      mutationRequest({ body: { pageId, action: "rename", handle: "new-fox" }, requestId: "rename-request" }),
    );
    expect(service.renameHandle).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "rename-request", handle: "new-fox",
    });

    await handlers.showcases(
      mutationRequest({ body: { pageId, action: "upsert", showcase }, requestId: "upsert-request" }),
    );
    expect(service.upsertShowcase).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "upsert-request", showcase,
    });

    await handlers.showcases(
      mutationRequest({ body: { pageId, action: "remove", showcaseId }, requestId: "remove-request" }),
    );
    expect(service.removeShowcase).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "remove-request", showcaseId,
    });

    await handlers.showcases(
      mutationRequest({ body: { pageId, action: "reorder", showcaseIds: [showcaseId] }, requestId: "reorder-request" }),
    );
    expect(service.reorderShowcases).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "reorder-request", showcaseIds: [showcaseId],
    });

    await handlers.publish(mutationRequest({ body: { pageId }, requestId: "publish-request" }));
    expect(service.publish).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "publish-request",
    });

    await handlers.unpublish(mutationRequest({ body: { pageId }, requestId: "unpublish-request" }));
    expect(service.unpublish).toHaveBeenCalledWith({
      actor: session, pageId, expectedVersion: 3, idempotencyKey: "catalog-command-one",
      requestId: "unpublish-request",
    });
  });

  test("generates a bounded request ID when the supplied value is invalid", async () => {
    // Break caught: propagating attacker-controlled request IDs into durable command evidence.
    const { handlers, service } = fixture();
    const response = await handlers.saveDraft(
      mutationRequest({ body: { pageId, draft }, requestId: `bad/${"x".repeat(200)}` }),
    );
    expect(response.status).toBe(200);
    const command = (service.saveDraft.mock.calls as unknown as [unknown][]) [0]![0] as { requestId: string };
    expect(command.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(command.requestId.length).toBeLessThanOrEqual(128);
  });
});

describe("creator catalog HTTP failures and safe projections", () => {
  test.each([
    ["NOT_FOUND", 404],
    ["VERSION_CONFLICT", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["HANDLE_UNAVAILABLE", 409],
    ["RECENT_AUTH_REQUIRED", 403],
    ["RENAME_COOLDOWN", 409],
    ["POLICY_VIOLATION", 400],
  ] as const)("maps stable Catalog error %s", async (code, status) => {
    // Break caught: unstable/non-neutral status mapping or reflecting exception details.
    const error = new CatalogServiceError(code);
    error.stack = "secret stack";
    const service = serviceFixture({ saveDraft: vi.fn(async () => { throw error; }) });
    const { handlers } = fixture({ service });
    const response = await handlers.saveDraft(mutationRequest());
    expect(response.status).toBe(status);
    expect(await json(response)).toEqual({ code });
  });

  test("maps missing creator capability neutrally on the private workspace", async () => {
    // Break caught: disclosing whether a creator page exists when current capability is absent.
    const service = serviceFixture({
      initialize: vi.fn(async () => { throw new CatalogServiceError("NOT_FOUND"); }),
    });
    const { handlers } = fixture({ service });
    const response = await handlers.workspace(
      new Request(`${origin}/api/v1/creator-page`, { method: "GET" }),
    );
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ code: "NOT_FOUND" });
  });

  test("allows a suspended private workspace and projects only bounded creator-visible status", async () => {
    // Break caught: blocking remediation or leaking report/owner/payment/application fields.
    const { handlers } = fixture({ publishingMode: "disabled" });
    const response = await handlers.workspace(
      new Request(`${origin}/api/v1/creator-page`, { method: "GET" }),
    );
    const serialized = await response.clone().text();
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      workspace: {
        pageId,
        draftVersion: 3,
        publishedRevisionId: null,
        canonicalHandle: "fox-artist",
        aliases: ["older-fox"],
        renameAvailableAt: "2026-09-30T02:00:00.000Z",
        draft,
        showcases: workspace.showcases,
        status: {
          capabilityState: "suspended",
          publishingMode: "disabled",
          pageHeld: true,
          heldShowcaseIds: [showcaseId],
          explanation: "Please revise the affected showcase before publishing.",
        },
      },
    });
    expect(serialized).not.toContain("owner note");
    expect(serialized).not.toContain("reporter");
    expect(serialized).not.toContain("private-bank");
    expect(serialized).not.toContain("application-revision");
  });

  test("blocks a fresh disabled-mode publish as retryable but preserves service replay semantics", async () => {
    // Break caught: returning a policy 400 for the activation gate or pre-blocking a committed replay.
    const freshService = serviceFixture({
      publish: vi.fn(async () => { throw new CatalogServiceError("POLICY_VIOLATION"); }),
    });
    const fresh = fixture({ service: freshService, publishingMode: "disabled" });
    const blocked = await fresh.handlers.publish(mutationRequest({ body: { pageId } }));
    expect(blocked.status).toBe(503);
    expect(await json(blocked)).toEqual({ code: "PUBLISHING_DISABLED" });
    expect(freshService.publish).toHaveBeenCalledOnce();

    const replay = fixture({ publishingMode: "disabled" });
    const replayed = await replay.handlers.publish(mutationRequest({ body: { pageId } }));
    expect(replayed.status).toBe(200);
    expect(replay.service.publish).toHaveBeenCalledOnce();
    expect(replayed.headers.has("idempotency-key")).toBe(false);
    expect(replayed.headers.has("idempotency-replayed")).toBe(false);
    expect(replayed.headers.has("session-id")).toBe(false);
  });

  test("maps authentication and unexpected dependency failures to bounded 503 responses", async () => {
    // Break caught: leaking dependency messages/stacks or treating dependency loss as invalid input.
    const authFailure = fixture({ authenticateError: new Error("private identity outage detail") });
    const authResponse = await authFailure.handlers.workspace(
      new Request(`${origin}/api/v1/creator-page`, { method: "GET" }),
    );
    expect(authResponse.status).toBe(503);
    expect(await json(authResponse)).toEqual({ code: "CATALOG_UNAVAILABLE" });

    const service = serviceFixture({
      saveDraft: vi.fn(async () => { throw new Error("postgres://secret@db/internal stack"); }),
    });
    const dependencyFailure = fixture({ service });
    const response = await dependencyFailure.handlers.saveDraft(mutationRequest());
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({ code: "CATALOG_UNAVAILABLE" });
    expect(JSON.stringify(dependencyFailure.events)).not.toContain("postgres");
    expect(JSON.stringify(dependencyFailure.events)).not.toContain("secret");
  });

  test("projects command results, logs, and headers without replay/session/private values", async () => {
    // Break caught: reflecting arbitrary service fields or command authority into HTTP/telemetry.
    const service = serviceFixture({
      saveDraft: vi.fn(async () => ({
        pageId, draftVersion: 4, idempotencyKey: "catalog-command-one",
        sessionId: "authoritative-session", privateNote: "secret note",
      })),
    });
    const { handlers, events } = fixture({ service });
    const response = await handlers.saveDraft(mutationRequest());
    const serializedBody = await response.clone().text();
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ result: { pageId, draftVersion: 4 } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const serialized = `${serializedBody}${JSON.stringify(events)}${JSON.stringify([...response.headers])}`;
    expect(serialized).not.toContain("catalog-command-one");
    expect(serialized).not.toContain("authoritative-session");
    expect(serialized).not.toContain("secret note");
  });
});
