import { resolveSessionCookie } from "./core-identity-policy.js";
import type { OidcSessionContext } from "./oidc-session.js";

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const json = (status: number, payload: Record<string, unknown>) => Response.json(payload, { status, headers });
export const retiredIdentityResponse: (request?: Request) => Response = () => json(410, { code: "AUTH_MOVED" });

/** Pawket owns local sessions; credential enrollment and recovery belong to the IdP. */
export function createOidcAccountHttpHandlers(options: {
  baseURL: string; accountPortalUrl: string;
  authenticate(headers: Headers, allowExpiredLease?: boolean): Promise<OidcSessionContext | null>;
  getMe(userId: string): Promise<Record<string, unknown> | null>;
  listSessions(userId: string, now: Date): Promise<Array<{ id: string; deviceLabel: string; createdAt: Date; lastUsedAt: Date }>>;
  revokeSession(input: { userId: string; sessionId: string; reason: string; now: Date }): Promise<boolean>;
  revokeAllSessions(input: { userId: string; reason: string; now: Date }): Promise<number>;
  now?: () => Date;
}) {
  const origin = new URL(options.baseURL).origin; const cookie = resolveSessionCookie(options.baseURL);
  const now = options.now ?? (() => new Date());
  const allowed = (request: Request) => request.headers.get("origin") === origin;
  const empty = (clear = false) => new Response(null, { status: 204, headers: { ...headers,
    ...(clear ? { "set-cookie": `${cookie.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${cookie.secure ? "; Secure" : ""}` } : {}) } });
  async function actor(request: Request, allowExpiredLease = false) {
    const session = await options.authenticate(request.headers, true);
    if (!session) return json(401, { code: "AUTHENTICATION_REQUIRED" });
    if (!allowExpiredLease && session.leaseRequired) return json(401, { code: "OIDC_LEASE_REQUIRED" });
    return session;
  }
  const unavailable = () => json(503, { code: "IDENTITY_UNAVAILABLE" });
  return {
    register: retiredIdentityResponse, resendEmailVerification: retiredIdentityResponse,
    verifyEmail: retiredIdentityResponse, requestPasswordReset: retiredIdentityResponse,
    resetPassword: retiredIdentityResponse, changePassword: retiredIdentityResponse,
    requestEmailChange: retiredIdentityResponse, completeEmailChange: retiredIdentityResponse,
    async me(request: Request): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      try {
        const session = await actor(request); if (session instanceof Response) return session;
        const user = await options.getMe(session.userId);
        return user ? json(200, { user: { ...user, twoFactorEnabled: session.mfaStatus === "enrolled" },
          identityProvider: "authentik", accountPortalUrl: options.accountPortalUrl }) : json(401, { code: "AUTHENTICATION_REQUIRED" });
      } catch { return unavailable(); }
    },
    async logout(request: Request): Promise<Response> {
      if (request.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" });
      if (!allowed(request)) return json(403, { code: "UNTRUSTED_ORIGIN" });
      try {
        // Local logout stays available during an IdP outage or expired lease.
        const session = await options.authenticate(request.headers, true);
        if (session) await options.revokeSession({ ...session, reason: "user_requested", now: now() });
        return empty(true);
      } catch { return unavailable(); }
    },
    async sessions(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "DELETE") return json(405, { code: "METHOD_NOT_ALLOWED" });
      if (request.method === "DELETE" && !allowed(request)) return json(403, { code: "UNTRUSTED_ORIGIN" });
      try {
        const session = await actor(request, request.method === "DELETE"); if (session instanceof Response) return session;
        if (request.method === "DELETE") {
          await options.revokeAllSessions({ userId: session.userId, reason: "user_requested_all", now: now() });
          return empty(true);
        }
        return json(200, { sessions: (await options.listSessions(session.userId, now())).map((item) => ({ ...item, isCurrent: item.id === session.sessionId })) });
      } catch { return unavailable(); }
    },
    async session(request: Request, sessionId: string): Promise<Response> {
      if (request.method !== "DELETE") return json(405, { code: "METHOD_NOT_ALLOWED" });
      if (!allowed(request)) return json(403, { code: "UNTRUSTED_ORIGIN" });
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) return json(400, { code: "INVALID_REQUEST" });
      try {
        const session = await actor(request, true); if (session instanceof Response) return session;
        const revoked = await options.revokeSession({ userId: session.userId, sessionId, reason: "user_requested", now: now() });
        return revoked ? empty(sessionId === session.sessionId) : json(404, { code: "NOT_FOUND" });
      } catch { return unavailable(); }
    },
  };
}
