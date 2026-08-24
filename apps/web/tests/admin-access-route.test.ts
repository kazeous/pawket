import { beforeEach, describe, expect, test, vi } from "vitest";

const runtime = {
  authorizeOwner: vi.fn<() => Promise<"authorized" | "forbidden" | "unauthenticated">>(),
};

vi.mock("../src/auth/runtime", () => ({
  getIdentityRuntime: () => runtime,
}));

describe("owner-only admin access route", () => {
  beforeEach(() => {
    runtime.authorizeOwner.mockReset();
  });

  test.each([
    ["authorized", 204, null],
    ["unauthenticated", 401, "AUTHENTICATION_REQUIRED"],
    ["forbidden", 403, "OWNER_REQUIRED"],
  ] as const)("maps %s authorization without exposing private data", async (decision, status, code) => {
    runtime.authorizeOwner.mockResolvedValue(decision);
    const { GET } = await import("../src/app/api/v1/admin/access/route.js");
    const response = await GET(new Request("https://pawket.example/api/v1/admin/access"));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (code) {
      await expect(response.json()).resolves.toEqual({ code });
    } else {
      expect(await response.text()).toBe("");
    }
  });

  test("fails closed when authoritative permission is unavailable", async () => {
    runtime.authorizeOwner.mockRejectedValue(new Error("database unavailable"));
    const { GET } = await import("../src/app/api/v1/admin/access/route.js");
    const response = await GET(new Request("https://pawket.example/api/v1/admin/access"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "AUTHORIZATION_UNAVAILABLE" });
  });
});
