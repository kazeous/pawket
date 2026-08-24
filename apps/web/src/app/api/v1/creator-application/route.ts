import { getIdentityRuntime } from "../../../../auth/runtime";
import { withRouteContext } from "../../../../http/route-context";
export const runtime = "nodejs";
export function GET(request: Request) { return withRouteContext(request, () => getIdentityRuntime().creatorHandlers.get(request)); }
export function POST(request: Request) { return withRouteContext(request, () => getIdentityRuntime().creatorHandlers.save(request)); }
