import { describe, expect, test, vi } from "vitest";

import * as identity from "../src/index.js";

type CoreIdentityPolicy = {
  canonicalizeEmailAddress(email: string): {
    display: string;
    canonical: string;
  };
  evaluatePassword(input: {
    password: string;
    contextTerms?: readonly string[];
    compromisedPasswordChecker: {
      isCompromised(password: string): Promise<boolean>;
    };
  }): Promise<{ accepted: boolean; reason?: string }>;
  resolveSessionPolicy(input: {
    kind: "user" | "owner" | "provisional" | "mfa_pending";
    now: Date;
  }): {
    absoluteExpiresAt: Date;
    idleExpiresAt: Date;
  };
  productionSessionCookie: Readonly<{
    name: string;
    secure: true;
    httpOnly: true;
    sameSite: "lax";
    path: "/";
  }>;
  resolveSessionCookie(baseURL: string): Readonly<{
    name: string;
    secure: boolean;
    httpOnly: true;
    sameSite: "lax";
    path: "/";
  }>;
  isAllowedReturnPath(path: string): boolean;
  isTrustedMutationOrigin(input: {
    origin: string | null;
    trustedOrigins: readonly string[];
  }): boolean;
};

const policy = identity as unknown as Partial<CoreIdentityPolicy>;

describe("core identity policy", () => {
  test("canonicalizes only case/domain comparison rules and preserves display form", () => {
    expect(typeof policy.canonicalizeEmailAddress).toBe("function");
    expect(policy.canonicalizeEmailAddress?.("  Artist.Name+Shop@EXAMPLE.COM  ")).toEqual({
      display: "Artist.Name+Shop@example.com",
      canonical: "artist.name+shop@example.com",
    });
    expect(policy.canonicalizeEmailAddress?.("artist.name+shop@example.com")).toEqual({
      display: "artist.name+shop@example.com",
      canonical: "artist.name+shop@example.com",
    });
    expect(() => policy.canonicalizeEmailAddress?.("not-an-email")).toThrow(
      "Invalid email address",
    );
  });

  test("accepts long Unicode passwords and rejects common, contextual, or compromised values", async () => {
    expect(typeof policy.evaluatePassword).toBe("function");
    const checker = { isCompromised: vi.fn(async () => false) };

    await expect(
      policy.evaluatePassword?.({
        password: "mật khẩu dài 🔐 có khoảng trắng",
        contextTerms: ["pawket", "artist@example.com"],
        compromisedPasswordChecker: checker,
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      policy.evaluatePassword?.({
        password: "passwordpassword",
        compromisedPasswordChecker: checker,
      }),
    ).resolves.toEqual({ accepted: false, reason: "common" });
    await expect(
      policy.evaluatePassword?.({
        password: "my pawket account password",
        contextTerms: ["Pawket"],
        compromisedPasswordChecker: checker,
      }),
    ).resolves.toEqual({ accepted: false, reason: "context" });

    checker.isCompromised.mockResolvedValueOnce(true);
    await expect(
      policy.evaluatePassword?.({
        password: "this is otherwise unique",
        compromisedPasswordChecker: checker,
      }),
    ).resolves.toEqual({ accepted: false, reason: "compromised" });
  });

  test("uses authoritative session lifetimes and a host-only production cookie", () => {
    expect(typeof policy.resolveSessionPolicy).toBe("function");
    const now = new Date("2026-08-24T00:00:00.000Z");
    expect(policy.resolveSessionPolicy?.({ kind: "user", now })).toEqual({
      absoluteExpiresAt: new Date("2026-09-23T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-31T00:00:00.000Z"),
    });
    expect(policy.resolveSessionPolicy?.({ kind: "owner", now })).toEqual({
      absoluteExpiresAt: new Date("2026-08-24T12:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-24T00:30:00.000Z"),
    });
    expect(policy.resolveSessionPolicy?.({ kind: "provisional", now })).toEqual({
      absoluteExpiresAt: new Date("2026-08-24T00:10:00.000Z"),
      idleExpiresAt: new Date("2026-08-24T00:10:00.000Z"),
    });
    expect(policy.productionSessionCookie).toEqual({
      name: "__Host-pawket.session",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(policy.productionSessionCookie).not.toHaveProperty("domain");
    expect(policy.resolveSessionCookie?.("https://pawket.example")).toEqual(
      policy.productionSessionCookie,
    );
    expect(policy.resolveSessionCookie?.("http://localhost:3000")).toEqual({
      name: "pawket.session",
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  test("permits only local Pawket return paths and exact trusted mutation origins", () => {
    expect(typeof policy.isAllowedReturnPath).toBe("function");
    expect(policy.isAllowedReturnPath?.("/settings/security")).toBe(true);
    expect(policy.isAllowedReturnPath?.("//evil.example/path")).toBe(false);
    expect(policy.isAllowedReturnPath?.("https://evil.example/path")).toBe(false);
    expect(policy.isAllowedReturnPath?.("/api/auth/callback?token=secret")).toBe(false);

    expect(typeof policy.isTrustedMutationOrigin).toBe("function");
    expect(
      policy.isTrustedMutationOrigin?.({
        origin: "https://pawket.example",
        trustedOrigins: ["https://pawket.example"],
      }),
    ).toBe(true);
    expect(
      policy.isTrustedMutationOrigin?.({
        origin: "https://pawket.example.evil.test",
        trustedOrigins: ["https://pawket.example"],
      }),
    ).toBe(false);
    expect(
      policy.isTrustedMutationOrigin?.({
        origin: null,
        trustedOrigins: ["https://pawket.example"],
      }),
    ).toBe(false);
  });
});
