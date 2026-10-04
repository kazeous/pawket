import { createHash } from "node:crypto";
import { resolveSessionCookie } from "./core-identity-policy.js";
import { OidcIdentityError } from "./oidc-policy.js";
import type { createOidcIdentityService } from "./oidc-service.js";
import type { OidcTransactionIntent } from "./oidc-transactions.js";
import type { OidcActorBinding } from "./oidc-transactions.js";

type Service = ReturnType<typeof createOidcIdentityService>;
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (status: number, code: string) => Response.json({ code }, { status, headers: noStore });

export function readOpaqueCookie(headers: Headers, name: string): string | undefined {
  const values = (headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43,128}$/u.test(values[0]!) ? values[0] : undefined;
}
function bindingCookieName(state: string, secure: boolean): string {
  return `${secure ? "__Host-" : ""}pawket.oidc.${createHash("sha256").update(state).digest("hex").slice(0, 24)}`;
}
function cookie(name: string, value: string, secure: boolean, maxAge: number): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
async function boundedBody(request: Request, limit: number): Promise<string | null> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > limit) return null;
  const reader = request.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > limit) return null;
      chunks.push(part.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { return null; }
  finally { await reader.cancel(); }
}
async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const text = await boundedBody(request, 4096); if (text === null) return null;
  try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}

export function createOidcHttpHandlers(options: {
  baseURL: string; service: Service;
  throttle: (request: Request, action: "oidc_start" | "oidc_callback" | "oidc_logout") => Promise<boolean>;
  now?: () => Date;
  stepUpIntent?: (id: string, actor: OidcActorBinding) => Promise<{ intent: OidcTransactionIntent; returnPath: string }>;
}) {
  const baseURL = new URL(options.baseURL);
  const sessionCookie = resolveSessionCookie(options.baseURL);
  const now = options.now ?? (() => new Date());
  const sessionToken = (request: Request) => readOpaqueCookie(request.headers, sessionCookie.name);
  const redirect = (path: string, cookies: string[] = []) => {
    const headers = new Headers({ ...noStore, location: new URL(path, baseURL).href });
    for (const value of cookies) headers.append("set-cookie", value);
    return new Response(null, { status: 303, headers });
  };
  async function start(request: Request, purpose: "login" | "lease_check" | "owner_link" | "step_up"): Promise<Response> {
    if (request.method !== "POST") return json(405, "METHOD_NOT_ALLOWED");
    if (request.headers.get("origin") !== baseURL.origin) return json(403, "UNTRUSTED_ORIGIN");
    try {
      if (!await options.throttle(request, "oidc_start")) return json(429, "RATE_LIMITED");
      const body = await objectBody(request); if (!body) return json(400, "INVALID_REQUEST");
      let intent: OidcTransactionIntent = { purpose: "login" };
      let returnPath = typeof body.returnPath === "string" ? body.returnPath : "/";
      if (purpose === "lease_check") {
        const token = sessionToken(request); const actor = token ? await options.service.authenticate(token, true) : null;
        if (!actor) return json(401, "AUTHENTICATION_REQUIRED");
        intent = { purpose, actor };
      } else if (purpose === "owner_link") {
        if (typeof body.invitation !== "string") return json(400, "INVALID_REQUEST");
        intent = await options.service.ownerLinkIntent(body.invitation);
      } else if (purpose === "step_up") {
        const token = sessionToken(request); const actor = token ? await options.service.authenticate(token, true) : null;
        if (!actor) return json(401, "AUTHENTICATION_REQUIRED");
        if (typeof body.pendingId !== "string" || !options.stepUpIntent) return json(400, "INVALID_REQUEST");
        const saved = await options.stepUpIntent(body.pendingId, actor); intent = saved.intent; returnPath = saved.returnPath;
      }
      // Forcing a fresh IdP login only makes a plain login stricter, so the client may ask for it.
      const reauthenticate = purpose === "login" && body.reauthenticate === true;
      const started = await options.service.begin({ intent, returnPath, ...(reauthenticate ? { reauthenticate } : {}) });
      const name = bindingCookieName(started.state, sessionCookie.secure);
      return Response.json({ authorizationUrl: started.authorizationUrl }, { headers: {
        ...noStore, "set-cookie": cookie(name, started.browserBinding, sessionCookie.secure, 600),
      } });
    } catch (error) {
      return json(error instanceof OidcIdentityError && error.code !== "provider_unavailable" ? 400 : 503,
        error instanceof OidcIdentityError ? `OIDC_${error.code.toUpperCase()}` : "IDENTITY_UNAVAILABLE");
    }
  }
  return {
    login: (request: Request) => start(request, "login"),
    lease: (request: Request) => start(request, "lease_check"),
    ownerLink: (request: Request) => start(request, "owner_link"),
    stepUp: (request: Request) => start(request, "step_up"),
    async callback(request: Request): Promise<Response> {
      // Next.js builds request.url from its own listener (HOSTNAME:PORT, 0.0.0.0:3000 in the
      // container), not from the public host. The origin comes from APP_BASE_URL; only path and
      // query come from the request, and the protocol still checks them against the redirect URI.
      const incoming = new URL(request.url);
      const url = new URL(baseURL.origin); url.pathname = incoming.pathname; url.search = incoming.search;
      const states = url.searchParams.getAll("state");
      if (request.method !== "GET" || states.length !== 1 || !/^[A-Za-z0-9_-]{32,256}$/u.test(states[0]!)) {
        return redirect("/sign-in?notice=invalid_response");
      }
      const name = bindingCookieName(states[0]!, sessionCookie.secure);
      const clear = cookie(name, "", sessionCookie.secure, 0);
      try {
        if (!await options.throttle(request, "oidc_callback")) return redirect("/sign-in?notice=rate_limited", [clear]);
        const browserBinding = readOpaqueCookie(request.headers, name);
        if (!browserBinding) return redirect("/sign-in?notice=transaction_expired", [clear]);
        const completed = await options.service.callback({ url, browserBinding, localSessionToken: sessionToken(request),
          userAgent: request.headers.get("user-agent") ?? undefined });
        const cookies = [clear];
        if (completed.sessionToken) cookies.push(cookie(sessionCookie.name, completed.sessionToken, sessionCookie.secure,
          (completed.expiresAt.getTime() - now().getTime()) / 1000));
        return redirect(completed.returnPath, cookies);
      } catch (error) {
        const notice = error instanceof OidcIdentityError ? error.code : "provider_unavailable";
        return redirect(`/sign-in?notice=${notice}`, [clear]);
      }
    },
    async backchannelLogout(request: Request): Promise<Response> {
      if (request.method !== "POST") return json(405, "METHOD_NOT_ALLOWED");
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(400, "INVALID_REQUEST");
      try {
        if (!await options.throttle(request, "oidc_logout")) return json(429, "RATE_LIMITED");
        const body = await boundedBody(request, 24_000); if (body === null) return json(400, "INVALID_REQUEST");
        const values = new URLSearchParams(body).getAll("logout_token");
        if (values.length !== 1 || !values[0]) return json(400, "INVALID_REQUEST");
        await options.service.backchannelLogout(values[0]);
        return new Response(null, { status: 200, headers: noStore });
      } catch (error) {
        return json(error instanceof OidcIdentityError && error.code === "invalid_response" ? 400 : 503,
          error instanceof OidcIdentityError && error.code === "invalid_response" ? "INVALID_LOGOUT" : "IDENTITY_UNAVAILABLE");
      }
    },
    retired(): Response { return json(410, "AUTH_MOVED"); },
  };
}
