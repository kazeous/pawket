import { describe, expect, test } from "vitest";
import { oidcNotice } from "../src/auth/oidc-notice.js";

describe("sign-in notices", () => {
  test("an account-system outage asks to retry later, an ended IdP session asks to sign in again", () => {
    expect(oidcNotice("provider_unavailable")).toContain("Hãy thử lại sau");
    expect(oidcNotice("login_required")).toContain("Hãy đăng nhập lại");
    expect(oidcNotice("login_required")).not.toBe(oidcNotice("invalid_response"));
  });
  test("unknown codes fall back to the generic message and no code shows nothing", () => {
    expect(oidcNotice("anything-else")).toBe(oidcNotice("invalid_response"));
    expect(oidcNotice(undefined)).toBeNull();
  });
});
