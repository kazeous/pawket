import { getIdentityRuntime } from "../../../../auth/runtime";
import {
  recordBusinessOperationOutcome,
  withBusinessOperation,
  withRouteContext,
} from "../../../../http/route-context";

export const runtime = "nodejs";

type AuthOperation =
  | "registration"
  | "verification"
  | "login"
  | "oauth_callback"
  | "reset"
  | "mfa"
  | "session"
  | "security_change";

const AUTH_PATH_PREFIX = "/api/auth";
const CALLBACK_PATHS = new Set(["/callback/discord", "/callback/google"]);
const AUTH_OPERATIONS_BY_PATH = new Map<string, AuthOperation>([
  ["/get-session", "session"],
  ["/link-social", "security_change"],
  ["/list-accounts", "session"],
  ["/sign-in/email", "login"],
  ["/sign-in/social", "login"],
  ["/sign-out", "session"],
  ["/two-factor/enable", "mfa"],
  ["/two-factor/regenerate-recovery-codes", "mfa"],
  ["/two-factor/verify-recovery-code", "mfa"],
  ["/two-factor/verify-totp", "mfa"],
  ["/unlink-account", "security_change"],
]);

function protocolPath(pathname: string): string | null {
  if (pathname === AUTH_PATH_PREFIX) return "/";
  return pathname.startsWith(`${AUTH_PATH_PREFIX}/`)
    ? pathname.slice(AUTH_PATH_PREFIX.length)
    : null;
}

function handle(request: Request): Promise<Response> {
  const path = protocolPath(new URL(request.url).pathname);
  const operation = path ? AUTH_OPERATIONS_BY_PATH.get(path) ?? null : null;
  return withRouteContext(request, async () => {
    const auth = getIdentityRuntime().auth;
    if (path && CALLBACK_PATHS.has(path)) {
      const response = await auth.handler(request);
      const telemetry = auth.consumeOperationTelemetry(request);
      if (telemetry) {
        recordBusinessOperationOutcome(
          { domain: "auth", operation: telemetry.operation },
          telemetry.outcome,
        );
      }
      return response;
    }
    const handler = () => auth.handler(request);
    return operation
      ? withBusinessOperation({ domain: "auth", operation }, handler)
      : handler();
  });
}

export const GET = handle;
export const POST = handle;
