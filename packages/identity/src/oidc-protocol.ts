import * as oidc from "openid-client";
import { createRemoteJWKSet, customFetch as joseFetch, jwtVerify } from "jose";
import { OidcIdentityError } from "./oidc-policy.js";

export type OidcProviderConfig = Readonly<{
  issuer: string; clientId: string; clientSecret: string; redirectUri: string;
  providerRevision: string; accountPortalUrl: string;
}>;
export type OidcAuthorizationMaterial = Readonly<{ state: string; nonce: string; verifier: string }>;
export type OidcLogout = Readonly<{ jti: string; issuedAt: Date; sid?: string; subject?: string }>;
const logoutEvent = "http://schemas.openid.net/event/backchannel-logout";
const maxResponseBytes = 128 * 1024;
// authentik honours prompt=login only once per IdP session: the login uid it stores to
// detect the re-login is never cleared. max_age makes it re-prompt whenever the session's
// login is older than this, which also covers later step-ups. Freshness is still enforced
// by assertOidcStepUp, never by this value.
const reauthenticationMaxAgeSeconds = 10;
/** A provider request that got no HTTP response, so an IdP outage is not reported as a bad login. */
class OidcTransportError extends Error {}
const idpSessionEndedErrors = new Set(["login_required", "interaction_required", "consent_required", "account_selection_required"]);
const idpTemporaryErrors = new Set(["server_error", "temporarily_unavailable"]);

/** Every case still rejects the login; this only picks the label the user sees. */
function exchangeFailureCode(error: unknown): "provider_unavailable" | "login_required" | "invalid_response" {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof OidcTransportError) return "provider_unavailable";
  }
  const e = error as { code?: string; error?: string; cause?: unknown };
  if (e?.code === "OAUTH_TIMEOUT" || e?.code === "OAUTH_ABORT" || idpTemporaryErrors.has(e?.error ?? "") ||
    (e?.code === "OAUTH_RESPONSE_IS_NOT_CONFORM" && e.cause instanceof Response && e.cause.status >= 500)) return "provider_unavailable";
  if (e?.code === "OAUTH_AUTHORIZATION_RESPONSE_ERROR" && idpSessionEndedErrors.has(e.error ?? "")) return "login_required";
  return "invalid_response";
}

function validateUrl(value: string, allowLoopback = false): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search ||
    (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid OIDC endpoint configuration");
  }
  return url;
}

export function validateOidcProviderConfig(config: OidcProviderConfig): void {
  const issuer = validateUrl(config.issuer);
  const portal = validateUrl(config.accountPortalUrl);
  validateUrl(config.redirectUri, true);
  if (portal.origin !== issuer.origin || !config.clientId || config.clientId.length > 255 ||
    config.clientSecret.length < 32 || config.clientSecret.length > 2048 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(config.providerRevision)) {
    throw new Error("Invalid OIDC provider configuration");
  }
}

/** A dependency injection seam for tests, never controlled by a production env flag. */
export function createOidcProtocol(config: OidcProviderConfig, dependencies: {
  fetch?: typeof fetch;
  /** Probe-only bounded diagnostics. Never exposes exception messages, tokens or claim values. */
  onExchangeFailure?: (diagnostic: { code: string; claim?: string; providerError?: string }) => void;
} = {}) {
  validateOidcProviderConfig(config);
  const allowedOrigin = new URL(config.issuer).origin;
  const fetcher = dependencies.fetch ?? fetch;
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== allowedOrigin || url.username || url.password || url.protocol !== "https:") {
      throw new Error("OIDC endpoint origin mismatch");
    }
    const transport = (cause: unknown) => new OidcTransportError("OIDC provider unreachable", { cause });
    const response = await fetcher(input, { ...init, redirect: "error" }).catch((cause: unknown) => { throw transport(cause); });
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read().catch((cause: unknown) => { throw transport(cause); });
        if (part.done) break;
        length += part.value.length;
        if (length > maxResponseBytes) throw new Error("OIDC response too large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  let configuration: Promise<oidc.Configuration> | undefined;
  let logoutKeys: ReturnType<typeof createRemoteJWKSet> | undefined;
  async function discover(): Promise<oidc.Configuration> {
    if (!configuration) {
      configuration = oidc.discovery(new URL(config.issuer), config.clientId,
        { client_secret: config.clientSecret, id_token_signed_response_alg: "RS256", [oidc.clockTolerance]: 0 },
        // authentik 2025.10 does not form-decode HTTP Basic credentials. Use its
        // advertised POST method so client IDs/secrets retain their exact bytes.
        oidc.ClientSecretPost(config.clientSecret),
        { execute: [oidc.enableNonRepudiationChecks], [oidc.customFetch]: (url, init) => guardedFetch(url, {
          ...init, body: init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body,
        }), timeout: 5 })
        .then((result) => {
          const metadata = result.serverMetadata();
          if (metadata.issuer !== config.issuer || !metadata.code_challenge_methods_supported?.includes("S256") ||
            !metadata.token_endpoint_auth_methods_supported?.includes("client_secret_post")) {
            throw new Error("OIDC metadata mismatch");
          }
          for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
            if (!value || validateUrl(value).origin !== allowedOrigin) throw new Error("OIDC metadata endpoint mismatch");
          }
          result.timeout = 5;
          logoutKeys = createRemoteJWKSet(new URL(metadata.jwks_uri!), {
            [joseFetch]: guardedFetch, timeoutDuration: 5000, cooldownDuration: 5000, cacheMaxAge: 300_000,
          });
          return result;
        }).catch(() => { configuration = undefined; throw new OidcIdentityError("provider_unavailable"); });
    }
    return configuration;
  }
  return {
    newAuthorizationMaterial(): OidcAuthorizationMaterial {
      return { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier() };
    },
    async authorizationUrl(material: OidcAuthorizationMaterial, purpose: "login" | "lease_check" | "step_up" | "owner_link"): Promise<string> {
      const client = await discover();
      return oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.redirectUri, scope: "openid email pawket_assurance", response_type: "code",
        state: material.state, nonce: material.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(material.verifier), code_challenge_method: "S256",
        ...(purpose === "lease_check" ? { prompt: "none" } : purpose === "step_up" || purpose === "owner_link"
          ? { prompt: "login", max_age: String(reauthenticationMaxAgeSeconds) } : {}),
      }).href;
    },
    async exchange(callback: URL, material: OidcAuthorizationMaterial): Promise<Record<string, unknown>> {
      const expected = new URL(config.redirectUri);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash || callback.username || callback.password) {
        throw new OidcIdentityError("invalid_response");
      }
      const client = await discover();
      try {
        const tokens = await oidc.authorizationCodeGrant(client, callback, {
          expectedNonce: material.nonce, expectedState: material.state, pkceCodeVerifier: material.verifier, idTokenExpected: true,
        });
        // No tokens leave this boundary. Claims have passed library protocol and JWS verification.
        const claims = tokens.claims();
        if (!claims || !Number.isSafeInteger(claims.iat) || claims.iat > Math.floor(Date.now() / 1000)) throw new OidcIdentityError("invalid_response");
        return { ...claims };
      } catch (error) {
        if (dependencies.onExchangeFailure) {
          const allowedCodes = new Set(["OAUTH_INVALID_RESPONSE", "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
            "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED", "OAUTH_KEY_SELECTION_FAILED",
            "OAUTH_RESPONSE_BODY_ERROR", "OAUTH_AUTHORIZATION_RESPONSE_ERROR", "OAUTH_RESPONSE_IS_NOT_CONFORM",
            "OAUTH_RESPONSE_IS_NOT_JSON", "OAUTH_UNSUPPORTED_OPERATION", "OAUTH_TIMEOUT", "OAUTH_ABORT",
            "OAUTH_HTTP_REQUEST_FORBIDDEN", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_ARG_TYPE"]);
          const e = error as { code?: string; error?: string; cause?: { claim?: string; cause?: { claim?: string } } };
          const claim = e?.cause?.claim ?? e?.cause?.cause?.claim;
          const diagnostic = { code: e?.code && allowedCodes.has(e.code) ? e.code : "other",
            ...(["iss", "aud", "azp", "nonce", "exp", "iat", "auth_time", "sub"].includes(claim ?? "") ? { claim } : {}),
            ...(["invalid_client", "invalid_grant", "invalid_request", "unauthorized_client", "unsupported_grant_type", "invalid_scope"].includes(e?.error ?? "") ? { providerError: e.error } : {}) };
          try { dependencies.onExchangeFailure(diagnostic); } catch { /* Diagnostics never change rejection. */ }
        }
        throw new OidcIdentityError(exchangeFailureCode(error));
      }
    },
    async verifyLogout(token: string, now: Date): Promise<OidcLogout> {
      if (!token || token.length > 16_384 || !Number.isFinite(now.getTime())) throw new OidcIdentityError("invalid_response");
      await discover();
      try {
        const { payload } = await jwtVerify(token, logoutKeys!, {
          issuer: config.issuer, audience: config.clientId, algorithms: ["RS256"],
          requiredClaims: ["iss", "aud", "iat", "jti", "events"], currentDate: now, clockTolerance: 0, maxTokenAge: 300,
        });
        if (Object.hasOwn(payload, "nonce") || typeof payload.jti !== "string" || !payload.jti || payload.jti.length > 255 ||
          typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat) || payload.iat * 1000 > now.getTime()) throw new Error();
        const events = payload.events;
        if (!events || typeof events !== "object" || Array.isArray(events) || !Object.hasOwn(events, logoutEvent)) throw new Error();
        const event = (events as Record<string, unknown>)[logoutEvent];
        if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).length !== 0) throw new Error();
        const sid = payload.sid;
        const subject = payload.sub;
        for (const value of [sid, subject]) {
          if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 255)) throw new Error();
        }
        if (sid === undefined && subject === undefined) throw new Error();
        return { jti: payload.jti, issuedAt: new Date(payload.iat * 1000),
          ...(typeof sid === "string" ? { sid } : {}), ...(subject ? { subject } : {}) };
      } catch { throw new OidcIdentityError("invalid_response"); }
    },
  };
}
