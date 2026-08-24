export type StructuredDataChannel = "audit" | "command" | "job" | "metric" | "outbox";

export const REDACTED_VALUE = "[Redacted]";

const sensitiveKeyParts = [
  "apikey",
  "accesskey",
  "basicauth",
  "authheader",
  "authentication",
  "authorization",
  "cookie",
  "credential",
  "databaseurl",
  "valkeyurl",
  "oauth",
  "password",
  "secret",
  "token",
  "dateofbirth",
  "birthdate",
  "bankaccount",
  "accountnumber",
  "accountholder",
  "challengereference",
  "recoverycode",
  "totp",
  "ciphertext",
  "authenticationtag",
  "governmentid",
  "nationalid",
  "passport",
  "phonenumber",
  "legalname",
  "fullname",
  "postaladdress",
];
const sensitiveExactKeys = new Set([
  "auth",
  "bootstrapowneremail",
  "canonicalemail",
  "displayemail",
  "email",
  "emailaddress",
  "newemail",
  "newphone",
  "oauth",
  "oldemail",
  "oldphone",
  "phone",
  "provideremail",
]);
const connectionUrlPattern =
  /(?:postgres(?:ql)?|redis|rediss|mysql|mongodb(?:\+srv)?|amqp|amqps):\/\/[^\s]+/i;
const embeddedCredentialUrlPattern =
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+(?::[^@\s/]*)?@/i;
const embeddedUrlPattern = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function structuredKeyIsSensitive(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    sensitiveExactKeys.has(normalized) ||
    sensitiveKeyParts.some((part) => normalized.includes(part))
  );
}

function stringContainsCredentials(value: string): boolean {
  if (connectionUrlPattern.test(value) || embeddedCredentialUrlPattern.test(value)) {
    return true;
  }
  for (const candidate of value.match(embeddedUrlPattern) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return true;
      for (const key of url.searchParams.keys()) {
        if (structuredKeyIsSensitive(key)) return true;
      }
    } catch {
      // A malformed URL-shaped application string is not treated as a credential URL.
    }
  }
  return false;
}

export class UnsafeStructuredDataError extends Error {
  constructor(channel: StructuredDataChannel) {
    super(`Unsafe ${channel} data`);
    this.name = "UnsafeStructuredDataError";
  }
}

function assertSafeValue(
  value: unknown,
  channel: StructuredDataChannel,
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    if (stringContainsCredentials(value)) throw new UnsafeStructuredDataError(channel);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new UnsafeStructuredDataError(channel);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item, channel, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (structuredKeyIsSensitive(key)) throw new UnsafeStructuredDataError(channel);
    assertSafeValue(child, channel, seen);
  }
}

export function assertSafeStructuredData(
  value: unknown,
  channel: StructuredDataChannel,
): void {
  assertSafeValue(value, channel, new WeakSet<object>());
}

export function canonicalizeSafeStructuredData<T>(
  value: T,
  channel: StructuredDataChannel,
): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new UnsafeStructuredDataError(channel);
    const canonical = JSON.parse(serialized) as T;
    assertSafeStructuredData(canonical, channel);
    return canonical;
  } catch {
    throw new UnsafeStructuredDataError(channel);
  }
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeLogValue(
  value: unknown,
  key: string | undefined,
  parentKey: string | undefined,
  seen: WeakSet<object>,
  knownSecrets: readonly string[],
): unknown {
  const normalizedKey = key?.toLowerCase();
  const normalizedParent = parentKey?.toLowerCase();
  if (
    (key !== undefined && structuredKeyIsSensitive(key)) ||
    (normalizedKey === "body" &&
      (normalizedParent === "request" || normalizedParent === "req"))
  ) {
    return REDACTED_VALUE;
  }
  if (typeof value === "string") {
    if (stringContainsCredentials(value)) return REDACTED_VALUE;
    let sanitized = value;
    for (const secret of knownSecrets) sanitized = sanitized.replaceAll(secret, REDACTED_VALUE);
    return sanitized;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, undefined, key, seen, knownSecrets));
  }
  if (value instanceof Error) {
    return { name: value.name, message: REDACTED_VALUE };
  }
  if (value instanceof Date) return value.toISOString();
  if (!isPlainRecord(value)) return "[Unsupported object]";
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      sanitizeLogValue(child, childKey, key, seen, knownSecrets),
    ]),
  );
}

export function sanitizeStructuredLogValue(
  value: unknown,
  knownSecrets: Iterable<string> = [],
): unknown {
  const normalizedSecrets = [...new Set(knownSecrets)].filter((secret) => secret.length >= 6);
  return sanitizeLogValue(
    value,
    undefined,
    undefined,
    new WeakSet<object>(),
    normalizedSecrets,
  );
}
