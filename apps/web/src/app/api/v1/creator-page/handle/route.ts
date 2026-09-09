import {
  readBusinessMetricField,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withRouteContext(request, async () => {
    const action = await readBusinessMetricField(request, "action");
    const operation = action === "claim"
      ? "handle_claim"
      : action === "rename"
        ? "handle_rename"
        : null;
    const handler = () => getPlatformRuntime().catalogHandlers.handle(request);
    return operation === null
      ? handler()
      : withBusinessOperation({ domain: "catalog", operation }, handler);
  });
}
