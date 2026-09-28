import { OidcIdentityError, type createOidcCommandContext, type createOidcPendingCommandRepository,
  type OidcPendingPayload, type OidcSessionContext } from "@pawket/identity";
import type { PawketDatabase } from "@pawket/database";
import { oidcCommand } from "./oidc-command-registry.js";
import type { WebPlatformRuntime } from "./runtime.js";

const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (status: number, value: unknown) => Response.json(value, { status, headers });
const failure = (error: unknown) => json(error instanceof OidcIdentityError ? error.code === "rate_limited" ? 429 : 409 : 503,
  { code: error instanceof OidcIdentityError ? `OIDC_${error.code.toUpperCase()}` : "IDENTITY_UNAVAILABLE" });
async function body(request: Request): Promise<string | null> {
  if (request.headers.has("content-encoding")) return null;
  const clone = request.clone(); const reader = clone.body?.getReader(); if (!reader) return "";
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 65_536) return null; chunks.push(part.value); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { return null; } finally { void reader.cancel().catch(() => undefined); }
}

export function createOidcCommandHttp(options: {
  db: PawketDatabase; baseUrl: string;
  commands: ReturnType<typeof createOidcPendingCommandRepository>; context: ReturnType<typeof createOidcCommandContext>;
  authenticate: (headers: Headers, allowExpiredLease?: boolean) => Promise<OidcSessionContext | null>;
  runtime: () => WebPlatformRuntime; now?: () => Date;
  commandFor?: typeof oidcCommand;
}) {
  const origin = new URL(options.baseUrl).origin; const now = options.now ?? (() => new Date());
  const commandFor = options.commandFor ?? oidcCommand;
  const dispatched = new WeakSet<Request>();
  async function preserve(actor: OidcSessionContext, payload: OidcPendingPayload) {
    const command = await options.commands.prepare({ actor, payload, now: now() });
    return json(409, { code: "OIDC_STEP_UP_REQUIRED", reviewPath: command.reviewPath });
  }
  async function run(request: Request, execute: () => Promise<Response>): Promise<Response> {
    if (request.method !== "POST" || dispatched.has(request)) return execute();
    if (!/^\/api\/v1\/(?:admin\/|creator-application\/receiving-account$|creator\/tips\/|creator\/tip-settings$|(?:creator\/)?commissions(?:\/|$))/u.test(new URL(request.url).pathname)) return execute();
    try {
      const url = new URL(request.url); const raw = await body(request);
      if (raw === null) return json(413, { code: "INVALID_REQUEST" });
      let payload: OidcPendingPayload = { method: "POST", path: url.pathname, body: raw,
        idempotencyKey: request.headers.get("idempotency-key"), ifMatch: request.headers.get("if-match"), returnPath: "/" };
      const command = commandFor(payload); if (!command) return execute();
      if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return json(403, { code: "UNTRUSTED_ORIGIN" });
      if (url.search) return json(400, { code: "INVALID_REQUEST" });
      payload = { ...payload, returnPath: command.returnPath };
      const actor = await options.authenticate(request.headers, true);
      if (!actor) return json(401, { code: "AUTHENTICATION_REQUIRED" });
      const expectedActor = request.headers.get("x-pawket-actor");
      if (expectedActor !== null && expectedActor !== actor.userId) return json(409, { code: "OIDC_ACTOR_CHANGED" });
      if (command.policy.actionClass.startsWith("owner.") && !actor.owner) return json(403, { code: "OWNER_REQUIRED" });
      if (actor.leaseRequired || !await options.db.transaction((tx) => options.context.ready(tx, { actor, payload, policy: command.policy }))) return preserve(actor, payload);
      let response: Response;
      try { response = await options.context.run({ actor, payload, policy: command.policy }, execute); }
      catch (error) {
        if (error instanceof OidcIdentityError && error.code === "assurance_required") return preserve(actor, payload);
        throw error;
      }
      // A service may encounter a shorter configured freshness window or a lease
      // that expires behind its domain locks. Preserve the bytes after rollback.
      if (!response.ok) {
        const value: unknown = await response.clone().json().catch(() => null);
        const code = value && typeof value === "object" && "code" in value ? value.code : null;
        if (typeof code === "string" && ["recent_auth_required", "totp_required", "owner_totp_required", "owner_step_up_required"].includes(code.toLowerCase())) return preserve(actor, payload);
      }
      return response;
    } catch (error) { return failure(error); }
  }
  return {
    run,
    wrap<T extends object>(handlers: T): T {
      return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, typeof handler === "function"
        ? (request: Request, ...args: unknown[]) => run(request, () => Reflect.apply(handler, handlers, [request, ...args]) as Promise<Response>)
        : handler])) as T;
    },
    async review(request: Request, id: string): Promise<Response> {
      if (request.method !== "GET") return json(405, { code: "METHOD_NOT_ALLOWED" });
      try {
        const actor = await options.authenticate(request.headers, true); if (!actor) return json(401, { code: "AUTHENTICATION_REQUIRED" });
        if (actor.leaseRequired) return json(401, { code: "OIDC_LEASE_REQUIRED" });
        const saved = await options.commands.review({ actor, id, now: now() }); const command = commandFor(saved.payload);
        if (!command) return json(409, { code: "OIDC_TRANSACTION_EXPIRED" });
        return json(200, { title: command.title, body: saved.payload.body, returnPath: saved.payload.returnPath,
          ready: saved.ready && !actor.leaseRequired, expiresAt: saved.expiresAt.toISOString() });
      } catch (error) { return failure(error); }
    },
    async cancel(request: Request, id: string): Promise<Response> {
      if (request.method !== "DELETE") return json(405, { code: "METHOD_NOT_ALLOWED" });
      if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return json(403, { code: "UNTRUSTED_ORIGIN" });
      try { const actor = await options.authenticate(request.headers, true); if (!actor) return json(401, { code: "AUTHENTICATION_REQUIRED" });
        await options.commands.cancel({ actor, id, now: now() }); return json(200, { cancelled: true });
      } catch (error) { return failure(error); }
    },
    async confirm(request: Request, id: string): Promise<Response> {
      if (request.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" });
      if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return json(403, { code: "UNTRUSTED_ORIGIN" });
      try {
        const actor = await options.authenticate(request.headers); if (!actor) return json(401, { code: "AUTHENTICATION_REQUIRED" });
        const saved = await options.commands.review({ actor, id, now: now() }); const command = commandFor(saved.payload);
        if (!saved.ready || !command) return json(409, { code: "OIDC_ASSURANCE_REQUIRED" });
        const replayHeaders = new Headers({ origin, "content-type": "application/json" });
        for (const name of ["cookie", "x-real-ip", "user-agent"]) { const value = request.headers.get(name); if (value) replayHeaders.set(name, value); }
        if (saved.payload.idempotencyKey) replayHeaders.set("idempotency-key", saved.payload.idempotencyKey);
        if (saved.payload.ifMatch) replayHeaders.set("if-match", saved.payload.ifMatch);
        const replay = new Request(new URL(saved.payload.path, origin), { method: saved.payload.method, headers: replayHeaders, body: saved.payload.body || undefined });
        dispatched.add(replay);
        try {
          return await options.context.run({ actor, payload: saved.payload, policy: command.policy, pendingId: id }, () => command.execute(options.runtime(), replay));
        } finally { dispatched.delete(replay); }
      } catch (error) { return failure(error); }
    },
  };
}
