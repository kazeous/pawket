import { randomUUID } from "node:crypto";
import { CreatorTipSettingsError, type createCreatorTipSettingsService } from "@pawket/catalog";
import { readTipBody, tipBodyRecord, tipJson, tipNetworkKey } from "./http-boundary.js";

type Actor = Readonly<{ userId: string; sessionId: string; primaryAuthenticatedAt: Date }>;
type Input = Readonly<{
  appBaseUrl: string; paymentsMode: "disabled" | "manual_only"; publishingMode: "disabled" | "general_audience"; lookupHmacKey: Uint8Array;
  authenticate(headers: Headers): Promise<Actor | null>;
  service: Pick<ReturnType<typeof createCreatorTipSettingsService>, "getOwnSettings" | "saveOwnSettings">;
  throttle(command: { actorUserId: string; networkKeyHash: string; operation: "read" | "save" }): Promise<boolean>;
}>;
function failure(error: unknown) {
  if (error instanceof CreatorTipSettingsError) {
    const mapping = { NOT_FOUND: [404, "not_available"], NOT_AVAILABLE: [404, "not_available"], PAYMENTS_DISABLED: [503, "payments_disabled"],
      RECENT_AUTH_REQUIRED: [403, "recent_auth_required"], INVALID_REQUEST: [400, "invalid_request"], INVALID_POLICY: [503, "dependency_unavailable"],
      VERSION_CONFLICT: [409, "version_conflict"], IDEMPOTENCY_CONFLICT: [409, "idempotency_conflict"] } as const;
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
        return tipJson(200, { settings: await input.service.getOwnSettings(actor.userId), paymentsEnabled: input.paymentsMode === "manual_only", publishingEnabled: input.publishingMode === "general_audience" });
      } catch (error) { return failure(error); }
    },
    async save(request: Request) {
      const denied = preflight(request, "POST"); if (denied) return denied;
      try {
        const actor = await authorize(request, "save"); if (actor instanceof Response) return actor;
        const key = request.headers.get("idempotency-key");
        if (!key || !/^[A-Za-z0-9._-]{8,200}$/u.test(key)) return tipJson(400, { code: "invalid_request" });
        const body = await readTipBody(request); if ("status" in body) return tipJson(body.status, { code: "invalid_request" });
        const value = tipBodyRecord(body.value, ["expectedRevision", "enabled", "presetsVnd"]);
        if (!value || typeof value.enabled !== "boolean" || typeof value.expectedRevision !== "number" || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= 2_147_483_647 ||
          !Array.isArray(value.presetsVnd) || value.presetsVnd.length !== 3 || value.presetsVnd.some((v) => typeof v !== "number" || !Number.isSafeInteger(v))) return tipJson(400, { code: "invalid_request" });
        return tipJson(200, { settings: await input.service.saveOwnSettings({ actor, expectedRevision: value.expectedRevision, enabled: value.enabled, presetsVnd: value.presetsVnd, idempotencyKey: key, requestId: randomUUID() }) });
      } catch (error) { return failure(error); }
    },
  };
}
