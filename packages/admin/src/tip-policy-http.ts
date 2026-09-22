import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { createPlatformTipPolicyService } from "@pawket/catalog";
import { createLookupHmac } from "@pawket/security";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Input = Readonly<{
  appBaseUrl: string;
  lookupHmacKey: Uint8Array;
  paymentsMode: "disabled" | "manual_only";
  publishingMode: "disabled" | "general_audience";
  authenticate(headers: Headers): Promise<Actor | null>;
  authorizeOwner(headers: Headers): Promise<"authorized" | "forbidden" | "unauthenticated">;
  service: Pick<ReturnType<typeof createPlatformTipPolicyService>, "getPolicy" | "getHistory" | "savePolicy">;
  throttle(input: { actorUserId: string; networkKeyHash: string; operation: "read" | "save" }): Promise<boolean>;
}>;
const headers = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};
const json = (status: number, body: unknown) => Response.json(body, { status, headers });
const failureCodes = {
  INVALID_REQUEST: [400, "invalid_request"], FORBIDDEN: [403, "owner_required"],
  OWNER_STEP_UP_REQUIRED: [403, "owner_totp_required"], OWNER_TOTP_REQUIRED: [403, "owner_totp_required"],
  POLICY_UNAVAILABLE: [503, "policy_unavailable"], VERSION_CONFLICT: [409, "version_conflict"],
  IDEMPOTENCY_CONFLICT: [409, "idempotency_conflict"],
} as const;
function failure(error: unknown): Response {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (typeof code === "string" && Object.hasOwn(failureCodes, code)) {
    const [status, safeCode] = failureCodes[code as keyof typeof failureCodes];
    return json(status, { code: safeCode });
  }
  return json(503, { code: "dependency_unavailable" });
}

async function readBody(request: Request): Promise<{ value: unknown } | { status: number }> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) return { status: 415 };
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) return { status: 400 };
  if (declared !== null && Number(declared) > 4096) return { status: 413 };
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

export function createTipPolicyHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin;
  const key = new Uint8Array(input.lookupHmacKey);
  function preflight(request: Request, method: "GET" | "POST") {
    if (request.method !== method) return json(405, { code: "method_not_allowed" });
    const suppliedOrigin = request.headers.get("origin");
    if (request.headers.get("sec-fetch-site") === "cross-site" ||
      (method === "POST" ? suppliedOrigin !== origin : suppliedOrigin !== null && suppliedOrigin !== origin)) return json(403, { code: "untrusted_origin" });
    return null;
  }
  async function authorize(request: Request, operation: "read" | "save"): Promise<Actor | Response> {
    const permission = await input.authorizeOwner(request.headers);
    if (permission !== "authorized") return json(permission === "unauthenticated" ? 401 : 403, { code: permission === "unauthenticated" ? "authentication_required" : "owner_required" });
    const actor = await input.authenticate(request.headers);
    if (!actor) return json(401, { code: "authentication_required" });
    const ip = request.headers.get("x-real-ip");
    if (!ip || ip.length > 64 || ip.trim() !== ip || ip.includes("%") || !isIP(ip)) return json(503, { code: "dependency_unavailable" });
    let normalized = isIP(ip) === 4 ? ip : new URL(`http://[${ip}]/`).hostname;
    const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/u.exec(normalized);
    if (mapped) {
      const first = parseInt(mapped[1]!, 16); const second = parseInt(mapped[2]!, 16);
      normalized = `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
    }
    const networkKeyHash = createLookupHmac({ key, context: "owner-tip-policy-network", value: normalized });
    if (await input.throttle({ actorUserId: actor.userId, networkKeyHash, operation }) !== true) return json(429, { code: "rate_limited" });
    return actor;
  }
  return {
    async read(request: Request): Promise<Response> {
      const rejected = preflight(request, "GET"); if (rejected) return rejected;
      const query = new URL(request.url).searchParams;
      const before = query.get("beforeRevision");
      if ([...query.keys()].some((key) => key !== "beforeRevision") || query.getAll("beforeRevision").length > 1 ||
        (before !== null && (!/^[1-9]\d{0,9}$/u.test(before) || Number(before) > 2_147_483_647))) return json(400, { code: "invalid_request" });
      try {
        const actor = await authorize(request, "read"); if (actor instanceof Response) return actor;
        const [policy, history] = await Promise.all([
          input.service.getPolicy({ actor }),
          input.service.getHistory({ actor, ...(before === null ? {} : { beforeRevision: Number(before) }), limit: 25 }),
        ]);
        return json(200, { policy, history, paymentsEnabled: input.paymentsMode === "manual_only", publishingEnabled: input.publishingMode === "general_audience" });
      } catch (error) { return failure(error); }
    },
    async save(request: Request): Promise<Response> {
      const rejected = preflight(request, "POST"); if (rejected) return rejected;
      if (new URL(request.url).search) return json(400, { code: "invalid_request" });
      try {
        const actor = await authorize(request, "save"); if (actor instanceof Response) return actor;
        const idempotencyKey = request.headers.get("idempotency-key");
        if (!idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(idempotencyKey)) return json(400, { code: "invalid_request" });
        const body = await readBody(request); if ("status" in body) return json(body.status, { code: "invalid_request" });
        const value = body.value;
        const fields = ["expectedRevision", "minimumVnd", "maximumVnd", "allowedPresetsVnd", "reason"];
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
          Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) return json(400, { code: "invalid_request" });
        const v = value as Record<string, unknown>;
        if (typeof v.expectedRevision !== "number" || !Number.isSafeInteger(v.expectedRevision) || v.expectedRevision < 1 || v.expectedRevision >= 2_147_483_647 ||
          typeof v.minimumVnd !== "number" || !Number.isSafeInteger(v.minimumVnd) || v.minimumVnd < 10_000 ||
          typeof v.maximumVnd !== "number" || !Number.isSafeInteger(v.maximumVnd) || v.maximumVnd > 5_000_000 || v.maximumVnd < v.minimumVnd ||
          !Array.isArray(v.allowedPresetsVnd) || v.allowedPresetsVnd.length < 3 || v.allowedPresetsVnd.length > 10 ||
          new Set(v.allowedPresetsVnd).size !== v.allowedPresetsVnd.length || v.allowedPresetsVnd.some((a) => typeof a !== "number" || !Number.isSafeInteger(a) || a < (v.minimumVnd as number) || a > (v.maximumVnd as number)) ||
          typeof v.reason !== "string" || Array.from(v.reason.trim()).length < 3 || Array.from(v.reason.trim()).length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(v.reason)) return json(400, { code: "invalid_request" });
        const policy = await input.service.savePolicy({ actor, expectedRevision: v.expectedRevision, minimumVnd: v.minimumVnd, maximumVnd: v.maximumVnd,
          allowedPresetsVnd: v.allowedPresetsVnd, reason: v.reason.trim(), idempotencyKey, requestId: randomUUID() });
        return json(200, { policy });
      } catch (error) { return failure(error); }
    },
  };
}
