import { domainToASCII } from "node:url";

import { validatePasswordLength } from "./auth-candidate/password.js";

const commonPasswords = new Set([
  "123456789012345",
  "letmeinletmein",
  "passwordpassword",
  "qwertyuiopqwerty",
]);

const SESSION_LIFETIMES_MS = {
  user: { absolute: 30 * 24 * 60 * 60_000, idle: 7 * 24 * 60 * 60_000 },
  owner: { absolute: 12 * 60 * 60_000, idle: 30 * 60_000 },
  provisional: { absolute: 10 * 60_000, idle: 10 * 60_000 },
  mfa_pending: { absolute: 10 * 60_000, idle: 10 * 60_000 },
} as const;

const allowedReturnPathPrefixes = [
  "/",
  "/creator",
  "/reset-password",
  "/settings",
  "/verify-email",
] as const;

export type CompromisedPasswordChecker = {
  isCompromised(password: string): Promise<boolean>;
};

export type PasswordDecision =
  | { accepted: true }
  | { accepted: false; reason: "length" | "common" | "context" | "compromised" };

export function canonicalizeEmailAddress(email: string): {
  display: string;
  canonical: string;
} {
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254 || /[\u0000-\u0020\u007f]/u.test(trimmed)) {
    throw new Error("Invalid email address");
  }

  const separator = trimmed.lastIndexOf("@");
  if (separator < 1 || separator !== trimmed.indexOf("@")) {
    throw new Error("Invalid email address");
  }

  const local = trimmed.slice(0, separator);
  const rawDomain = trimmed.slice(separator + 1);
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (
    local.length > 64 ||
    !domain ||
    domain.length > 253 ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new Error("Invalid email address");
  }

  const display = `${local}@${domain}`;
  return { display, canonical: display.toLocaleLowerCase("en-US") };
}

function normalizedPasswordValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export async function evaluatePassword(input: {
  password: string;
  contextTerms?: readonly string[];
  compromisedPasswordChecker: CompromisedPasswordChecker;
}): Promise<PasswordDecision> {
  if (!validatePasswordLength(input.password)) return { accepted: false, reason: "length" };

  const normalized = normalizedPasswordValue(input.password);
  if (commonPasswords.has(normalized)) return { accepted: false, reason: "common" };

  const contextual = (input.contextTerms ?? []).some((term) => {
    const normalizedTerm = normalizedPasswordValue(term.trim());
    return normalizedTerm.length >= 4 && normalized.includes(normalizedTerm);
  });
  if (contextual) return { accepted: false, reason: "context" };

  if (await input.compromisedPasswordChecker.isCompromised(input.password)) {
    return { accepted: false, reason: "compromised" };
  }
  return { accepted: true };
}

export function resolveSessionPolicy(input: {
  kind: keyof typeof SESSION_LIFETIMES_MS;
  now: Date;
}): { absoluteExpiresAt: Date; idleExpiresAt: Date } {
  const lifetime = SESSION_LIFETIMES_MS[input.kind];
  return {
    absoluteExpiresAt: new Date(input.now.getTime() + lifetime.absolute),
    idleExpiresAt: new Date(input.now.getTime() + lifetime.idle),
  };
}

export const productionSessionCookie = Object.freeze({
  name: "__Host-pawket.session",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const);

const localSessionCookie = Object.freeze({
  name: "pawket.session",
  secure: false,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const);

export function resolveSessionCookie(baseURL: string):
  | typeof productionSessionCookie
  | typeof localSessionCookie {
  return new URL(baseURL).protocol === "https:"
    ? productionSessionCookie
    : localSessionCookie;
}

export function isAllowedReturnPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  try {
    if (decodeURI(path).startsWith("//")) return false;
    const parsed = new URL(path, "https://pawket.invalid");
    if (parsed.origin !== "https://pawket.invalid") return false;
    return allowedReturnPathPrefixes.some(
      (prefix) =>
        parsed.pathname === prefix ||
        (prefix !== "/" && parsed.pathname.startsWith(`${prefix}/`)),
    );
  } catch {
    return false;
  }
}

export function isTrustedMutationOrigin(input: {
  origin: string | null;
  trustedOrigins: readonly string[];
}): boolean {
  if (!input.origin) return false;
  try {
    const candidate = new URL(input.origin);
    if (candidate.origin !== input.origin || candidate.username || candidate.password) return false;
    return input.trustedOrigins.includes(candidate.origin);
  } catch {
    return false;
  }
}
