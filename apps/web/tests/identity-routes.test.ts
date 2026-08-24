import { afterEach, describe, expect, test, vi } from "vitest";

const identityRuntime = vi.hoisted(() => ({
  authHandler: vi.fn(async () => new Response("auth", { status: 200 })),
  register: vi.fn(async () => Response.json({ accepted: true }, { status: 202 })),
  sessions: vi.fn(async () => Response.json({ sessions: [] })),
  session: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock("../src/auth/runtime", () => ({
  getIdentityRuntime: () => ({
    auth: { handler: identityRuntime.authHandler },
    handlers: {
      register: identityRuntime.register,
      sessions: identityRuntime.sessions,
      session: identityRuntime.session,
    },
  }),
}));

describe("identity route wiring", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  test("mounts Better Auth at the catch-all protocol boundary", async () => {
    const { POST } = await import("../src/app/api/auth/[...all]/route.js");
    const request = new Request("https://pawket.example/api/auth/sign-in/email", {
      method: "POST",
    });
    const response = await POST(request);
    expect(await response.text()).toBe("auth");
    expect(identityRuntime.authHandler).toHaveBeenCalledWith(request);
  });

  test("mounts the Pawket registration handler under the versioned API", async () => {
    const { POST } = await import("../src/app/api/v1/auth/register/route.js");
    const request = new Request("https://pawket.example/api/v1/auth/register", {
      method: "POST",
    });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(identityRuntime.register).toHaveBeenCalledWith(request);
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
  });
});
