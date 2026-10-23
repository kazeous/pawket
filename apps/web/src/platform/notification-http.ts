import { z } from "zod";
import { NOTIFICATION_POLICY, OPTIONAL_EMAIL_CATEGORIES, NotificationError, type NotificationInbox } from "@pawket/notifications";
import { COMMISSION_PRIVATE_HEADERS, CommissionHttpFailure, commissionJson, readCommissionBody } from "./commission-http.js";

type Input = Readonly<{
  appBaseUrl: string;
  authenticate(headers: Headers): Promise<{ userId: string; sessionId: string } | null>;
  inbox: NotificationInbox;
}>;

const uuid = z.uuid();
// Exactly one target per request; a body naming two targets matches none of the strict shapes.
const readBody = z.union([
  z.strictObject({ ids: z.array(uuid).min(1).max(NOTIFICATION_POLICY.readBatchMax) }),
  z.strictObject({ all: z.literal(true) }),
  z.strictObject({ orderId: uuid }),
]);
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/u;
const preferenceBody = z.strictObject({ channel: z.literal("email"), category: z.enum(OPTIONAL_EMAIL_CATEGORIES), enabled: z.boolean() });
const fail = (status: number, code: string): never => { throw new CommissionHttpFailure(status, code); };

function failure(error: unknown): Response {
  if (error instanceof CommissionHttpFailure) return commissionJson(error.status, { code: error.code });
  if (error instanceof NotificationError) {
    if (error.code === "not_available") return commissionJson(404, { code: "not_available" });
    if (error.code === "invalid_request") return commissionJson(400, { code: "invalid_request" });
  }
  return commissionJson(503, { code: "dependency_unavailable" });
}

/** The viewer's own inbox: list, unread summary and mark-read. Disabled mode answers 404 on every route before anything else. */
export function createNotificationHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin;
  async function run(request: Request, method: "GET" | "POST" | "PUT", action: (userId: string) => Promise<Response>): Promise<Response> {
    try {
      if (input.inbox.mode !== "enabled") fail(404, "not_available");
      if (request.method !== method) fail(405, "method_not_allowed");
      const requestOrigin = request.headers.get("origin");
      if (request.headers.get("sec-fetch-site") === "cross-site" || ((method !== "GET" || requestOrigin !== null) && requestOrigin !== origin)) fail(403, "untrusted_origin");
      const actor = await input.authenticate(request.headers);
      if (!actor) fail(401, "unauthenticated");
      return await action(actor!.userId);
    } catch (error) { return failure(error); }
  }
  function noQuery(request: Request) { if (new URL(request.url).search) fail(400, "invalid_request"); }
  function cursorQuery(request: Request): string | null {
    const params = new URL(request.url).searchParams;
    for (const name of params.keys()) if (name !== "cursor" || params.getAll(name).length !== 1) fail(400, "invalid_request");
    const cursor = params.get("cursor");
    if (cursor !== null && !CURSOR.test(cursor)) fail(400, "invalid_request");
    return cursor;
  }
  return {
    list: (request: Request) => run(request, "GET", async (userId) => {
      const cursor = cursorQuery(request);
      return commissionJson(200, await input.inbox.list(userId, cursor));
    }),
    summary: (request: Request) => run(request, "GET", async (userId) => {
      noQuery(request);
      return commissionJson(200, await input.inbox.summary(userId));
    }),
    read: (request: Request) => run(request, "POST", async (userId) => {
      noQuery(request);
      const target = await readCommissionBody(request, readBody);
      await input.inbox.markRead(userId, target);
      return new Response(null, { status: 204, headers: COMMISSION_PRIVATE_HEADERS });
    }),
    preferences: (request: Request) => run(request, "GET", async (userId) => {
      noQuery(request); return commissionJson(200, await input.inbox.readPreferences(userId));
    }),
    setPreference: (request: Request) => run(request, "PUT", async (userId) => {
      noQuery(request); const preference = await readCommissionBody(request, preferenceBody);
      await input.inbox.setPreference(userId, { ...preference, at: new Date() });
      return new Response(null, { status: 204, headers: COMMISSION_PRIVATE_HEADERS });
    }),
  };
}
