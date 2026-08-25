import { describe, expect, test, vi } from "vitest";

import {
  authenticatedEntryRedirect,
  homeAccountAction,
  resolvePublicSession,
} from "../src/auth/public-session.js";

describe("public session navigation", () => {
  test("shows an account action and redirects auth entry pages for a valid session", async () => {
    const authenticate = vi.fn(async () => ({ userId: "opaque-user" }));
    const state = await resolvePublicSession(authenticate, new Headers({ cookie: "opaque" }));

    expect(state).toBe("authenticated");
    expect(homeAccountAction(state)).toEqual({ href: "/settings/security", label: "Tài khoản" });
    expect(authenticatedEntryRedirect(state)).toBe("/settings/security");
  });

  test("keeps public entry pages available without a valid identity dependency", async () => {
    for (const authenticate of [
      vi.fn(async () => null),
      vi.fn(async () => { throw new Error("database details must stay private"); }),
    ]) {
      const state = await resolvePublicSession(authenticate, new Headers());
      expect(state).toBe("anonymous");
      expect(homeAccountAction(state)).toEqual({ href: "/sign-in", label: "Đăng nhập" });
      expect(authenticatedEntryRedirect(state)).toBeNull();
    }
  });
});
