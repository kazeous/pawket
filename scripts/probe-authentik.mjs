// Ephemeral, loopback-only real-provider probe. No credentials or tokens are written to disk.
// Run with: node --import tsx scripts/probe-authentik.mjs
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createOidcProtocol } from "../packages/identity/src/oidc-protocol.ts";
import { normalizeOidcEvidence, assertOidcStepUp } from "../packages/identity/src/oidc-policy.ts";

const origin = "http://127.0.0.1:8787";
const binding = randomBytes(32).toString("base64url");
let protocol;
let config;
let previous;
let lastResult = "Chưa kiểm tra provider.";
let protocolFailure;
let tokenRequestShape;
const pending = new Map();
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://account.reyuugames.com; frame-ancestors 'none'; base-uri 'none'" };
function response(res, status, body, extra = {}) {
  res.writeHead(status, { ...headers, "content-type": "text/html; charset=utf-8", ...extra }); res.end(body);
}
function browserMatches(req) {
  const values = (req.headers.cookie ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith("pawket.probe="));
  const value = values.length === 1 ? values[0].slice("pawket.probe=".length) : "";
  return value.length === binding.length && timingSafeEqual(Buffer.from(value), Buffer.from(binding));
}
async function body(req) {
  const parts = []; let length = 0;
  for await (const part of req) { length += part.length; if (length > 4096) throw new Error("body_limit"); parts.push(part); }
  return new URLSearchParams(Buffer.concat(parts).toString("utf8"));
}
function page() {
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pawket authentik probe</title>
  <style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:20px}label{display:block;margin:12px 0}input{display:block;width:95%;padding:8px}button{padding:10px;margin:8px}pre{white-space:pre-wrap;background:#eee;padding:16px}</style>
  <h1>Kiểm tra authentik cho Pawket</h1><p>Chạy tại máy này. Secret chỉ giữ trong bộ nhớ cho tới khi đóng tiến trình.</p>
  <pre>${escape(lastResult)}</pre>
  ${protocol ? '<p>Đã cấu hình confidential client.</p><form method="post" action="/login"><button>Đăng nhập thử</button></form><form method="post" action="/lease"><button>Kiểm tra phiên im lặng</button></form><form method="post" action="/step-up"><button>Xác thực lại với TOTP</button></form>' :
  '<form method="post" action="/configure"><label>Issuer<input name="issuer" value="https://account.reyuugames.com/application/o/pawket-sso-test/" required></label><label>Client ID<input name="clientId" value="pawket-sso-test-v1" required></label><label>Client secret<input type="password" name="clientSecret" autocomplete="off" required></label><button>Lưu trong bộ nhớ</button></form>'}</html>`;
}
const server = createServer(async (req, res) => {
  if (req.headers.host !== "127.0.0.1:8787") return response(res, 421, "Host rejected");
  const url = new URL(req.url ?? "/", origin);
  let phase = "request";
  let contract;
  try {
    if (url.pathname === "/" && req.method === "GET") {
      return response(res, 200, page(), { "referrer-policy": "same-origin", "set-cookie": `pawket.probe=${binding}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (url.pathname === "/callback" && req.method === "GET") {
      if (!protocol || !browserMatches(req) || url.searchParams.getAll("state").length !== 1) throw new Error("browser_binding");
      const state = url.searchParams.get("state"); const transaction = pending.get(state); pending.delete(state);
      if (!transaction || Date.now() - transaction.startedAt.getTime() >= 300_000) throw new Error("expired_transaction");
      phase = "protocol_and_signature";
      protocolFailure = undefined;
      tokenRequestShape = undefined;
      const claims = await protocol.exchange(url, transaction.material);
      phase = "claims_contract";
      const assurance = claims.pawket_assurance;
      // Only bounded booleans describe verified claim shape; never log claims or identifiers.
      contract = { issuerMatches: claims.iss === config.issuer, hasSessionId: typeof claims.sid === "string" && claims.sid.length > 0,
        hasEmail: typeof claims.email === "string", emailVerified: claims.email_verified === true,
        hasAuthTime: Number.isSafeInteger(claims.auth_time), authTimeNotFuture: typeof claims.auth_time === "number" && claims.auth_time * 1000 <= Date.now(),
        assuranceVersionMatches: assurance?.version === 1, assurancePolicyMatches: assurance?.policy === config.providerRevision,
        primaryTimeMatches: assurance?.primary_at === claims.auth_time, primaryMethodAllowed: ["password", "source"].includes(assurance?.primary_method),
        enrollmentKnown: typeof assurance?.totp_enrolled === "boolean", hasTotpEvidence: typeof assurance?.totp_at === "number",
        amrIncludesMfa: Array.isArray(claims.amr) && claims.amr.includes("mfa") };
      const evidence = normalizeOidcEvidence(claims, { issuer: config.issuer, providerRevision: config.providerRevision, now: new Date() });
      phase = "freshness";
      if (transaction.purpose === "step_up") assertOidcStepUp(evidence, {
        expectedSubject: previous.subject, requestedAt: transaction.startedAt, now: new Date(), owner: true,
      });
      const verdict = { signatureAndProtocol: "passed", purpose: transaction.purpose, emailVerified: evidence.emailVerified,
        primaryMethod: evidence.primaryMethod, primaryAgeSeconds: Math.floor((Date.now() - evidence.primaryAt.getTime()) / 1000),
        totpStatus: evidence.totpStatus, totpProof: evidence.totpAt !== null,
        sameIdentity: previous ? evidence.subject === previous.subject : null,
        sameSession: previous ? evidence.sid === previous.sid : null,
        primaryTimeUnchanged: previous ? evidence.primaryAt.getTime() === previous.primaryAt.getTime() : null };
      previous = evidence; lastResult = JSON.stringify(verdict, null, 2);
      console.info("OIDC probe:", lastResult);
      return response(res, 303, "", { location: "/" });
    }
    if (req.method !== "POST" || req.headers.origin !== origin || !browserMatches(req)) return response(res, 403, "Origin or browser rejected");
    const form = await body(req);
    if (url.pathname === "/configure" && !protocol) {
      const issuer = form.get("issuer") ?? "";
      if (new URL(issuer).origin !== "https://account.reyuugames.com") throw new Error("issuer_not_allowed");
      config = { issuer, clientId: form.get("clientId") ?? "", clientSecret: form.get("clientSecret") ?? "",
        redirectUri: `${origin}/callback`, providerRevision: "pawket-v1", accountPortalUrl: "https://account.reyuugames.com/if/user/" };
      protocol = createOidcProtocol(config, {
        onExchangeFailure: (diagnostic) => { protocolFailure = diagnostic; },
        fetch: async (input, init) => {
          const target = new URL(input instanceof Request ? input.url : input.toString());
          if (target.pathname === "/application/o/token/") {
            const requestHeaders = new Headers(init?.headers);
            const rawBody = init?.body instanceof ArrayBuffer ? Buffer.from(init.body).toString("utf8") : String(init?.body ?? "");
            const params = new URLSearchParams(rawBody);
            const basic = requestHeaders.get("authorization") ?? "";
            const decoded = basic.startsWith("Basic ") ? Buffer.from(basic.slice(6), "base64").toString("utf8") : "";
            const split = decoded.indexOf(":");
            tokenRequestShape = {
              basicPresent: basic.startsWith("Basic "),
              clientIdMatches: (basic ? decodeURIComponent(decoded.slice(0, split)) : params.get("client_id")) === config.clientId,
              clientSecretMatches: (basic ? decodeURIComponent(decoded.slice(split + 1)) : params.get("client_secret")) === config.clientSecret,
              redirectMatches: params.get("redirect_uri") === config.redirectUri,
              authorizationCodeGrant: params.get("grant_type") === "authorization_code",
              hasCode: Boolean(params.get("code")), hasVerifier: Boolean(params.get("code_verifier")),
              formContentType: requestHeaders.get("content-type")?.startsWith("application/x-www-form-urlencoded") === true,
            };
          }
          return fetch(input, init);
        },
      });
      lastResult = "Confidential client đã sẵn sàng; chưa chạy đăng nhập.";
      return response(res, 303, "", { location: "/" });
    }
    const purpose = ({ "/login": "login", "/lease": "lease_check", "/step-up": "step_up" })[url.pathname];
    if (!purpose || !protocol || (purpose !== "login" && !previous)) return response(res, 400, "Login required");
    for (const [key, value] of pending) if (Date.now() - value.startedAt.getTime() > 300_000) pending.delete(key);
    if (pending.size >= 10) return response(res, 429, "Too many pending probes");
    const material = protocol.newAuthorizationMaterial(); pending.set(material.state, { material, purpose, startedAt: new Date() });
    const location = await protocol.authorizationUrl(material, purpose);
    return response(res, 303, "", { location });
  } catch (error) {
    // Never log exceptions, request URLs, token bodies, claims, or supplied credentials.
    lastResult = JSON.stringify({ result: "not_passed", phase,
      code: ["invalid_response", "provider_unavailable", "email_unverified", "assurance_required", "actor_changed"].includes(error?.code) ? error.code : "probe_rejected",
      ...(contract ? { contract } : {}), ...(phase === "protocol_and_signature" && protocolFailure ? { protocolFailure, tokenRequestShape } : {}) }, null, 2);
    console.info(lastResult);
    return response(res, 303, "", { location: "/" });
  }
});
server.listen(8787, "127.0.0.1", () => console.info(`Pawket real OIDC probe: ${origin}`));
