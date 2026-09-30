import { beforeAll, describe, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createOidcProtocol, type OidcAuthorizationMaterial, type OidcProviderConfig } from "../src/oidc-protocol.js";

const provider: OidcProviderConfig = { issuer: "https://idp.example/application/o/pawket/", clientId: "pawket-test",
  clientSecret: "synthetic-client-secret-not-used-outside-tests", redirectUri: "https://pawket.example/api/v1/auth/oidc/callback",
  providerRevision: "pawket-v1", accountPortalUrl: "https://idp.example/if/user/" };
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let attacker: Awaited<ReturnType<typeof generateKeyPair>>;
let rs512: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: JWK;
beforeAll(async () => {
  key = await generateKeyPair("RS256"); attacker = await generateKeyPair("RS256"); rs512 = await generateKeyPair("RS512");
  jwk = { ...await exportJWK(key.publicKey), kid: "key-1", alg: "RS256", use: "sig" };
});

function harness(options: { token?: (material: OidcAuthorizationMaterial) => Promise<string>; metadata?: Record<string, unknown>;
  tokenError?: string; tokenFailure?: "network" | "timeout" | "unavailable" | "oversized";
  onExchangeFailure?: (diagnostic: { code: string; claim?: string; providerError?: string }) => void;
} = {}) {
  const requests: Array<{ url: string; body: string; redirect?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({ url, body: init?.body?.toString() ?? "", redirect: init?.redirect });
    if (url.endsWith("/token") && options.tokenFailure === "network") throw new TypeError("fetch failed");
    if (url.endsWith("/token") && options.tokenFailure === "timeout") throw new DOMException("The operation timed out", "TimeoutError");
    if (url.endsWith("/token") && options.tokenFailure === "unavailable") return new Response("bad gateway", { status: 502 });
    if (url.endsWith("/token") && options.tokenFailure === "oversized") return Response.json({ padding: "x".repeat(200_000) });
    if (url.includes(".well-known")) return Response.json({ issuer: provider.issuer,
      authorization_endpoint: "https://idp.example/authorize", token_endpoint: "https://idp.example/token",
      jwks_uri: "https://idp.example/jwks", response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"], ...options.metadata });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/token") && options.tokenError) return Response.json({ error: options.tokenError,
      error_description: "sensitive-provider-detail-must-not-leave-boundary" }, { status: 400 });
    if (url.endsWith("/token")) return Response.json({ access_token: "synthetic-ephemeral-token", token_type: "Bearer", expires_in: 300,
      id_token: await (options.token ?? ((m) => signId(m)))(material) });
    throw new Error("Unexpected endpoint");
  };
  const protocol = createOidcProtocol(provider, { fetch: fetcher, onExchangeFailure: options.onExchangeFailure });
  const material = protocol.newAuthorizationMaterial();
  const callback = new URL(provider.redirectUri); callback.searchParams.set("state", material.state); callback.searchParams.set("code", "synthetic-code");
  return { protocol, material, callback, requests };
}
async function signId(material: OidcAuthorizationMaterial, claims: Record<string, unknown> = {}, signingKey = key.privateKey, algorithm = "RS256") {
  const at = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: provider.issuer, aud: provider.clientId, sub: "subject-1", iat: at, exp: at + 60, nonce: material.nonce,
    auth_time: at, sid: "sid-1", ...claims }).setProtectedHeader({ alg: algorithm, kid: "key-1" }).sign(signingKey);
}
async function signLogout(claims: Record<string, unknown> = {}) {
  return new SignJWT({ iss: provider.issuer, aud: provider.clientId, iat: Math.floor(Date.now() / 1000), jti: "event-1", sid: "sid-1",
    events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" }).sign(key.privateKey);
}

describe("OIDC protocol boundary", () => {
  test("uses code + S256 + state + nonce with explicit least-privilege scopes", async () => {
    const h = harness(); const url = new URL(await h.protocol.authorizationUrl(h.material, "step_up"));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe(h.material.verifier);
    expect(url.searchParams.get("nonce")).toBe(h.material.nonce);
    expect(url.searchParams.get("state")).toBe(h.material.state);
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("scope")).toBe("openid email pawket_assurance");
    expect(new URL(await h.protocol.authorizationUrl(h.material, "lease_check")).searchParams.get("prompt")).toBe("none");
  });
  test("forces re-authentication with prompt=login plus a non-zero max_age only when fresh proof is needed", async () => {
    const h = harness();
    for (const purpose of ["step_up", "owner_link"] as const) {
      const params = new URL(await h.protocol.authorizationUrl(h.material, purpose)).searchParams;
      // authentik ignores max_age=0 and keeps prompt=login once per IdP session, so both are sent.
      expect(params.get("prompt")).toBe("login");
      expect(params.get("max_age")).toBe("10");
    }
    for (const purpose of ["login", "lease_check"] as const) {
      expect(new URL(await h.protocol.authorizationUrl(h.material, purpose)).searchParams.has("max_age")).toBe(false);
    }
  });
  test("verifies signed ID token, sends PKCE verifier only to token endpoint, returns no provider tokens", async () => {
    const h = harness(); const result = await h.protocol.exchange(h.callback, h.material);
    expect(result.sub).toBe("subject-1"); expect(result).not.toHaveProperty("access_token");
    expect(h.requests.some((r) => r.url.endsWith("/jwks"))).toBe(true);
    expect(new URLSearchParams(h.requests.find((r) => r.url.endsWith("/token"))!.body).get("code_verifier")).toBe(h.material.verifier);
    const tokenBody = new URLSearchParams(h.requests.find((r) => r.url.endsWith("/token"))!.body);
    expect(tokenBody.get("client_id")).toBe(provider.clientId);
    expect(tokenBody.get("client_secret")).toBe(provider.clientSecret);
    expect(h.requests.every((r) => r.redirect === "error")).toBe(true);
  });
  test("rejects a wrong signature even after successful HTTPS token exchange", async () => {
    const h = harness({ token: (m) => signId(m, {}, attacker.privateKey) });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("invalid_response");
  });
  test.each(["issuer", "audience", "nonce", "expiry", "algorithm", "future_iat"])("rejects invalid ID token %s", async (kind) => {
    const at = Math.floor(Date.now() / 1000);
    const changes = { issuer: { iss: "https://wrong.example/" }, audience: { aud: "other-project" }, nonce: { nonce: "wrong" }, expiry: { exp: at - 1 }, algorithm: {}, future_iat: { iat: at + 300 } }[kind]!;
    // A real RS512 key: signing RS512 with the RS256 key throws inside the fake token endpoint instead.
    const h = harness({ token: (m) => kind === "algorithm" ? signId(m, changes, rs512.privateKey, "RS512") : signId(m, changes) });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("invalid_response");
  });
  test("state mismatch stops before exchanging authorization code", async () => {
    const h = harness(); h.callback.searchParams.set("state", "wrong");
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("invalid_response");
    expect(h.requests.some((r) => r.url.endsWith("/token"))).toBe(false);
  });
  test("rejects callback origin substitution before any provider request", async () => {
    const h = harness(); const url = new URL(h.callback); url.hostname = "attacker.example";
    await expect(h.protocol.exchange(url, h.material)).rejects.toThrow("invalid_response");
    expect(h.requests).toHaveLength(0);
  });
  test("rejects metadata directing client secrets to another host", async () => {
    const h = harness({ metadata: { token_endpoint: "https://attacker.example/token" } });
    await expect(h.protocol.authorizationUrl(h.material, "login")).rejects.toThrow("provider_unavailable");
    expect(h.requests.every((r) => r.url.startsWith("https://idp.example/"))).toBe(true);
  });
  test("rejects a provider that does not advertise the selected client authentication method", async () => {
    const h = harness({ metadata: { token_endpoint_auth_methods_supported: ["client_secret_basic"] } });
    await expect(h.protocol.authorizationUrl(h.material, "login")).rejects.toThrow("provider_unavailable");
    expect(h.requests.every((r) => r.url.includes(".well-known"))).toBe(true);
  });
  test.each(["invalid_client", "sensitive-unrecognized-error"])("probe diagnostics allowlist provider error %s", async (tokenError) => {
    const diagnostics: unknown[] = [];
    const h = harness({ tokenError, onExchangeFailure: (diagnostic) => { diagnostics.push(diagnostic); } });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("invalid_response");
    expect(diagnostics).toEqual([{ code: "OAUTH_RESPONSE_BODY_ERROR",
      ...(tokenError === "invalid_client" ? { providerError: "invalid_client" } : {}) }]);
  });
  test.each(["network", "timeout", "unavailable"] as const)("a token endpoint that is down (%s) is reported as provider unavailable", async (tokenFailure) => {
    const h = harness({ tokenFailure });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("provider_unavailable");
  });
  test("an oversized token response stays a rejected login, not an outage", async () => {
    const h = harness({ tokenFailure: "oversized" });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("invalid_response");
  });
  test("a temporary IdP error from the token endpoint is reported as provider unavailable", async () => {
    const h = harness({ tokenError: "temporarily_unavailable" });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("provider_unavailable");
  });
  test.each([["login_required", "login_required"], ["interaction_required", "login_required"], ["access_denied", "invalid_response"]])(
    "IdP callback error %s becomes %s without a token request", async (idpError, code) => {
      const h = harness(); const callback = new URL(provider.redirectUri);
      callback.searchParams.set("state", h.material.state); callback.searchParams.set("error", idpError);
      await expect(h.protocol.exchange(callback, h.material)).rejects.toThrow(code);
      expect(h.requests.some((r) => r.url.endsWith("/token"))).toBe(false);
    });
  test("a failing diagnostic callback cannot change the authentication rejection", async () => {
    const h = harness({ tokenError: "invalid_client", onExchangeFailure: () => { throw new Error("probe failure"); } });
    await expect(h.protocol.exchange(h.callback, h.material)).rejects.toThrow("invalid_response");
  });
  test("accepts signed scoped logout with sid or sub", async () => {
    const h = harness(); expect(await h.protocol.verifyLogout(await signLogout(), new Date())).toMatchObject({ sid: "sid-1", jti: "event-1" });
    expect(await h.protocol.verifyLogout(await signLogout({ sid: undefined, sub: "subject-1" }), new Date())).toMatchObject({ subject: "subject-1" });
  });
  test.each(["nonce", "no_session", "wrong_event", "old", "future", "wrong_audience"])("rejects invalid logout: %s", async (kind) => {
    const at = Math.floor(Date.now() / 1000);
    const changes = { nonce: { nonce: "must-not-exist" }, no_session: { sid: undefined }, wrong_event: { events: {} },
      old: { iat: at - 301 }, future: { iat: at + 10 }, wrong_audience: { aud: "other-project" } }[kind]!;
    const h = harness(); await expect(h.protocol.verifyLogout(await signLogout(changes), new Date())).rejects.toThrow("invalid_response");
  });
});
