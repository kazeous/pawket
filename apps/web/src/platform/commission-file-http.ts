import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CommissionFileError, type CommissionFileService } from "@pawket/commission-files";

import { COMMISSION_PRIVATE_HEADERS, CommissionHttpFailure, commissionJson, commissionNetworkKey, readCommissionBody } from "./commission-http.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Operation = "read" | "file_grant" | "file_command";
type Metric = "grant" | "complete" | "discard" | "download";
type Input = Readonly<{
  appBaseUrl: string; lookupHmacKey: Uint8Array; authenticate(headers: Headers): Promise<Actor | null>;
  throttle(command: { actorUserId: string; networkKeyHash: string; operation: Operation }): Promise<boolean>;
  files: CommissionFileService; onOperation?: (event: { operation: Metric; outcome: string }) => void;
}>;
const uuid = z.uuid();
const createUpload = z.strictObject({ context: z.literal("brief"), packageId: uuid, fileName: z.string().min(1).max(4096), declaredBytes: z.number().int() });
const empty = z.strictObject({});
function statusFor(code: string): number {
  if (code === "not_available") return 404;
  if (code === "authentication_required") return 401;
  if (code === "invalid_request" || code === "file_too_large" || code === "preview_not_allowed") return 400;
  if (code === "files_disabled" || code === "storage_unavailable" || code === "dependency_unavailable") return 503;
  return 409;
}
function noQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length) throw new CommissionHttpFailure(400, "invalid_request");
}

export function createCommissionFileHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  const report = (metric: Metric | null, outcome: string) => { if (!metric) return; try { input.onOperation?.({ operation: metric, outcome }); } catch { /* Telemetry cannot change results. */ } };
  async function run<T>(request: Request, method: "GET" | "POST", operation: Operation, metric: Metric | null,
    action: (actor: Actor) => Promise<T>, respond: (value: T) => Response = (value) => commissionJson(200, value)): Promise<Response> {
    try {
      if (request.method !== method) throw new CommissionHttpFailure(405, "method_not_allowed");
      if (request.headers.get("sec-fetch-site") === "cross-site" || (method === "POST" && request.headers.get("origin") !== origin)) throw new CommissionHttpFailure(403, "untrusted_origin");
      const actor = await input.authenticate(request.headers);
      if (!actor) throw new CommissionHttpFailure(401, "authentication_required");
      const network = commissionNetworkKey(request, key);
      if (await input.throttle({ actorUserId: actor.userId, networkKeyHash: network, operation }) !== true) throw new CommissionHttpFailure(429, "rate_limited");
      const response = respond(await action({ userId: actor.userId, sessionId: actor.sessionId }));
      report(metric, "accepted");
      return response;
    } catch (error) {
      const raw = error instanceof CommissionHttpFailure || error instanceof CommissionFileError ? error.code : "dependency_unavailable";
      const code = raw === "not_authorized" ? "authentication_required" : raw; // an expired or revoked session, never a hint about the file
      report(metric, code === "files_disabled" ? "disabled" : code === "rate_limited" ? "rate_limited" : code === "dependency_unavailable" || code === "storage_unavailable" ? "failed" : "rejected");
      return commissionJson(error instanceof CommissionHttpFailure ? error.status : statusFor(code), { code });
    }
  }
  return {
    createUpload: (request: Request) => run(request, "POST", "file_grant", "grant", async (actor) => {
      noQuery(request); const body = await readCommissionBody(request, createUpload);
      return { upload: await input.files.createUpload({ actor, ...body, idempotencyKey: request.headers.get("idempotency-key") ?? "", requestId: randomUUID() }) };
    }),
    status: (request: Request, fileId: string) => run(request, "GET", "read", null, async (actor) => {
      noQuery(request); return { file: await input.files.getFile({ actor, fileId }) };
    }),
    complete: (request: Request, fileId: string) => run(request, "POST", "file_command", "complete", async (actor) => {
      noQuery(request); await readCommissionBody(request, empty); return { file: await input.files.completeUpload({ actor, fileId, requestId: randomUUID() }) };
    }),
    discard: (request: Request, fileId: string) => run(request, "POST", "file_command", "discard", async (actor) => {
      noQuery(request); await readCommissionBody(request, empty); return { file: await input.files.discard({ actor, fileId }) };
    }),
    download: (request: Request, orderId: string, fileId: string) => run(request, "GET", "read", "download", async (actor) => {
      const params = new URL(request.url).searchParams; const disposition = params.get("disposition");
      if ([...params.keys()].some((name) => name !== "disposition") || params.getAll("disposition").length !== 1 || (disposition !== "attachment" && disposition !== "inline")) {
        throw new CommissionHttpFailure(400, "invalid_request");
      }
      return input.files.downloadGrant({ actor, orderId, fileId, disposition });
    }, (grant) => new Response(null, { status: 302, headers: { ...COMMISSION_PRIVATE_HEADERS, location: grant.url } })),
  };
}
