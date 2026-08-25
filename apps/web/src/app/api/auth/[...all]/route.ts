import { getIdentityRuntime } from "../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../http/route-context";

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

function authOperation(path: string): AuthOperation | null {
  if (path.includes("/callback/")) return "oauth_callback";
  if (path.includes("two-factor")) return "mfa";
  if (path.includes("sign-in")) return "login";
  if (path.includes("sign-up")) return "registration";
  if (path.includes("verify-email") || path.includes("send-verification-email")) {
    return "verification";
  }
  if (path.includes("forget-password") || path.includes("reset-password")) return "reset";
  if (path.includes("change-email") || path.includes("change-password")) return "security_change";
  if (
    path.includes("get-session") ||
    path.includes("list-sessions") ||
    path.includes("revoke-session") ||
    path.includes("sign-out")
  ) {
    return "session";
  }
  return null;
}

function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const operation = authOperation(path);
  return withRouteContext(request, () => {
    const handler = () => getIdentityRuntime().auth.handler(request);
    return operation
      ? withBusinessOperation({ domain: "auth", operation }, handler)
      : handler();
  });
}

export const GET = handle;
export const POST = handle;
