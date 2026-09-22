import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { CreatorTipSettingsError, readPlatformTipPolicySnapshot, type createCreatorTipSettingsService } from "@pawket/catalog";
import { readTipBody, tipBodyRecord, tipJson, tipNetworkKey } from "./http-boundary.js";

type Actor = Readonly<{ userId: string; sessionId: string; primaryAuthenticatedAt: Date }>;
type Input = Readonly<{
  appBaseUrl: string; paymentsMode: "disabled" | "manual_only"; publishingMode: "disabled" | "general_audience"; lookupHmacKey: Uint8Array;
  authenticate(headers: Headers): Promise<Actor | null>;
  service: Pick<ReturnType<typeof createCreatorTipSettingsService>, "getOwnSettings" | "saveOwnSettings">;
  throttle(command: { actorUserId: string; networkKeyHash: string; operation: "read" | "save" }): Promise<boolean>;
}>;
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
function readTriple(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== 4 || value.length !== 3) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: number[] = [];
  for (let index = 0; index < 3; index++) {
    const item = descriptors[String(index)];
    if (!item || !item.enumerable || !("value" in item) || !Number.isSafeInteger(item.value) || item.value < 10_000 || item.value > 5_000_000) return null;
    result.push(item.value as number);
  }
  return new Set(result).size === 3 ? result : null;
}
// Only the named private settings projection may cross HTTP. In particular,
// future Catalog fields or a malformed nested policy cannot leak through here.
function projectSettings(value: unknown, withAvailability: boolean): unknown {
  if (value === null && withAvailability) return null;
  const invalid = () => { throw new CreatorTipSettingsError("INVALID_POLICY"); };
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = ["revisionId", "revisionNumber", "enabled", "minimumVnd", "maximumVnd", "presetsVnd", "platformPolicyRevisionId", "effectivePolicy", "effectivePresetsVnd", "presetsFallback", ...(withAvailability ? ["available"] : [])];
  if (Reflect.ownKeys(value).length !== keys.length) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const safe: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    safe[key] = descriptor.value;
  }
  const policy = safe.effectivePolicy === null ? null : readPlatformTipPolicySnapshot(safe.effectivePolicy);
  const saved = readTriple(safe.presetsVnd);
  const effective = policy ? readTriple(safe.effectivePresetsVnd) : null;
  if ((safe.effectivePolicy !== null && !policy) || !saved ||
    (safe.revisionId !== null && !uuid(safe.revisionId)) || !Number.isSafeInteger(safe.revisionNumber) || (safe.revisionNumber as number) < 0 || (safe.revisionNumber as number) >= 2_147_483_647 ||
    (safe.revisionId === null) !== (safe.revisionNumber === 0) || typeof safe.enabled !== "boolean" || typeof safe.presetsFallback !== "boolean" ||
    (safe.platformPolicyRevisionId !== null && !uuid(safe.platformPolicyRevisionId)) || (safe.revisionId === null && safe.platformPolicyRevisionId !== null) ||
    !Number.isSafeInteger(safe.minimumVnd) || !Number.isSafeInteger(safe.maximumVnd) || (safe.minimumVnd as number) < 10_000 || (safe.maximumVnd as number) > 5_000_000 || (safe.minimumVnd as number) > (safe.maximumVnd as number) ||
    saved.some((amount) => amount < (safe.minimumVnd as number) || amount > (safe.maximumVnd as number)) ||
    (withAvailability && typeof safe.available !== "boolean")) return invalid();
  if (policy) {
    const fallback = !saved.every((amount) => policy.allowedPresetsVnd.includes(amount));
    const expected = fallback ? policy.allowedPresetsVnd.slice(0, 3) : saved;
    if (!effective || safe.presetsFallback !== fallback || effective.some((amount, index) => amount !== expected[index])) return invalid();
  } else if (safe.presetsFallback || safe.available || !Array.isArray(safe.effectivePresetsVnd) || nodeTypes.isProxy(safe.effectivePresetsVnd) || Reflect.ownKeys(safe.effectivePresetsVnd).length !== 1 || safe.effectivePresetsVnd.length !== 0) return invalid();
  return { ...safe, presetsVnd: saved, effectivePolicy: policy, effectivePresetsVnd: effective ?? [] };
}
function failure(error: unknown) {
  if (error instanceof CreatorTipSettingsError) {
    const mapping = { NOT_FOUND: [404, "not_available"], NOT_AVAILABLE: [404, "not_available"], PAYMENTS_DISABLED: [503, "payments_disabled"],
      RECENT_AUTH_REQUIRED: [403, "recent_auth_required"], INVALID_REQUEST: [400, "invalid_request"], INVALID_POLICY: [503, "dependency_unavailable"],
      POLICY_CHANGED: [409, "policy_changed"], VERSION_CONFLICT: [409, "version_conflict"], IDEMPOTENCY_CONFLICT: [409, "idempotency_conflict"] } as const;
    const [status, code] = mapping[error.code]; return tipJson(status, { code });
  }
  return tipJson(503, { code: "dependency_unavailable" });
}
export function createCreatorTipSettingsHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  function preflight(request: Request, method: "GET" | "POST") {
    if (request.method !== method) return tipJson(405, { code: "method_not_allowed" });
    if (method === "POST" && (input.paymentsMode !== "manual_only" || input.publishingMode !== "general_audience")) return tipJson(503, { code: "payments_disabled" });
    if (request.headers.get("sec-fetch-site") === "cross-site" || (method === "POST" && request.headers.get("origin") !== origin)) return tipJson(403, { code: "untrusted_origin" });
    if (new URL(request.url).search) return tipJson(400, { code: "invalid_request" });
    return null;
  }
  async function authorize(request: Request, operation: "read" | "save"): Promise<Actor | Response> {
    const actor = await input.authenticate(request.headers);
    if (!actor) return tipJson(401, { code: "authentication_required" });
    const networkKeyHash = tipNetworkKey(request.headers, key);
    if (!networkKeyHash) return tipJson(503, { code: "dependency_unavailable" });
    if (await input.throttle({ actorUserId: actor.userId, networkKeyHash, operation }) !== true) return tipJson(429, { code: "rate_limited" });
    return actor;
  }
  return {
    async read(request: Request) {
      const denied = preflight(request, "GET"); if (denied) return denied;
      try {
        const actor = await authorize(request, "read"); if (actor instanceof Response) return actor;
        return tipJson(200, { settings: projectSettings(await input.service.getOwnSettings(actor.userId), true), paymentsEnabled: input.paymentsMode === "manual_only", publishingEnabled: input.publishingMode === "general_audience" });
      } catch (error) { return failure(error); }
    },
    async save(request: Request) {
      const denied = preflight(request, "POST"); if (denied) return denied;
      try {
        const actor = await authorize(request, "save"); if (actor instanceof Response) return actor;
        const key = request.headers.get("idempotency-key");
        if (!key || !/^[A-Za-z0-9._-]{8,200}$/u.test(key)) return tipJson(400, { code: "invalid_request" });
        const body = await readTipBody(request); if ("status" in body) return tipJson(body.status, { code: "invalid_request" });
        const value = tipBodyRecord(body.value, ["expectedRevision", "expectedPolicyRevision", "enabled", "presetsVnd"]);
        if (!value || typeof value.enabled !== "boolean" || typeof value.expectedRevision !== "number" || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= 2_147_483_647 ||
          typeof value.expectedPolicyRevision !== "number" || !Number.isInteger(value.expectedPolicyRevision) || value.expectedPolicyRevision < 1 || value.expectedPolicyRevision > 2_147_483_647 ||
          !Array.isArray(value.presetsVnd) || value.presetsVnd.length !== 3 || value.presetsVnd.some((v) => typeof v !== "number" || !Number.isSafeInteger(v))) return tipJson(400, { code: "invalid_request" });
        return tipJson(200, { settings: projectSettings(await input.service.saveOwnSettings({ actor, expectedRevision: value.expectedRevision, expectedPolicyRevision: value.expectedPolicyRevision, enabled: value.enabled, presetsVnd: value.presetsVnd, idempotencyKey: key, requestId: randomUUID() }), false) });
      } catch (error) { return failure(error); }
    },
  };
}
