import {
  readBusinessMetricField,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../platform/runtime";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withRouteContext(request, async () => {
    const candidate = await readBusinessMetricField(request, "purpose");
    const purpose = candidate === "avatar" || candidate === "cover" || candidate === "showcase"
      ? candidate
      : undefined;
    const handler = () => getPlatformRuntime().mediaCommandHandlers.createUpload(request);
    return withBusinessOperation(
      { domain: "public_media", operation: "upload", ...(purpose ? { purpose } : {}) },
      handler,
    );
  });
}
