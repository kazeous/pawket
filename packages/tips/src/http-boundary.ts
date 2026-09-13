import { isIP } from "node:net";
import { createLookupHmac } from "@pawket/security";

export const TIP_PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "content-type": "application/json; charset=utf-8",
};
export function tipJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: TIP_PRIVATE_HEADERS });
}
export const tipReference = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^PW[A-F0-9]{20}$/u.test(v);
export const tipSecret = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9_-]{43}$/u.test(v);
export const TIP_GUEST_CONTEXT_COOKIE = "__Host-pawket_tip_create";
export const tipReceiptCookieName = (reference: string) => `__Secure-pawket_tip_${reference}`;

// Trust only the proxy-overwritten x-real-ip contract already used by Trust.
// Client-controlled forwarded chains are never an alternative source.
export function tipNetworkKey(headers: Headers, key: Uint8Array): string | null {
  const value = headers.get("x-real-ip");
  if (!value || value.length > 64 || value.trim() !== value || value.includes("%")) return null;
  const version = isIP(value); if (!version) return null;
  let normalized = version === 4 ? value : new URL(`http://[${value}]/`).hostname;
  const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/u.exec(normalized);
  if (mapped) { const first = parseInt(mapped[1]!, 16); const second = parseInt(mapped[2]!, 16); normalized = `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`; }
  return createLookupHmac({ key, context: "tip-network", value: normalized });
}

export function tipCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie"); if (!raw || raw.length > 16_384) return null;
  const values = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return tipSecret(value) ? value : null;
}
export function tipCookieHeader(name: string, secret: string, path: string, expiresAt: Date): string {
  return `${name}=${secret}; Path=${path}; Expires=${expiresAt.toUTCString()}; Secure; HttpOnly; SameSite=Strict`;
}
export function tipBodyRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) return null;
  return value as Record<string, unknown>;
}
export async function readTipBody(request: Request): Promise<{ value: unknown } | { status: 400 | 413 | 415 }> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) return { status: 415 };
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/u.test(declared) || !Number.isSafeInteger(Number(declared))) return { status: 400 };
    if (Number(declared) > 4096) return { status: 413 };
  }
  if (!request.body || request.headers.has("content-encoding")) return { status: 400 };
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 4096) { void reader.cancel().catch(() => undefined); return { status: 413 }; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch { return { status: 400 }; } finally { reader.releaseLock(); }
}
