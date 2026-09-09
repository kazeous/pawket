import { beforeEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";

import { resolvePublicCreatorWithMetric } from "../src/platform/public-creator-resolution.js";

async function expectSeries(series: string): Promise<void> {
  expect(await metricsRegistry.metrics()).toContain(`${series} 1`);
}

describe("public creator resolution metrics", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  test.each([
    [
      "canonical",
      { kind: "visible", page: { canonicalHandle: "sunlit-ceramics" } },
      'pawket_creator_directory_resolutions_total{source="canonical",outcome="succeeded"}',
    ],
    [
      "alias",
      { kind: "redirect", canonicalHandle: "sunlit-ceramics" },
      'pawket_creator_directory_resolutions_total{source="alias",outcome="succeeded"}',
    ],
    [
      "unknown",
      { kind: "not_found" },
      'pawket_creator_directory_resolutions_total{source="unknown",outcome="rejected"}',
    ],
  ] as const)("records a bounded %s handle resolution", async (_scenario, result, series) => {
    const query = { resolvePublicCreator: vi.fn(async () => result) };

    await expect(
      resolvePublicCreatorWithMetric(query as never, "private-handle-value"),
    ).resolves.toBe(result);

    await expectSeries(series);
    expect(await metricsRegistry.metrics()).not.toContain("private-handle-value");
  });
});
