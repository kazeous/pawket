import { randomUUID } from "node:crypto";

const MAX_BODY_BYTES = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PURPOSES = ["avatar", "cover", "showcase"] as const;
const FORMATS = ["jpeg", "png", "webp"] as const;
const MIME_BY_FORMAT = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;

type MediaPurpose = (typeof PURPOSES)[number];
type SourceFormat = (typeof FORMATS)[number];
type Session = Readonly<{ userId: string; sessionId: string; primaryAuthenticatedAt: Date }>;
type MediaService = Readonly<{
  createUploadIntent(command: Readonly<{
    actor: Readonly<{ userId: string }>;
    purpose: MediaPurpose;
    declaredSourceFormat: SourceFormat;
    contentType: string;
    declaredBytes: number;
    idempotencyKey: string;
    requestId: string;
  }>): Promise<unknown>;
  completeUpload(command: Readonly<{
    actor: Readonly<{ userId: string }>;
    assetId: string;
    intentId: string;
    idempotencyKey: string;
    requestId: string;
  }>): Promise<unknown>;
}>;

type Input = Readonly<{
  appBaseUrl: string;
  authenticate(headers: Headers): Promise<Session | null>;
  media: MediaService;
}>;

export type MediaCommandHttpHandlers = Readonly<{
  createUpload(request: Request): Promise<Response>;
  completeUpload(request: Request, intentId: string): Promise<Response>;
}>;

type Controls = Readonly<{ actor: Readonly<{ userId: string }>; idempotencyKey: string; requestId: string }>;
type BodyResult = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too_large" };

const headers = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

function contentTypeAllowed(value: string | null): boolean {
  if (value === null) return false;
  const parts = value.split(";");
  if (parts.shift()!.trim().toLowerCase() !== "application/json") return false;
  let charsetSeen = false;
  for (const part of parts) {
    const match = /^\s*charset\s*=\s*([^\s;]+)\s*$/iu.exec(part);
    if (!match || charsetSeen || match[1]!.toLowerCase() !== "utf-8") return false;
    charsetSeen = true;
  }
  return true;
}

async function readBody(request: Request): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) return { kind: "invalid" };
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0) return { kind: "invalid" };
    if (value > MAX_BODY_BYTES) return { kind: "too_large" };
  }
  if (!request.body) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { kind: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { kind: "invalid" };
  } finally {
    try { reader.releaseLock(); } catch { /* already cancelled */ }
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return null;
  return value as Record<string, unknown>;
}

function failure(error: unknown): Response {
  let code: unknown;
  try { code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : null; }
  catch { code = null; }
  const mapping: Record<string, { status: number; responseCode: string }> = {
    INVALID_INPUT: { status: 400, responseCode: "INVALID_REQUEST" },
    UPLOAD_CONTENT_INVALID: { status: 400, responseCode: "UPLOAD_CONTENT_INVALID" },
    MEDIA_NOT_OWNER: { status: 403, responseCode: "MEDIA_NOT_OWNER" },
    MEDIA_NOT_FOUND: { status: 404, responseCode: "MEDIA_NOT_FOUND" },
    MEDIA_QUOTA_EXCEEDED: { status: 409, responseCode: "MEDIA_QUOTA_EXCEEDED" },
    IDEMPOTENCY_CONFLICT: { status: 409, responseCode: "IDEMPOTENCY_CONFLICT" },
    UPLOAD_EXPIRED: { status: 409, responseCode: "UPLOAD_EXPIRED" },
    UPLOAD_NOT_READY: { status: 409, responseCode: "UPLOAD_NOT_READY" },
    PUBLISHING_DISABLED: { status: 503, responseCode: "PUBLISHING_DISABLED" },
    STORAGE_ERROR: { status: 503, responseCode: "MEDIA_UNAVAILABLE" },
    STORAGE_UNAVAILABLE: { status: 503, responseCode: "MEDIA_UNAVAILABLE" },
  };
  const mapped = typeof code === "string" ? mapping[code] : undefined;
  return json(mapped?.status ?? 503, { code: mapped?.responseCode ?? "MEDIA_UNAVAILABLE" });
}

export function createMediaCommandHttpHandlers(input: Input): MediaCommandHttpHandlers {
  const appOrigin = new URL(input.appBaseUrl).origin;

  async function controls(request: Request): Promise<Controls | Response> {
    if (request.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" });
    if (request.headers.get("origin") !== appOrigin) return json(403, { code: "UNTRUSTED_ORIGIN" });
    if (!contentTypeAllowed(request.headers.get("content-type"))) return json(415, { code: "UNSUPPORTED_MEDIA_TYPE" });
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) return json(400, { code: "INVALID_REQUEST" });
    let session: Session | null;
    try { session = await input.authenticate(request.headers); }
    catch { return json(503, { code: "MEDIA_UNAVAILABLE" }); }
    if (!session) return json(401, { code: "AUTHENTICATION_REQUIRED" });
    const candidate = request.headers.get("x-request-id");
    return {
      actor: { userId: session.userId },
      idempotencyKey,
      requestId: candidate && REQUEST_ID.test(candidate) ? candidate : randomUUID(),
    };
  }

  return {
    async createUpload(request) {
      const resolved = await controls(request);
      if (resolved instanceof Response) return resolved;
      const body = await readBody(request);
      if (body.kind === "too_large") return json(413, { code: "REQUEST_TOO_LARGE" });
      if (body.kind !== "ok") return json(400, { code: "INVALID_REQUEST" });
      const value = exactRecord(body.value, ["purpose", "declaredSourceFormat", "contentType", "declaredBytes"]);
      if (!value || !PURPOSES.includes(value.purpose as MediaPurpose) || !FORMATS.includes(value.declaredSourceFormat as SourceFormat) || value.contentType !== MIME_BY_FORMAT[value.declaredSourceFormat as SourceFormat] || !Number.isSafeInteger(value.declaredBytes) || (value.declaredBytes as number) < 1 || (value.declaredBytes as number) > 10 * 1024 * 1024) {
        return json(400, { code: "INVALID_REQUEST" });
      }
      try {
        const result = await input.media.createUploadIntent({
          ...resolved,
          purpose: value.purpose as MediaPurpose,
          declaredSourceFormat: value.declaredSourceFormat as SourceFormat,
          contentType: value.contentType as string,
          declaredBytes: value.declaredBytes as number,
        });
        return json(200, { result });
      } catch (error) { return failure(error); }
    },

    async completeUpload(request, intentId) {
      const resolved = await controls(request);
      if (resolved instanceof Response) return resolved;
      if (!UUID.test(intentId)) return json(400, { code: "INVALID_REQUEST" });
      const body = await readBody(request);
      if (body.kind === "too_large") return json(413, { code: "REQUEST_TOO_LARGE" });
      if (body.kind !== "ok") return json(400, { code: "INVALID_REQUEST" });
      const value = exactRecord(body.value, ["assetId"]);
      if (!value || typeof value.assetId !== "string" || !UUID.test(value.assetId)) return json(400, { code: "INVALID_REQUEST" });
      try {
        const result = await input.media.completeUpload({
          ...resolved,
          assetId: value.assetId,
          intentId,
        });
        return json(200, { result });
      } catch (error) { return failure(error); }
    },
  };
}
