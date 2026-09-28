import { describe, expect, test } from "vitest";
import { parseOidcEnv, parseOidcSessionEnv } from "../src/oidc.js";

const env = { OIDC_ISSUER: "https://idp.example/application/o/pawket/", OIDC_CLIENT_ID: "pawket-production",
  OIDC_CLIENT_SECRET: "synthetic-secret-only-".repeat(3), OIDC_PROVIDER_REVISION: "pawket-v1",
  OIDC_ACCOUNT_PORTAL_URL: "https://idp.example/if/user/" };
describe("OIDC environment", () => {
  test("worker validates the public trust boundary without a confidential secret", () => {
    const publicEnv = { OIDC_ISSUER: env.OIDC_ISSUER, OIDC_CLIENT_ID: env.OIDC_CLIENT_ID, OIDC_PROVIDER_REVISION: env.OIDC_PROVIDER_REVISION };
    expect(parseOidcSessionEnv(publicEnv)).toEqual({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, providerRevision: env.OIDC_PROVIDER_REVISION });
    for (const key of Object.keys(publicEnv)) expect(() => parseOidcSessionEnv({ ...publicEnv, [key]: undefined })).toThrow(key);
    expect(() => parseOidcSessionEnv({ ...publicEnv, OIDC_ISSUER: "http://idp.example/" })).toThrow("Invalid OIDC issuer");
  });
  test("derives an exact callback and preserves the issuer", () => {
    expect(parseOidcEnv(env, "https://pawket.example")).toMatchObject({ issuer: env.OIDC_ISSUER,
      redirectUri: "https://pawket.example/api/v1/auth/oidc/callback" });
  });
  test("requires the whole configuration without reporting secret values", () => {
    for (const key of Object.keys(env)) {
      expect(() => parseOidcEnv({ ...env, [key]: undefined }, "https://pawket.example")).toThrow(key);
    }
    expect(() => parseOidcEnv({ ...env, OIDC_CLIENT_SECRET: "private secret with spaces" }, "https://pawket.example")).toThrow(/^Invalid OIDC configuration: OIDC_CLIENT_SECRET$/);
  });
  test("rejects mixed providers, credentials, URL query and insecure remote endpoints", () => {
    for (const issuer of ["http://idp.example/", "https://user:password@idp.example/", "https://idp.example/?key=private", "https://idp.example/#fragment"]) {
      expect(() => parseOidcEnv({ ...env, OIDC_ISSUER: issuer }, "https://pawket.example")).toThrow();
    }
    expect(() => parseOidcEnv({ ...env, OIDC_ACCOUNT_PORTAL_URL: "https://different.example/" }, "https://pawket.example")).toThrow();
    expect(() => parseOidcEnv(env, "http://remote.example")).toThrow();
    expect(() => parseOidcEnv(env, "https://pawket.example/path")).toThrow();
    expect(parseOidcEnv(env, "http://127.0.0.1:3000").redirectUri).toBe("http://127.0.0.1:3000/api/v1/auth/oidc/callback");
  });
});
