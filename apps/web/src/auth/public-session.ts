type SessionState = "authenticated" | "anonymous";

type Authenticate = (headers: Headers) => Promise<unknown | null>;

export async function resolvePublicSession(
  authenticate: Authenticate,
  requestHeaders: Headers,
): Promise<SessionState> {
  try {
    return (await authenticate(requestHeaders)) ? "authenticated" : "anonymous";
  } catch {
    // Public entry pages remain available during an identity dependency outage.
    // Mutating authentication requests continue to fail closed at their boundary.
    return "anonymous";
  }
}

export function homeAccountAction(state: SessionState): { href: string; label: string } {
  return state === "authenticated"
    ? { href: "/settings/security", label: "Tài khoản" }
    : { href: "/sign-in", label: "Đăng nhập" };
}

export function authenticatedEntryRedirect(state: SessionState): string | null {
  return state === "authenticated" ? "/settings/security" : null;
}
