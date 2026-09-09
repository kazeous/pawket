import { NextRequest, NextResponse } from "next/server";

import { trustedRequestId } from "./http/route-context";
import { applySecurityHeaders } from "./http/security-headers";

const privateNoStore = /^\/(creator(?:\/preview)?|admin\/content-reports)(?:\/|$)/u;
const publicNoStore = /^\/(creators|media)(?:\/|$)|^\/sitemap\.xml$/u;

export function proxy(request: NextRequest): NextResponse {
  const requestId = trustedRequestId(request.headers.get("x-request-id"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  if (privateNoStore.test(request.nextUrl.pathname)) {
    response.headers.set("cache-control", "private, no-store");
  }
  if (publicNoStore.test(request.nextUrl.pathname)) {
    response.headers.set("cache-control", "public, no-store");
  }
  return applySecurityHeaders(response) as NextResponse;
}
