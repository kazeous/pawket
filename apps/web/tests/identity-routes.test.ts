import { afterEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";

type AuthOperationTelemetry = {
  operation: "oauth_callback" | "security_change";
  outcome: "succeeded" | "rejected" | "retryable_failure";
};

const authTelemetry = vi.hoisted(() => ({
  byRequest: new WeakMap<Request, AuthOperationTelemetry>(),
}));

const identityRuntime = vi.hoisted(() => ({
  authHandler: vi.fn(async (request: Request) => {
    void request;
    return new Response("auth", { status: 200 });
  }),
  consumeOperationTelemetry: vi.fn((request: Request) => {
    const result = authTelemetry.byRequest.get(request) ?? null;
    authTelemetry.byRequest.delete(request);
    return result;
  }),
  register: vi.fn(async () => Response.json({ accepted: true }, { status: 202 })),
  sessions: vi.fn(async () => Response.json({ sessions: [] })),
  session: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock("../src/auth/runtime", () => ({
  getIdentityRuntime: () => ({
    auth: {
      handler: identityRuntime.authHandler,
      consumeOperationTelemetry: identityRuntime.consumeOperationTelemetry,
    },
    handlers: {
      register: identityRuntime.register,
      sessions: identityRuntime.sessions,
      session: identityRuntime.session,
    },
  }),
}));

describe("identity route wiring", () => {
  afterEach(() => {
    authTelemetry.byRequest = new WeakMap<Request, AuthOperationTelemetry>();
    metricsRegistry.resetMetrics();
    vi.clearAllMocks();
  });

  test("mounts Better Auth at the catch-all protocol boundary", async () => {
    const { POST } = await import("../src/app/api/auth/[...all]/route.js");
    const request = new Request("https://pawket.example/api/auth/sign-in/email", {
      method: "POST",
    });
    const response = await POST(request);
    expect(await response.text()).toBe("auth");
    expect(identityRuntime.authHandler).toHaveBeenCalledWith(request);
    expect(await metricsRegistry.metrics()).toContain(
      'pawket_auth_operations_total{operation="login",outcome="succeeded"} 1',
    );
  });

  test("mounts the Pawket registration handler under the versioned API", async () => {
    const { POST } = await import("../src/app/api/v1/auth/register/route.js");
    const request = new Request("https://pawket.example/api/v1/auth/register", {
      method: "POST",
    });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(identityRuntime.register).toHaveBeenCalledWith(request);
    expect(await metricsRegistry.metrics()).toContain(
      'pawket_auth_operations_total{operation="registration",outcome="succeeded"} 1',
    );
  });

  test("passes only the decoded route session id to the ownership-checked handler", async () => {
    const { DELETE } = await import("../src/app/api/v1/me/sessions/[sessionId]/route.js");
    const request = new Request("https://pawket.example/api/v1/me/sessions/session-safe", {
      method: "DELETE",
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ sessionId: "session-safe" }),
    });
    expect(response.status).toBe(204);
    expect(identityRuntime.session).toHaveBeenCalledWith(request, "session-safe");
    expect(await metricsRegistry.metrics()).toContain(
      'pawket_auth_operations_total{operation="session",outcome="succeeded"} 1',
    );
  });

  test("does not guess a business operation for an unknown auth protocol path", async () => {
    const { POST } = await import("../src/app/api/auth/[...all]/route.js");
    await POST(new Request("https://pawket.example/api/auth/future-provider-command", {
      method: "POST",
    }));

    expect(await metricsRegistry.metrics()).not.toContain("pawket_auth_operations_total{");
  });

  test.each([
    ["/api/auth/link-social", "security_change"],
    ["/api/auth/unlink-account", "security_change"],
    ["/api/auth/sign-in/social", "login"],
    ["/api/auth/get-session", "session"],
    ["/api/auth/list-accounts", "session"],
    ["/api/auth/two-factor/verify-totp", "mfa"],
  ] as const)("maps the exact enabled auth path %s to %s", async (path, operation) => {
    // Catches enabled security/session routes being unclassified by partial path lists.
    const { POST } = await import("../src/app/api/auth/[...all]/route.js");
    await POST(new Request(`https://pawket.example${path}`, { method: "POST" }));

    expect(await metricsRegistry.metrics()).toContain(
      `pawket_auth_operations_total{operation="${operation}",outcome="succeeded"} 1`,
    );
  });

  test.each([
    "/api/auth/not-sign-in",
    "/api/auth/sign-in/email-extra",
    "/api/auth/two-factorish",
  ])("does not classify the unknown substring path %s", async (path) => {
    // Catches substring matching turning unknown endpoints into business operations.
    const { POST } = await import("../src/app/api/auth/[...all]/route.js");
    await POST(new Request(`https://pawket.example${path}`, { method: "POST" }));

    expect(await metricsRegistry.metrics()).not.toContain("pawket_auth_operations_total{");
  });

  test.each([
    ["rejected", "https://pawket.example/sign-in?error=account_not_linked"],
    ["succeeded", "https://pawket.example/settings/security"],
  ] as const)(
    "uses the process-local %s OAuth callback result for a redirect response",
    async (outcome, location) => {
      // Catches all OAuth 302 responses being counted as success from status alone.
      identityRuntime.authHandler.mockImplementationOnce(async (request) => {
        authTelemetry.byRequest.set(request, { operation: "oauth_callback", outcome });
        return Response.redirect(location, 302);
      });
      const { GET } = await import("../src/app/api/auth/[...all]/route.js");
      const response = await GET(
        new Request("https://pawket.example/api/auth/callback/discord?code=fixture"),
      );

      expect(response.status).toBe(302);
      expect(await metricsRegistry.metrics()).toContain(
        `pawket_auth_operations_total{operation="oauth_callback",outcome="${outcome}"} 1`,
      );
    },
  );

  test("classifies a completed external-link callback as a security change", async () => {
    // Catches an authenticated link callback being mislabeled as a primary OAuth login.
    identityRuntime.authHandler.mockImplementationOnce(async (request) => {
      authTelemetry.byRequest.set(request, {
        operation: "security_change",
        outcome: "succeeded",
      });
      return Response.redirect("https://pawket.example/settings/security", 302);
    });
    const { GET } = await import("../src/app/api/auth/[...all]/route.js");
    await GET(new Request("https://pawket.example/api/auth/callback/google?code=linked"));

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain(
      'pawket_auth_operations_total{operation="security_change",outcome="succeeded"} 1',
    );
    expect(metrics).not.toContain('operation="oauth_callback"');
  });

  test("fails closed when a callback has only caller headers and no process-local result", async () => {
    // Catches a caller-spoofable header or redirect status becoming callback outcome authority.
    identityRuntime.authHandler.mockResolvedValueOnce(
      Response.redirect("https://pawket.example/settings/security", 302),
    );
    const { GET } = await import("../src/app/api/auth/[...all]/route.js");
    await GET(
      new Request("https://pawket.example/api/auth/callback/google?code=unknown", {
        headers: {
          "x-pawket-auth-operation": "oauth_callback",
          "x-pawket-auth-outcome": "succeeded",
        },
      }),
    );

    expect(await metricsRegistry.metrics()).not.toContain("pawket_auth_operations_total{");
  });
});
