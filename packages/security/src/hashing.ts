import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const domainPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const storedTokenHashPattern = /^sha256:v1:[A-Za-z0-9_-]{43}$/;
const MAX_HASH_INPUT_BYTES = 8_192;

export class SecurityHashingError extends Error {
  constructor() {
    super("Security hashing operation failed");
    this.name = "SecurityHashingError";
  }
}

function assertDomain(domain: string): void {
  if (!domainPattern.test(domain)) throw new SecurityHashingError();
}

function assertBoundedInput(value: string): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_HASH_INPUT_BYTES) {
    throw new SecurityHashingError();
  }
}

function digestValue(domain: string, value: string): Buffer {
  assertDomain(domain);
  assertBoundedInput(value);
  return createHash("sha256")
    .update(`pawket-token:v1:${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest();
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function hashOpaqueToken(token: string, purpose: string): string {
  return `sha256:v1:${digestValue(purpose, token).toString("base64url")}`;
}

export function verifyOpaqueTokenHash(input: {
  storedHash: string;
  candidateToken: string;
  purpose: string;
}): boolean {
  if (!storedTokenHashPattern.test(input.storedHash)) return false;
  const expected = hashOpaqueToken(input.candidateToken, input.purpose);
  return constantTimeEqual(
    Buffer.from(input.storedHash, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

export function createLookupHmac(input: {
  value: string;
  context: string;
  key: Uint8Array;
}): string {
  assertDomain(input.context);
  assertBoundedInput(input.value);
  if (input.key.byteLength < 32) throw new SecurityHashingError();
  const digest = createHmac("sha256", input.key)
    .update(`pawket-lookup:v1:${input.context}\0`, "utf8")
    .update(input.value, "utf8")
    .digest("base64url");
  return `hmac-sha256:v1:${digest}`;
}
