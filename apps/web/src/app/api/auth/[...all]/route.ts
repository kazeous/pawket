import { retiredIdentityResponse } from "@pawket/identity";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";
// Retire password, social callbacks, local MFA and Better Auth session endpoints.
const handle = (request: Request) => withRouteContext(request, retiredIdentityResponse);
export const GET = handle;
export const POST = handle;
