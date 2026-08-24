import { describe, expect, test } from "vitest";

import {
  parseRequiredJsonResponse,
  requireTotpVerificationUserId,
} from "../../src/better-auth-boundary.js";

describe("TOTP enrollment response invariants", () => {
  test("rejects a successful verification payload without its authenticated user", () => {
    expect(() => requireTotpVerificationUserId({ status: true })).toThrow(
      "invalid user",
    );
    expect(() => requireTotpVerificationUserId({ user: { id: "" } })).toThrow(
      "invalid user",
    );
    expect(() =>
      requireTotpVerificationUserId(
        { user: { id: "other-user" } },
        "enrolling-user",
      ),
    ).toThrow("invalid user");
    expect(requireTotpVerificationUserId({ user: { id: "verified-user" } })).toBe(
      "verified-user",
    );
  });

  test("rejects malformed recovery-code responses instead of silently losing the codes", async () => {
    await expect(
      parseRequiredJsonResponse(
        new Response("<html>upstream failure</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).rejects.toThrow("Expected a JSON authentication response");
    await expect(
      parseRequiredJsonResponse(Response.json([])),
    ).rejects.toThrow("Expected an authentication response object");
  });
});
