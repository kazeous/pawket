import { describe, expect, test, vi } from "vitest";

import * as identity from "../src/index.js";

type SessionContext = {
  userId: string;
  sessionId: string;
  primaryAuthenticatedAt: Date;
};

type HttpHandlers = {
  register(request: Request): Promise<Response>;
  requestPasswordReset(request: Request): Promise<Response>;
  resetPassword(request: Request): Promise<Response>;
  requestEmailChange(request: Request): Promise<Response>;
  me(request: Request): Promise<Response>;
  sessions(request: Request): Promise<Response>;
  session(request: Request, sessionId: string): Promise<Response>;
};

type HttpFactory = {
  createIdentityHttpHandlers(options: {
    trustedOrigins: readonly string[];
    emailDeliveryAvailable: boolean;
    sessionCookie?: { name: string; secure: boolean };
    service: {
      registerPassword(input: unknown): Promise<{ accepted: true }>;
      resendEmailVerification(input: unknown): Promise<{ accepted: true }>;
      verifyEmail(input: unknown): Promise<{ verified: boolean }>;
      requestPasswordReset(input: unknown): Promise<{ accepted: true }>;
      resetPassword(input: unknown): Promise<{ completed: boolean }>;
      changePassword(input: unknown): Promise<{ changed: boolean }>;
      requestEmailChange(input: unknown): Promise<{ accepted: boolean }>;
      completeEmailChange(input: unknown): Promise<{ completed: boolean }>;
    };
    authenticate(headers: Headers): Promise<SessionContext | null>;
    getMe(userId: string): Promise<Record<string, unknown> | null>;
    listSessions(userId: string, now: Date): Promise<unknown[]>;
    revokeSession(input: {
      userId: string;
      sessionId: string;
      reason: string;
      now: Date;
    }): Promise<boolean>;
    revokeAllSessions(input: {
      userId: string;
      reason: string;
      now: Date;
    }): Promise<number>;
    throttle?(input: {
      action: string;
      accountSubject: string;
      request: Request;
    }): Promise<{ allowed: boolean }>;
    now(): Date;
  }): HttpHandlers;
};

const httpExports = identity as unknown as Partial<HttpFactory>;
const origin = "https://pawket.example";

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${origin}${path}`, init);
}

function post(path: string, body: unknown, requestOrigin: string | null = origin): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (requestOrigin) headers.set("origin", requestOrigin);
  return request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function createHarness(emailDeliveryAvailable = true, throttleAllowed = true) {
  const service = {
    registerPassword: vi.fn(async () => ({ accepted: true as const })),
    resendEmailVerification: vi.fn(async () => ({ accepted: true as const })),
    verifyEmail: vi.fn(async () => ({ verified: true })),
    requestPasswordReset: vi.fn(async () => ({ accepted: true as const })),
    resetPassword: vi.fn(async () => ({ completed: true })),
    changePassword: vi.fn(async () => ({ changed: true })),
    requestEmailChange: vi.fn(async () => ({ accepted: true })),
    completeEmailChange: vi.fn(async () => ({ completed: true })),
  };
  const authenticate = vi.fn<(headers: Headers) => Promise<SessionContext | null>>(async () => ({
    userId: "user-1",
    sessionId: "session-current",
    primaryAuthenticatedAt: new Date("2026-08-24T03:00:00.000Z"),
  }));
  const getMe = vi.fn(async () => ({
    id: "user-1",
    displayName: "Artist",
    emailVerified: true,
    accessStatus: "active",
  }));
  const listSessions = vi.fn(async () => [
    {
      id: "session-current",
      deviceLabel: "Chrome",
      createdAt: new Date("2026-08-24T02:00:00.000Z"),
      lastUsedAt: new Date("2026-08-24T03:00:00.000Z"),
    },
  ]);
  const revokeSession = vi.fn(async () => true);
  const revokeAllSessions = vi.fn(async () => 2);
  const throttle = vi.fn(async () => ({ allowed: throttleAllowed }));
  expect(typeof httpExports.createIdentityHttpHandlers).toBe("function");
  const handlers = httpExports.createIdentityHttpHandlers!({
    trustedOrigins: [origin],
    emailDeliveryAvailable,
    service,
    authenticate,
    getMe,
    listSessions,
    revokeSession,
    revokeAllSessions,
    throttle,
    now: () => new Date("2026-08-24T03:00:00.000Z"),
  });
  return {
    handlers,
    service,
    authenticate,
    getMe,
    listSessions,
    revokeSession,
    revokeAllSessions,
    throttle,
  };
}

describe("identity HTTP v1 handlers", () => {
  test("rejects missing/foreign mutation origins before parsing or calling services", async () => {
    const harness = createHarness();
    for (const requestOrigin of [null, "https://evil.example"]) {
      const response = await harness.handlers.register(
        post(
          "/api/v1/auth/register",
          { name: "Artist", email: "artist@example.com", password: "long password value" },
          requestOrigin,
        ),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(harness.service.registerPassword).not.toHaveBeenCalled();
  });

  test("rejects malformed registration identity fields at the HTTP boundary", async () => {
    const harness = createHarness();
    for (const body of [
      { name: "   ", email: "artist@example.com", password: "long password value" },
      { name: "Artist", email: "not-an-email", password: "long password value" },
    ]) {
      const response = await harness.handlers.register(
        post("/api/v1/auth/register", body),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    }
    expect(harness.service.registerPassword).not.toHaveBeenCalled();
  });

  test("fails closed when essential security email delivery is unavailable", async () => {
    const harness = createHarness(false);
    const registration = await harness.handlers.register(
      post("/api/v1/auth/register", {
        name: "Artist",
        email: "artist@example.com",
        password: "long password value",
      }),
    );
    const recovery = await harness.handlers.requestPasswordReset(
      post("/api/v1/auth/password-reset/request", { email: "artist@example.com" }),
    );
    expect(registration.status).toBe(503);
    expect(recovery.status).toBe(503);
    expect(await registration.json()).toEqual(await recovery.json());
    expect(harness.service.registerPassword).not.toHaveBeenCalled();
    expect(harness.service.requestPasswordReset).not.toHaveBeenCalled();
  });

  test("returns accepted recovery responses without reflecting account data or tokens", async () => {
    const harness = createHarness();
    const response = await harness.handlers.requestPasswordReset(
      post("/api/v1/auth/password-reset/request", { email: "artist@example.com" }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("returns a fixed 429 before issuing email when the authoritative throttle blocks", async () => {
    const harness = createHarness(true, false);
    const response = await harness.handlers.requestPasswordReset(
      post("/api/v1/auth/password-reset/request", { email: "artist@example.com" }),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: "RATE_LIMITED" });
    expect(harness.service.requestPasswordReset).not.toHaveBeenCalled();
    expect(harness.throttle).toHaveBeenCalledWith({
      action: "password_reset_request",
      accountSubject: "artist@example.com",
      request: expect.any(Request),
    });
  });

  test("lists and revokes sessions only through authenticated safe ids", async () => {
    const harness = createHarness();
    const listed = await harness.handlers.sessions(
      request("/api/v1/me/sessions", { headers: { cookie: "opaque-cookie" } }),
    );
    const payload = await listed.json();
    expect(listed.status).toBe(200);
    expect(payload).toEqual({
      sessions: [
        {
          id: "session-current",
          deviceLabel: "Chrome",
          createdAt: "2026-08-24T02:00:00.000Z",
          lastUsedAt: "2026-08-24T03:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toMatch(/token|hash|cookie/iu);

    const revoked = await harness.handlers.session(
      request("/api/v1/me/sessions/session-other", {
        method: "DELETE",
        headers: { origin, cookie: "opaque-cookie" },
      }),
      "session-other",
    );
    expect(revoked.status).toBe(204);
    expect(harness.revokeSession).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "session-other",
      reason: "user_requested",
      now: new Date("2026-08-24T03:00:00.000Z"),
    });
  });

  test("returns 401 for protected routes without an authoritative session", async () => {
    const harness = createHarness();
    harness.authenticate.mockResolvedValueOnce(null);
    const response = await harness.handlers.me(request("/api/v1/me"));
    expect(response.status).toBe(401);
    expect(harness.getMe).not.toHaveBeenCalled();
  });

  test("rejects a malformed new email before calling the authenticated service", async () => {
    const harness = createHarness();
    const response = await harness.handlers.requestEmailChange(
      post("/api/v1/me/email-change/request", { newEmail: "not-an-email" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(harness.service.requestEmailChange).not.toHaveBeenCalled();
  });

  test("fails closed and redacts infrastructure errors from public responses", async () => {
    const databaseSecret = "postgresql://pawket:do-not-leak@db.internal/pawket";
    const authHarness = createHarness();
    authHarness.authenticate.mockRejectedValueOnce(new Error(databaseSecret));
    const protectedResponse = await authHarness.handlers.me(request("/api/v1/me"));

    expect(protectedResponse.status).toBe(503);
    expect(await protectedResponse.json()).toEqual({ code: "IDENTITY_UNAVAILABLE" });

    const serviceHarness = createHarness();
    serviceHarness.service.requestPasswordReset.mockRejectedValueOnce(
      new Error(`database unavailable; token=raw-reset-secret; ${databaseSecret}`),
    );
    const publicResponse = await serviceHarness.handlers.requestPasswordReset(
      post("/api/v1/auth/password-reset/request", { email: "artist@example.com" }),
    );
    const publicBody = await publicResponse.text();

    expect(publicResponse.status).toBe(503);
    expect(publicBody).toBe('{"code":"IDENTITY_UNAVAILABLE"}');
    expect(publicBody).not.toMatch(/do-not-leak|raw-reset-secret|postgresql/iu);
  });

  test("clears the configured local cookie when the current session is revoked", async () => {
    const harness = createHarness();
    expect(typeof httpExports.createIdentityHttpHandlers).toBe("function");
    const localHandlers = httpExports.createIdentityHttpHandlers!({
      trustedOrigins: [origin],
      emailDeliveryAvailable: true,
      sessionCookie: { name: "pawket.session", secure: false },
      service: harness.service,
      authenticate: harness.authenticate,
      getMe: harness.getMe,
      listSessions: harness.listSessions,
      revokeSession: harness.revokeSession,
      revokeAllSessions: harness.revokeAllSessions,
      throttle: harness.throttle,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const response = await localHandlers.session(
      request("/api/v1/me/sessions/session-current", {
        method: "DELETE",
        headers: { origin, cookie: "pawket.session=opaque" },
      }),
      "session-current",
    );
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(204);
    expect(setCookie).toContain("pawket.session=");
    expect(setCookie).not.toMatch(/;\s*Secure/iu);
  });
});
