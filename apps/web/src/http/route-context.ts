import { randomUUID } from "node:crypto";

import { withRequestContext } from "@pawket/observability/request-context";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

export function trustedRequestId(incomingRequestId: string | null): string {
  if (
    incomingRequestId !== null &&
    incomingRequestId.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(incomingRequestId)
  ) {
    return incomingRequestId;
  }

  return randomUUID();
}

export function withRouteContext(
  request: Request,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const context = Object.freeze({ requestId: trustedRequestId(request.headers.get("x-request-id")) });
  return Promise.resolve(withRequestContext(context, handler));
}
