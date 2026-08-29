import { randomUUID } from "node:crypto";

import {
  CatalogServiceError,
  type CatalogActor,
  type CatalogWorkspace,
  type PublishResult,
  type UnpublishResult,
} from "./catalog-service.js";
import {
  DISCIPLINES,
  normalizeExternalDestination,
  normalizeHandle,
  normalizeProfileText,
} from "./catalog-policy.js";

const MAX_BODY_BYTES = 32_768;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type Session = CatalogActor;

type CatalogService = {
  initialize(command: { userId: string; requestId: string }): Promise<CatalogWorkspace>;
  getWorkspace(command: { actorUserId: string; pageId: string }): Promise<CatalogWorkspace>;
  saveDraft(command: Record<string, unknown>): Promise<unknown>;
  claimHandle(command: Record<string, unknown>): Promise<unknown>;
  renameHandle(command: Record<string, unknown>): Promise<unknown>;
  upsertShowcase(command: Record<string, unknown>): Promise<unknown>;
  removeShowcase(command: Record<string, unknown>): Promise<unknown>;
  reorderShowcases(command: Record<string, unknown>): Promise<unknown>;
  publish(command: Record<string, unknown>): Promise<unknown>;
  unpublish(command: Record<string, unknown>): Promise<unknown>;
};

export type CatalogHttpHandlers = Readonly<{
  workspace(request: Request): Promise<Response>;
  saveDraft(request: Request): Promise<Response>;
  handle(request: Request): Promise<Response>;
  showcases(request: Request): Promise<Response>;
  publish(request: Request): Promise<Response>;
  unpublish(request: Request): Promise<Response>;
}>;

type Input = Readonly<{
  trustedOrigins: readonly string[];
  authenticate(headers: Headers): Promise<Session | null>;
  service: CatalogService;
  publishingMode: "disabled" | "general_audience";
  onEvent?: (event: Readonly<Record<string, unknown>>) => void;
}>;

const SAFE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: SAFE_HEADERS,
  });
}

function event(input: Input, operation: string, status: number, code?: string): void {
  if (!input.onEvent) return;
  try {
    input.onEvent(code ? { operation, status, code } : { operation, status });
  } catch {
    // Telemetry must never alter the command response.
  }
}

function resultResponse(input: Input, operation: string, payload: Record<string, unknown>): Response {
  const response = json(200, payload);
  event(input, operation, response.status);
  return response;
}

function failureResponse(input: Input, operation: string, error: unknown): Response {
  let status = 503;
  let code = "CATALOG_UNAVAILABLE";
  if (error instanceof CatalogServiceError) {
    const mapping: Record<CatalogServiceError["code"], { status: number; code: string }> = {
      NOT_FOUND: { status: 404, code: "NOT_FOUND" },
      VERSION_CONFLICT: { status: 409, code: "VERSION_CONFLICT" },
      IDEMPOTENCY_CONFLICT: { status: 409, code: "IDEMPOTENCY_CONFLICT" },
      HANDLE_UNAVAILABLE: { status: 409, code: "HANDLE_UNAVAILABLE" },
      RECENT_AUTH_REQUIRED: { status: 403, code: "RECENT_AUTH_REQUIRED" },
      RENAME_COOLDOWN: { status: 409, code: "RENAME_COOLDOWN" },
      POLICY_VIOLATION: { status: 400, code: "POLICY_VIOLATION" },
      PUBLISHING_DISABLED: { status: 503, code: "PUBLISHING_DISABLED" },
    };
    ({ status, code } = mapping[error.code]);
  } else if (error && typeof error === "object" && "code" in error && error.code === "PUBLISHING_DISABLED") {
    status = 503;
    code = "PUBLISHING_DISABLED";
  }
  const response = json(status, { code });
  event(input, operation, status, code);
  return response;
}

function invalid(input: Input, operation: string, status = 400, code = "INVALID_REQUEST"): Response {
  const response = json(status, { code });
  event(input, operation, status, code);
  return response;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) return null;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return null;
  if (keys.length < required.length || keys.length > required.length + optional.length) return null;
  return value as Record<string, unknown>;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function discipline(value: unknown): boolean {
  return typeof value === "string" && (DISCIPLINES as readonly string[]).includes(value);
}

function validText(value: unknown, min: number, max: number): boolean {
  try {
    normalizeProfileText(value, { minCodePoints: min, maxCodePoints: max });
    return true;
  } catch {
    return false;
  }
}

function validDraft(value: unknown): value is Record<string, unknown> {
  const draft = exactRecord(value, ["displayName", "introduction", "primaryDiscipline", "secondaryDisciplines", "avatarAssetId", "coverAssetId"]);
  if (!draft || !validText(draft.displayName, 1, 80) || !validText(draft.introduction, 1, 500)) return false;
  if (!discipline(draft.primaryDiscipline) || !Array.isArray(draft.secondaryDisciplines) || draft.secondaryDisciplines.length > 2) return false;
  const secondary = draft.secondaryDisciplines;
  if (!secondary.every(discipline) || new Set(secondary).size !== secondary.length || secondary.includes(draft.primaryDiscipline)) return false;
  return (draft.avatarAssetId === null || uuid(draft.avatarAssetId)) && (draft.coverAssetId === null || uuid(draft.coverAssetId));
}

function validShowcase(value: unknown): value is Record<string, unknown> {
  const showcase = exactRecord(value, ["position", "title", "description", "discipline", "contentLabel", "externalUrl", "media"], ["id"]);
  if (!showcase || (showcase.id !== undefined && !uuid(showcase.id))) return false;
  if (!Number.isSafeInteger(showcase.position) || (showcase.position as number) < 0 || (showcase.position as number) > 11) return false;
  if (!validText(showcase.title, 1, 100) || !validText(showcase.description, 0, 1_000)) return false;
  if (!discipline(showcase.discipline) || showcase.contentLabel !== "general_audience" || !Array.isArray(showcase.media) || showcase.media.length > 4) return false;
  if (showcase.externalUrl !== null && typeof showcase.externalUrl !== "string") return false;
  if (showcase.externalUrl !== null) {
    try { normalizeExternalDestination(showcase.externalUrl); } catch { return false; }
  }
  return showcase.media.every((item) => {
    const media = exactRecord(item, ["assetId", "alternativeText"]);
    return Boolean(media && uuid(media.assetId) && validText(media.alternativeText, 1, 300));
  });
}

function validMediaActionBody(value: unknown, action: "upsert" | "remove" | "reorder"): Record<string, unknown> | null {
  if (action === "upsert") {
    const body = exactRecord(value, ["pageId", "action", "showcase"]);
    return body && body.action === action && uuid(body.pageId) && validShowcase(body.showcase) ? body : null;
  }
  if (action === "remove") {
    const body = exactRecord(value, ["pageId", "action", "showcaseId"]);
    return body && body.action === action && uuid(body.pageId) && uuid(body.showcaseId) ? body : null;
  }
  const body = exactRecord(value, ["pageId", "action", "showcaseIds"]);
  if (!body || body.action !== action || !uuid(body.pageId) || !Array.isArray(body.showcaseIds) || body.showcaseIds.length > 12) return null;
  return new Set(body.showcaseIds).size === body.showcaseIds.length && body.showcaseIds.every(uuid) ? body : null;
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

function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id");
  return candidate && REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

function expectedVersion(request: Request): number | null {
  const value = request.headers.get("if-match");
  if (!value || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

type BodyResult = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too_large" };

async function readBody(request: Request): Promise<BodyResult> {
  const stream = request.body;
  if (!stream) return { kind: "invalid" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return { kind: "invalid" };
      }
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return { kind: "too_large" };
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    try { await reader.cancel(); } catch { /* best effort */ }
    return { kind: "invalid" };
  }
}

async function authenticated(input: Input, request: Request): Promise<Session | Response> {
  try {
    const actor = await input.authenticate(request.headers);
    if (!actor) return invalid(input, "authenticate", 401, "AUTHENTICATION_REQUIRED");
    if (typeof actor.userId !== "string" || actor.userId.length === 0 || actor.userId.length > 200 || typeof actor.sessionId !== "string" || actor.sessionId.length === 0 || actor.sessionId.length > 200 || !(actor.primaryAuthenticatedAt instanceof Date) || Number.isNaN(actor.primaryAuthenticatedAt.getTime())) {
      return invalid(input, "authenticate", 503, "CATALOG_UNAVAILABLE");
    }
    return actor;
  } catch {
    return invalid(input, "authenticate", 503, "CATALOG_UNAVAILABLE");
  }
}

async function mutationControls(input: Input, request: Request, operation: string): Promise<{ actor: Session; expectedVersion: number; idempotencyKey: string; requestId: string } | Response> {
  if (request.method !== "POST") return invalid(input, operation, 405, "METHOD_NOT_ALLOWED");
  const origin = request.headers.get("origin");
  if (!origin || !input.trustedOrigins.includes(origin)) return invalid(input, operation, 403, "UNTRUSTED_ORIGIN");
  const actor = await authenticated(input, request);
  if (actor instanceof Response) return actor;
  if (!contentTypeAllowed(request.headers.get("content-type"))) return invalid(input, operation, 415, "UNSUPPORTED_MEDIA_TYPE");
  const key = request.headers.get("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) return invalid(input, operation);
  const rawVersion = request.headers.get("if-match");
  if (rawVersion === null) return invalid(input, operation, 428, "PRECONDITION_REQUIRED");
  const version = expectedVersion(request);
  if (version === null) return invalid(input, operation);
  return { actor, expectedVersion: version, idempotencyKey: key, requestId: requestId(request) };
}

function baseCommand(controls: { actor: Session; expectedVersion: number; idempotencyKey: string; requestId: string }, pageId: string): Record<string, unknown> {
  return { actor: controls.actor, pageId, expectedVersion: controls.expectedVersion, idempotencyKey: controls.idempotencyKey, requestId: controls.requestId };
}

function projectCommand(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("invalid service result");
  const result = value as Record<string, unknown>;
  return { pageId: result.pageId, draftVersion: result.draftVersion };
}

function projectPublication(value: PublishResult | UnpublishResult): Record<string, unknown> {
  if ("revisionId" in value) {
    return {
      pageId: value.pageId,
      revisionId: value.revisionId,
      revisionNumber: value.revisionNumber,
      canonicalHandle: value.canonicalHandle,
      draftVersion: value.draftVersion,
      publishedAt: value.publishedAt.toISOString(),
    };
  }
  return {
    pageId: value.pageId,
    previousPublishedRevisionId: value.previousPublishedRevisionId,
    draftVersion: value.draftVersion,
    unpublishedAt: value.unpublishedAt.toISOString(),
  };
}

function projectWorkspace(workspace: CatalogWorkspace, publishingMode: Input["publishingMode"]): Record<string, unknown> {
  const sourceDraft = workspace.draft;
  const sourceShowcases = workspace.showcases;
  const enforcement = workspace.enforcement;
  const heldShowcaseIds = enforcement.heldShowcaseIds.slice(0, 12);
  const safeDraft = {
    displayName: sourceDraft.displayName,
    introduction: sourceDraft.introduction,
    primaryDiscipline: sourceDraft.primaryDiscipline,
    secondaryDisciplines: sourceDraft.secondaryDisciplines,
    avatarAssetId: sourceDraft.avatarAssetId,
    coverAssetId: sourceDraft.coverAssetId,
  };
  const safeShowcases = sourceShowcases.slice(0, 12).map((item) => {
    const showcase = item;
    const media = showcase.media.slice(0, 4).map((image) => ({ assetId: image.assetId, alternativeText: image.alternativeText, position: image.position }));
    return {
      id: showcase.id,
      position: showcase.position,
      title: showcase.title,
      description: showcase.description,
      discipline: showcase.discipline,
      contentLabel: showcase.contentLabel,
      externalUrl: showcase.externalUrl,
      media,
    };
  });
  const renameAvailableAt = workspace.renameAvailableAt?.toISOString() ?? null;
  return {
    pageId: workspace.pageId,
    draftVersion: workspace.draftVersion,
    publishedRevisionId: workspace.publishedRevisionId,
    canonicalHandle: workspace.canonicalHandle,
    aliases: workspace.aliases.slice(0, 30),
    renameAvailableAt,
    draft: safeDraft,
    showcases: safeShowcases,
    status: {
      capabilityState: workspace.capabilityState,
      publishingMode,
      pageHeld: enforcement.pageHeld,
      heldShowcaseIds,
    },
  };
}

function bodyInvalid(input: Input, operation: string, body: BodyResult): Response | null {
  if (body.kind === "too_large") return invalid(input, operation, 413, "REQUEST_TOO_LARGE");
  if (body.kind === "invalid") return invalid(input, operation);
  return null;
}

export function createCatalogHttpHandlers(input: Input): CatalogHttpHandlers {
  async function workspace(request: Request): Promise<Response> {
    const operation = "workspace";
    if (request.method !== "GET") return invalid(input, operation, 405, "METHOD_NOT_ALLOWED");
    const actor = await authenticated(input, request);
    if (actor instanceof Response) return actor;
    try {
      const value = await input.service.initialize({ userId: actor.userId, requestId: requestId(request) });
      return resultResponse(input, operation, { workspace: projectWorkspace(value, input.publishingMode) });
    } catch (error) {
      return failureResponse(input, operation, error);
    }
  }

  async function saveDraft(request: Request): Promise<Response> {
    const operation = "saveDraft";
    const controls = await mutationControls(input, request, operation);
    if (controls instanceof Response) return controls;
    const body = await readBody(request);
    const early = bodyInvalid(input, operation, body);
    if (early) return early;
    if (body.kind !== "ok") return invalid(input, operation);
    const value = exactRecord(body.value, ["pageId", "draft"]);
    if (!value || !uuid(value.pageId) || !validDraft(value.draft)) return invalid(input, operation);
    try { return resultResponse(input, operation, { result: projectCommand(await input.service.saveDraft({ ...baseCommand(controls, value.pageId), draft: value.draft })) }); }
    catch (error) { return failureResponse(input, operation, error); }
  }

  async function handle(request: Request): Promise<Response> {
    const operation = "handle";
    const controls = await mutationControls(input, request, operation);
    if (controls instanceof Response) return controls;
    const body = await readBody(request);
    const early = bodyInvalid(input, operation, body);
    if (early) return early;
    if (body.kind !== "ok") return invalid(input, operation);
    const value = exactRecord(body.value, ["pageId", "action", "handle"]);
    if (!value || !uuid(value.pageId) || (value.action !== "claim" && value.action !== "rename")) return invalid(input, operation);
    try { normalizeHandle(value.handle); } catch { return invalid(input, operation); }
    try {
      const command = { ...baseCommand(controls, value.pageId), handle: value.handle };
      const result = value.action === "claim" ? await input.service.claimHandle(command) : await input.service.renameHandle(command);
      return resultResponse(input, operation, { result: projectCommand(result) });
    } catch (error) { return failureResponse(input, operation, error); }
  }

  async function showcases(request: Request): Promise<Response> {
    const operation = "showcases";
    const controls = await mutationControls(input, request, operation);
    if (controls instanceof Response) return controls;
    const body = await readBody(request);
    const early = bodyInvalid(input, operation, body);
    if (early) return early;
    if (body.kind !== "ok") return invalid(input, operation);
    if (!body.value || typeof body.value !== "object") return invalid(input, operation);
    const action = (body.value as Record<string, unknown>).action;
    if (action !== "upsert" && action !== "remove" && action !== "reorder") return invalid(input, operation);
    const value = validMediaActionBody(body.value, action);
    if (!value) return invalid(input, operation);
    try {
      const command = baseCommand(controls, value.pageId as string);
      const result = action === "upsert"
        ? await input.service.upsertShowcase({ ...command, showcase: value.showcase })
        : action === "remove"
          ? await input.service.removeShowcase({ ...command, showcaseId: value.showcaseId })
          : await input.service.reorderShowcases({ ...command, showcaseIds: value.showcaseIds });
      return resultResponse(input, operation, { result: projectCommand(result) });
    } catch (error) { return failureResponse(input, operation, error); }
  }

  async function publication(request: Request, operation: "publish" | "unpublish"): Promise<Response> {
    const controls = await mutationControls(input, request, operation);
    if (controls instanceof Response) return controls;
    const body = await readBody(request);
    const early = bodyInvalid(input, operation, body);
    if (early) return early;
    if (body.kind !== "ok") return invalid(input, operation);
    const value = exactRecord(body.value, ["pageId"]);
    if (!value || !uuid(value.pageId)) return invalid(input, operation);
    try {
      const result = operation === "publish"
        ? await input.service.publish(baseCommand(controls, value.pageId))
        : await input.service.unpublish(baseCommand(controls, value.pageId));
      return resultResponse(input, operation, { result: projectPublication(result as PublishResult | UnpublishResult) });
    } catch (error) { return failureResponse(input, operation, error); }
  }

  return {
    workspace,
    saveDraft,
    handle,
    showcases,
    publish: (request) => publication(request, "publish"),
    unpublish: (request) => publication(request, "unpublish"),
  };
}
