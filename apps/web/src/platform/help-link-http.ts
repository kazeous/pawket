import { z } from "zod";
import { deriveTrustedNetworkKey, type HelpLinkService, type TrustEnforcementMode } from "@pawket/trust";
import { COMMISSION_PRIVATE_HEADERS, commissionJson, readCommissionBody } from "./commission-http.js";

type Input = { appBaseUrl: string; mode: TrustEnforcementMode; lookupHmacKey: Uint8Array; helpLinks: Pick<HelpLinkService, "openSession" | "requestLink" | "revokeSession">;
  logger: { error(message: string): void } };
const unavailable = (status = 400) => commissionJson(status, { code: "not_available" });
const empty = () => new Response(null, { status: 204, headers: COMMISSION_PRIVATE_HEADERS });

export function createHelpLinkHttpHandlers(input: Input) {
  const origin = new URL(input.appBaseUrl).origin; const key = new Uint8Array(input.lookupHmacKey);
  function boundary(request: Request) {
    if (request.method !== "POST") return unavailable(405);
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return unavailable(403);
    if (new URL(request.url).search) return unavailable();
    return null;
  }
  return {
    async session(request: Request): Promise<Response> {
      const rejected = boundary(request); if (rejected) return rejected;
      if (input.mode !== "enabled") return unavailable();
      try {
        const body = await readCommissionBody(request, z.strictObject({ token: z.string().max(128) }));
        const networkKeyHmac = deriveTrustedNetworkKey(request.headers, key); if (!networkKeyHmac) return unavailable();
        const opened = await input.helpLinks.openSession({ token: body.token, networkKeyHmac });
        if (!/^[A-Za-z0-9_-]{43}$/u.test(opened.sessionToken)) return unavailable();
        const response = empty();
        response.headers.set("set-cookie", `pawket_help=${opened.sessionToken}; Path=/help/locked; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`);
        return response;
      } catch { return unavailable(); }
    },
    async endSession(request: Request): Promise<Response> {
      const rejected = boundary(request); if (rejected) return rejected;
      const values = (request.headers.get("cookie") ?? "").split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith("pawket_help="));
      const token = values.length === 1 ? values[0]!.slice("pawket_help=".length) : null;
      try { if (token && /^[A-Za-z0-9_-]{43}$/u.test(token)) await input.helpLinks.revokeSession(token); }
      catch { return unavailable(503); }
      const response = empty();
      response.headers.set("set-cookie", "pawket_help=; Path=/help/locked; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      return response;
    },
    async linkRequest(request: Request): Promise<Response> {
      const rejected = boundary(request); if (rejected) return rejected;
      try {
        const body = await readCommissionBody(request, z.strictObject({ email: z.string().max(512) }));
        const networkKeyHmac = deriveTrustedNetworkKey(request.headers, key);
        if (networkKeyHmac) await input.helpLinks.requestLink({ email: body.email, networkKeyHmac });
      } catch { input.logger.error("Help-link resend handler failed"); }
      return empty();
    },
  };
}
