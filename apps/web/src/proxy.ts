import { NextRequest, NextResponse } from "next/server";

import { trustedRequestId } from "./http/route-context";
import { applySecurityHeaders } from "./http/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const requestId = trustedRequestId(request.headers.get("x-request-id"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  return applySecurityHeaders(response) as NextResponse;
}
