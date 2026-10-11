import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeTrustReportTarget, normalizeReportReason, PublicReportError, TrustEnforcementError, readExactOwnDataRecord,
  type PrivateReportCommand, type PrivateReportService } from "@pawket/trust";
import { commissionJson, CommissionHttpFailure, readCommissionBody } from "./commission-http.js";
import { deriveTrustedNetworkKey } from "@pawket/trust";

type Input = { appBaseUrl: string; lookupHmacKey: Uint8Array;
  authenticate(headers: Headers): Promise<{ userId: string; sessionId: string } | null>;
  reports: Pick<PrivateReportService, "submit" | "issueChallenge"> };
const failure = (status = 400) => commissionJson(status, { code: "REPORT_NOT_ACCEPTED" });
function failed(error: unknown) {
  if (error instanceof TrustEnforcementError && error.code === "enforcement_disabled") return commissionJson(503, { code: "enforcement_disabled" });
  if (error instanceof TrustEnforcementError) return failure(error.code === "rate_limited" ? 429 : error.code === "enforcement_disabled" ? 404 : error.code === "dependency_unavailable" ? 503 : 400);
  if (error instanceof PublicReportError) return failure(error.status);
  if (error instanceof CommissionHttpFailure) return failure(error.status);
  return failure(503);
}
/** Optional authoritative session: guests remain limited to public package targets and network-bound challenges. */
export function createTrustEnforcementHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  function boundary(request: Request) {
    if (request.method !== "POST") return failure(405);
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return failure(403);
    if (new URL(request.url).search) return failure();
    return null;
  }
  return {
    async challenge(request: Request): Promise<Response> {
      const rejected = boundary(request); if (rejected) return rejected;
      const networkKeyHmac = deriveTrustedNetworkKey(request.headers, key); if (!networkKeyHmac) return failure();
      try { return commissionJson(200, await input.reports.issueChallenge({ networkKeyHmac })); } catch (error) { return failed(error); }
    },
    async submit(request: Request): Promise<Response> {
      const rejected = boundary(request); if (rejected) return rejected;
      try {
        const value = await readCommissionBody(request, z.unknown());
        const actor = await input.authenticate(request.headers);
        const row = readExactOwnDataRecord(value, actor ? [["target", "reason"], ["target", "reason", "detail"]]
          : [["target", "reason", "challenge"], ["target", "reason", "detail", "challenge"]]);
        if (!row) return failure();
        const target = normalizeTrustReportTarget(row.target); const reason = normalizeReportReason(row.reason);
        if (!target || !reason || (row.detail !== undefined && row.detail !== null && typeof row.detail !== "string")) return failure();
        let requester: PrivateReportCommand["requester"];
        let idempotencyKey: string;
        if (actor) {
          const key = request.headers.get("idempotency-key"); if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(key)) return failure();
          requester = { kind: "authenticated", actor: { userId: actor.userId, sessionId: actor.sessionId } }; idempotencyKey = key;
        } else {
          if (target.kind !== "commission_package") return failure();
          const networkKeyHmac = deriveTrustedNetworkKey(request.headers, key);
          const challenge = readExactOwnDataRecord(row.challenge, [["token", "solution"]]);
          if (!networkKeyHmac || !challenge || typeof challenge.token !== "string" || challenge.token.length < 1 || challenge.token.length > 512 || !Number.isSafeInteger(challenge.solution) || (challenge.solution as number) < 0) return failure();
          requester = { kind: "guest", networkKeyHmac, challenge: { token: challenge.token, solution: challenge.solution as number } }; idempotencyKey = randomUUID();
        }
        return commissionJson(202, await input.reports.submit({ requester, target, reason, detail: row.detail as string | null | undefined ?? null,
          idempotencyKey, requestId: randomUUID() }));
      } catch (error) { return failed(error); }
    },
  };
}
