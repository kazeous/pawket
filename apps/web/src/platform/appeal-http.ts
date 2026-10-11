import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TrustEnforcementError, type AppealService } from "@pawket/trust";
import { CommissionHttpFailure, commissionJson, readCommissionBody } from "./commission-http.js";

type Input = { appBaseUrl: string; authenticate(headers: Headers): Promise<{ userId: string; sessionId: string } | null>;
  appeals: Pick<AppealService, "submit"> };
const bodySchema = z.strictObject({ target: z.union([z.strictObject({ penaltyId: z.uuid() }), z.strictObject({ hideId: z.uuid() })]), statement: z.string().max(16_000) });
function failure(error: unknown) {
  if (error instanceof CommissionHttpFailure) return commissionJson(error.status, { code: error.code });
  if (error instanceof TrustEnforcementError) return commissionJson(error.code === "not_available" ? 404 : error.code === "not_authorized" ? 403
    : ["enforcement_disabled", "dependency_unavailable"].includes(error.code) ? 503 : error.code.startsWith("invalid_") ? 400 : 409, { code: error.code });
  return commissionJson(503, { code: "dependency_unavailable" });
}
function helpCookie(headers: Headers) {
  const values = (headers.get("cookie") ?? "").split(";").map((entry) => entry.trim()).filter((entry) => entry.split("=", 1)[0] === "pawket_help");
  if (values.length !== 1) return null;
  const token = values[0]!.slice("pawket_help=".length);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}
export function createAppealHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin;
  async function submit(request: Request, locked: boolean): Promise<Response> {
    try {
      if (request.method !== "POST") throw new CommissionHttpFailure(405, "method_not_allowed");
      if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") throw new CommissionHttpFailure(403, "untrusted_origin");
      if (new URL(request.url).search) throw new CommissionHttpFailure(400, "invalid_request");
      const actor = locked ? null : await input.authenticate(request.headers);
      const sessionToken = locked ? helpCookie(request.headers) : null;
      if (locked ? sessionToken === null : actor === null) throw new CommissionHttpFailure(401, "authentication_required");
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(idempotencyKey)) throw new CommissionHttpFailure(400, "invalid_request");
      const body = await readCommissionBody(request, bodySchema);
      return commissionJson(202, await input.appeals.submit({ ...body, appellant: locked ? { kind: "help_session", sessionToken: sessionToken! }
        : { kind: "session", actor: { userId: actor!.userId, sessionId: actor!.sessionId } }, idempotencyKey, requestId: randomUUID() }));
    } catch (error) { return failure(error); }
  }
  return { submit: (request: Request) => submit(request, false), lockedSubmit: (request: Request) => submit(request, true) };
}
