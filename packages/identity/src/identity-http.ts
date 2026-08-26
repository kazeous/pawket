import {
  canonicalizeEmailAddress,
  isTrustedMutationOrigin,
  productionSessionCookie,
} from "./core-identity-policy.js";
import { IdentityDependencyError, IdentityInputError } from "./identity-service.js";

type SessionContext = {
  userId: string;
  sessionId: string;
  primaryAuthenticatedAt: Date;
};

type SessionSummary = {
  id: string;
  deviceLabel: string;
  createdAt: Date;
  lastUsedAt: Date;
};

type IdentityHttpService = {
  registerPassword(input: { name: string; email: string; password: string }): Promise<{ accepted: true }>;
  resendEmailVerification(input: { email: string }): Promise<{ accepted: true }>;
  verifyEmail(input: { token: string }): Promise<{ verified: boolean }>;
  requestPasswordReset(input: { email: string }): Promise<{ accepted: true }>;
  resetPassword(input: { token: string; newPassword: string }): Promise<{ completed: boolean }>;
  changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    currentSessionId: string;
    primaryAuthenticatedAt: Date;
  }): Promise<{ changed: boolean }>;
  requestEmailChange(input: {
    userId: string;
    newEmail: string;
    primaryAuthenticatedAt: Date;
  }): Promise<{ accepted: boolean }>;
  completeEmailChange(input: {
    userId: string;
    token: string;
    currentSessionId: string;
  }): Promise<{ completed: boolean }>;
};

type IdentityHttpOptions = {
  trustedOrigins: readonly string[];
  emailDeliveryAvailable: boolean;
  sessionCookie?: { name: string; secure: boolean };
  service: IdentityHttpService;
  authenticate(headers: Headers): Promise<SessionContext | null>;
  getMe(userId: string): Promise<Record<string, unknown> | null>;
  listSessions(userId: string, now: Date): Promise<SessionSummary[]>;
  revokeSession(input: {
    userId: string;
    sessionId: string;
    reason: string;
    now: Date;
  }): Promise<boolean>;
  revokeAllSessions(input: {
    userId: string;
    reason: string;
    now: Date;
  }): Promise<number>;
  throttle?(input: {
    action: string;
    accountSubject: string;
    request: Request;
  }): Promise<{ allowed: boolean }>;
  now?: () => Date;
};

const safeSessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

function json(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function empty(
  status: number,
  clearSession = false,
  sessionCookie: { name: string; secure: boolean } = productionSessionCookie,
): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (clearSession) {
    headers.set(
      "set-cookie",
      `${sessionCookie.name}=; Max-Age=0; Path=/; HttpOnly${sessionCookie.secure ? "; Secure" : ""}; SameSite=Lax`,
    );
  }
  return new Response(null, { status, headers });
}

function mutationAllowed(request: Request, trustedOrigins: readonly string[]): boolean {
  return isTrustedMutationOrigin({
    origin: request.headers.get("origin"),
    trustedOrigins,
  });
}

async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) return null;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return null;
  }
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum ? value : null;
}

function serviceFailure(error: unknown): Response {
  if (error instanceof IdentityDependencyError) {
    return json(503, { code: "PASSWORD_CHECK_UNAVAILABLE" });
  }
  if (error instanceof IdentityInputError) {
    return json(error.reason === "recent_authentication_required" ? 403 : 422, {
      code: error.reason === "recent_authentication_required" ? "RECENT_AUTH_REQUIRED" : "POLICY_REJECTED",
    });
  }
  return json(503, { code: "IDENTITY_UNAVAILABLE" });
}

export function createIdentityHttpHandlers(options: IdentityHttpOptions) {
  const now = options.now ?? (() => new Date());

  const requireMutation = (request: Request): Response | null =>
    mutationAllowed(request, options.trustedOrigins)
      ? null
      : json(403, { code: "UNTRUSTED_ORIGIN" });

  const requireEmail = (): Response | null =>
    options.emailDeliveryAvailable
      ? null
      : json(503, { code: "SECURITY_EMAIL_UNAVAILABLE" });

  const authenticated = async (
    request: Request,
  ): Promise<SessionContext | Response> => {
    try {
      const context = await options.authenticate(request.headers);
      return context ?? json(401, { code: "AUTHENTICATION_REQUIRED" });
    } catch {
      return json(503, { code: "IDENTITY_UNAVAILABLE" });
    }
  };

  const throttled = async (
    request: Request,
    action: string,
    accountSubject: string,
  ): Promise<Response | null> => {
    if (!options.throttle) return null;
    try {
      const decision = await options.throttle({ action, accountSubject, request });
      return decision.allowed ? null : json(429, { code: "RATE_LIMITED" });
    } catch {
      return json(503, { code: "IDENTITY_UNAVAILABLE" });
    }
  };

  return {
    async register(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const body = await objectBody(request);
      const name = boundedString(body?.name, 1, 100)?.trim() ?? null;
      const email = boundedString(body?.email, 3, 254);
      const password = boundedString(body?.password, 1, 256);
      if (!name || !email || !password) return json(400, { code: "INVALID_REQUEST" });
      try {
        canonicalizeEmailAddress(email);
      } catch {
        return json(400, { code: "INVALID_REQUEST" });
      }
      const throttle = await throttled(request, "registration", email.trim().toLowerCase());
      if (throttle) return throttle;
      try {
        const result = await options.service.registerPassword({ name, email, password });
        return json(202, result);
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async resendEmailVerification(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const body = await objectBody(request);
      const email = boundedString(body?.email, 3, 254);
      if (!email) return json(400, { code: "INVALID_REQUEST" });
      const throttle = await throttled(
        request,
        "email_verification_resend",
        email.trim().toLowerCase(),
      );
      if (throttle) return throttle;
      try {
        return json(202, await options.service.resendEmailVerification({ email }));
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async verifyEmail(request: Request): Promise<Response> {
      const guard = requireMutation(request);
      if (guard) return guard;
      const body = await objectBody(request);
      const token = boundedString(body?.token, 16, 2_048);
      if (!token) return json(400, { code: "INVALID_REQUEST" });
      const throttle = await throttled(request, "email_verification_consume", token);
      if (throttle) return throttle;
      try {
        const result = await options.service.verifyEmail({ token });
        return result.verified
          ? json(200, { verified: true })
          : json(400, { verified: false, code: "INVALID_OR_EXPIRED_CHALLENGE" });
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async requestPasswordReset(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const body = await objectBody(request);
      const email = boundedString(body?.email, 3, 254);
      if (!email) return json(400, { code: "INVALID_REQUEST" });
      const throttle = await throttled(
        request,
        "password_reset_request",
        email.trim().toLowerCase(),
      );
      if (throttle) return throttle;
      try {
        return json(202, await options.service.requestPasswordReset({ email }));
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async resetPassword(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const body = await objectBody(request);
      const token = boundedString(body?.token, 16, 2_048);
      const newPassword = boundedString(body?.newPassword, 1, 256);
      if (!token || !newPassword) return json(400, { code: "INVALID_REQUEST" });
      const throttle = await throttled(request, "password_reset_consume", token);
      if (throttle) return throttle;
      try {
        const result = await options.service.resetPassword({ token, newPassword });
        return result.completed
          ? json(200, { completed: true })
          : json(400, { completed: false, code: "INVALID_OR_EXPIRED_CHALLENGE" });
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async changePassword(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const context = await authenticated(request);
      if (context instanceof Response) return context;
      const body = await objectBody(request);
      const currentPassword = boundedString(body?.currentPassword, 1, 256);
      const newPassword = boundedString(body?.newPassword, 1, 256);
      if (!currentPassword || !newPassword) return json(400, { code: "INVALID_REQUEST" });
      const throttle = await throttled(request, "password_change", context.userId);
      if (throttle) return throttle;
      try {
        const result = await options.service.changePassword({
          userId: context.userId,
          currentPassword,
          newPassword,
          currentSessionId: context.sessionId,
          primaryAuthenticatedAt: context.primaryAuthenticatedAt,
        });
        return result.changed
          ? json(200, { changed: true })
          : json(401, { changed: false, code: "CURRENT_PASSWORD_INVALID" });
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async requestEmailChange(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const context = await authenticated(request);
      if (context instanceof Response) return context;
      const body = await objectBody(request);
      const newEmail = boundedString(body?.newEmail, 3, 254);
      if (!newEmail) return json(400, { code: "INVALID_REQUEST" });
      try {
        canonicalizeEmailAddress(newEmail);
      } catch {
        return json(400, { code: "INVALID_REQUEST" });
      }
      const throttle = await throttled(request, "email_change_request", context.userId);
      if (throttle) return throttle;
      try {
        const result = await options.service.requestEmailChange({
          userId: context.userId,
          newEmail,
          primaryAuthenticatedAt: context.primaryAuthenticatedAt,
        });
        return result.accepted
          ? json(202, { accepted: true })
          : json(409, { accepted: false, code: "EMAIL_UNAVAILABLE" });
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async completeEmailChange(request: Request): Promise<Response> {
      const guard = requireMutation(request) ?? requireEmail();
      if (guard) return guard;
      const context = await authenticated(request);
      if (context instanceof Response) return context;
      const body = await objectBody(request);
      const token = boundedString(body?.token, 16, 2_048);
      if (!token) return json(400, { code: "INVALID_REQUEST" });
      const throttle = await throttled(request, "email_change_consume", context.userId);
      if (throttle) return throttle;
      try {
        const result = await options.service.completeEmailChange({
          userId: context.userId,
          token,
          currentSessionId: context.sessionId,
        });
        return result.completed
          ? json(200, { completed: true })
          : json(400, { completed: false, code: "INVALID_OR_EXPIRED_CHALLENGE" });
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async me(request: Request): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const context = await authenticated(request);
      if (context instanceof Response) return context;
      try {
        const user = await options.getMe(context.userId);
        return user
          ? json(200, { user })
          : json(401, { code: "AUTHENTICATION_REQUIRED" });
      } catch {
        return json(503, { code: "IDENTITY_UNAVAILABLE" });
      }
    },

    async sessions(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "DELETE") {
        return json(405, { code: "METHOD_NOT_ALLOWED" });
      }
      if (request.method === "DELETE") {
        const guard = requireMutation(request);
        if (guard) return guard;
      }
      const context = await authenticated(request);
      if (context instanceof Response) return context;
      try {
        if (request.method === "DELETE") {
          await options.revokeAllSessions({
            userId: context.userId,
            reason: "user_requested_all",
            now: now(),
          });
          return empty(204, true, options.sessionCookie);
        }
        const sessions = await options.listSessions(context.userId, now());
        return json(200, {
          sessions: sessions.map((session) => ({
            ...session,
            isCurrent: session.id === context.sessionId,
          })),
        });
      } catch {
        return json(503, { code: "IDENTITY_UNAVAILABLE" });
      }
    },

    async session(request: Request, sessionId: string): Promise<Response> {
      if (request.method !== "DELETE") return json(405, { code: "METHOD_NOT_ALLOWED" });
      const guard = requireMutation(request);
      if (guard) return guard;
      if (!safeSessionIdPattern.test(sessionId)) return json(400, { code: "INVALID_REQUEST" });
      const context = await authenticated(request);
      if (context instanceof Response) return context;
      try {
        const revoked = await options.revokeSession({
          userId: context.userId,
          sessionId,
          reason: "user_requested",
          now: now(),
        });
        return revoked
          ? empty(204, sessionId === context.sessionId, options.sessionCookie)
          : json(404, { code: "NOT_FOUND" });
      } catch {
        return json(503, { code: "IDENTITY_UNAVAILABLE" });
      }
    },
  };
}
