import { NextRequest, NextResponse } from "next/server";

import { trustedRequestId } from "./http/route-context";
import { applySecurityHeaders } from "./http/security-headers";

const privateNoStore = /^\/(creator(?:\/preview)?|admin\/content-reports|tips|commissions)(?:\/|$)/u;
const commissionNoReferrer = /^\/(?:commissions|creator\/commissions)(?:\/|$)|^\/api\/v1\/(?:commissions|creator\/commissions)(?:\/|$)|^\/api\/v1\/public\/creators\/[^/]+\/commissions$/u;
const tipNoReferrer = /^\/(?:tips|creator\/tips)(?:\/|$)|^\/api\/v1\/(?:tips|creator\/(?:tips|tip-settings))(?:\/|$)|^\/api\/v1\/public\/creators\/[^/]+\/tips$/u;
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
  if (/^\/creators\/[^/]+\/commissions(?:\/|$)/u.test(request.nextUrl.pathname)) {
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("referrer-policy", "no-referrer");
  }
  applySecurityHeaders(response);
  if (tipNoReferrer.test(request.nextUrl.pathname) || commissionNoReferrer.test(request.nextUrl.pathname) || /^\/creators\/[^/]+\/commissions(?:\/|$)/u.test(request.nextUrl.pathname)) response.headers.set("referrer-policy", "no-referrer");
  return response;
}
