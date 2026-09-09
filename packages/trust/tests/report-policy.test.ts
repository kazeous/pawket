import { describe, expect, test } from "vitest";

import {
  PUBLIC_REPORT_REASONS,
  normalizeReportDetail,
  normalizeReportReason,
  normalizeReportTarget,
} from "../src/report-policy.js";

const target = {
  targetType: "page",
  targetId: "10000000-0000-4000-8000-000000000001",
  publicationRevisionId: "20000000-0000-4000-8000-000000000002",
} as const;

describe("public report policy", () => {
  test("closes the public reason taxonomy", () => {
    expect(PUBLIC_REPORT_REASONS).toEqual([
      "impersonation",
      "prohibited_or_age_restricted_content",
      "harassment_or_hate",
      "violence_or_self_harm",
      "privacy",
      "intellectual_property",
      "spam_or_scam",
      "other",
    ]);
    for (const reason of PUBLIC_REPORT_REASONS) expect(normalizeReportReason(reason)).toBe(reason);
    expect(normalizeReportReason("unlisted")).toBeNull();
  });

  test("normalizes plain report detail to NFC and counts Unicode code points", () => {
    expect(normalizeReportDetail("Cafe\u0301")).toBe("Caf\u00e9");
    expect(normalizeReportDetail("\ud83c\udfa8".repeat(1_000))).toHaveLength(2_000);
    expect(normalizeReportDetail("\ud83c\udfa8".repeat(1_001))).toBeNull();
    expect(normalizeReportDetail("contains\0nul")).toBeNull();
    expect(normalizeReportDetail(undefined)).toBeNull();
  });

  test("takes an exact own-data snapshot of the immutable target", () => {
    const normalized = normalizeReportTarget(target);
    expect(normalized).toEqual(target);
    expect(normalized).not.toBe(target);
    expect(normalizeReportTarget({ ...target, extra: true })).toBeNull();
    expect(normalizeReportTarget(Object.assign(Object.create({ targetId: target.targetId }), {
      targetType: target.targetType,
      publicationRevisionId: target.publicationRevisionId,
    }))).toBeNull();

    let getterCalls = 0;
    const accessor: Record<string, unknown> = {
      targetType: target.targetType,
      publicationRevisionId: target.publicationRevisionId,
    };
    Object.defineProperty(accessor, "targetId", {
      enumerable: true,
      get() { getterCalls += 1; return target.targetId; },
    });
    expect(normalizeReportTarget(accessor)).toBeNull();
    expect(normalizeReportTarget(new Proxy(target, {}))).toBeNull();
    expect(getterCalls).toBe(0);
  });
});
