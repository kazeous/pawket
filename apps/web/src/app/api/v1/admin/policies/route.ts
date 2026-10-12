import { withCommissionRoute } from "../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../platform/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return withCommissionRoute(request, () => getPlatformRuntime().caseHandlers.policies(request)); }
export function POST(request: Request) { return withCommissionRoute(request, () => getPlatformRuntime().caseHandlers.publishPolicy(request)); }
