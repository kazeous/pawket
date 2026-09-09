import {
  readBusinessMetricField,
  withBusinessOperation,
  withRouteContext,
} from "../../../../http/route-context";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withRouteContext(request, async () => {
    const candidate = await readBusinessMetricField(request, "reason");
    const reasons = new Set([
      "impersonation",
      "prohibited_or_age_restricted_content",
      "harassment_or_hate",
      "violence_or_self_harm",
      "privacy",
      "intellectual_property",
      "spam_or_scam",
      "other",
    ]);
    const reason = typeof candidate === "string" && reasons.has(candidate)
      ? candidate as
          | "impersonation"
          | "prohibited_or_age_restricted_content"
          | "harassment_or_hate"
          | "violence_or_self_harm"
          | "privacy"
          | "intellectual_property"
          | "spam_or_scam"
          | "other"
      : undefined;
    return withBusinessOperation(
      { domain: "content_report", operation: "submit", ...(reason ? { reason } : {}) },
      () => getPlatformRuntime().trustHandlers.submitReport(request),
    );
  });
}
