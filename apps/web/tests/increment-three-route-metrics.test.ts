import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

import { metricsRegistry } from "@pawket/observability";

const platform = vi.hoisted(() => ({
  catalogHandlers: {
    saveDraft: vi.fn(async () => Response.json({ result: {} })),
    handle: vi.fn(async () => Response.json({ result: {} })),
    showcases: vi.fn(async () => Response.json({ result: {} })),
    publish: vi.fn(async () => Response.json({ result: {} })),
    unpublish: vi.fn(async () => Response.json({ result: {} })),
  },
  mediaCommandHandlers: {
    createUpload: vi.fn(async () => Response.json({ result: {} })),
    completeUpload: vi.fn(async () => Response.json({ result: {} })),
  },
  mediaHandlers: {
    deliver: vi.fn(async (
      _request: unknown,
      _assetId: unknown,
      _variant: unknown,
    ) => new Response(new Uint8Array([1]), { status: 200 })),
  },
  trustHandlers: {
    challenge: vi.fn(async () => Response.json({ token: "bounded" })),
    submitReport: vi.fn(async () => Response.json({ accepted: true }, { status: 202 })),
    triage: vi.fn(async () => Response.json({ result: {} })),
  },
}));

vi.mock("../src/platform/runtime", () => ({
  getPlatformRuntime: () => platform,
}));

const origin = "https://pawket.example";
const intentId = "10000000-0000-4000-8000-000000000001";
const reportId = "20000000-0000-4000-8000-000000000002";
const assetId = "30000000-0000-4000-8000-000000000003";

async function expectSeries(series: string): Promise<void> {
  expect(await metricsRegistry.metrics()).toContain(`${series} 1`);
}

function post(path: string, body?: unknown): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

describe("Increment 3 production route metrics", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
    vi.clearAllMocks();
  });

  test.each([
    ["draft", "../src/app/api/v1/creator-page/route.js", "/api/v1/creator-page"],
    ["draft", "../src/app/api/v1/creator-page/showcases/route.js", "/api/v1/creator-page/showcases"],
    ["publish", "../src/app/api/v1/creator-page/publish/route.js", "/api/v1/creator-page/publish"],
    ["unpublish", "../src/app/api/v1/creator-page/unpublish/route.js", "/api/v1/creator-page/unpublish"],
  ] as const)("records the catalog %s route boundary", async (operation, modulePath, path) => {
    const route = await import(modulePath);

    await route.POST(post(path));

    await expectSeries(
      `pawket_catalog_operations_total{operation="${operation}",outcome="succeeded"}`,
    );
  });

  test.each([
    ["claim", "handle_claim"],
    ["rename", "handle_rename"],
  ] as const)("records the bounded handle %s action", async (action, operation) => {
    const route = await import("../src/app/api/v1/creator-page/handle/route.js");

    await route.POST(post("/api/v1/creator-page/handle", { action }));

    await expectSeries(
      `pawket_catalog_operations_total{operation="${operation}",outcome="succeeded"}`,
    );
  });

  test("records upload issuance with a closed purpose", async () => {
    const route = await import("../src/app/api/v1/creator-page/media/uploads/route.js");

    await route.POST(post("/api/v1/creator-page/media/uploads", { purpose: "cover" }));

    await expectSeries(
      'pawket_public_media_operations_total{operation="upload",outcome="succeeded",purpose="cover",variant="none"}',
    );
  });

  test("records upload completion without an identifier label", async () => {
    const route = await import(
      "../src/app/api/v1/creator-page/media/uploads/[intentId]/complete/route.js"
    );

    await route.POST(
      post(`/api/v1/creator-page/media/uploads/${intentId}/complete`, { assetId }),
      { params: Promise.resolve({ intentId }) },
    );

    await expectSeries(
      'pawket_public_media_operations_total{operation="upload",outcome="succeeded",purpose="none",variant="none"}',
    );
    expect(await metricsRegistry.metrics()).not.toContain(intentId);
    expect(await metricsRegistry.metrics()).not.toContain(assetId);
  });

  test("normalizes the framework delivery request while recording a closed variant", async () => {
    const route = await import("../src/app/media/[assetId]/[variant]/route.js");

    await route.GET(
      new NextRequest(`${origin}/media/${assetId}/display?preview=1`, {
        headers: { cookie: "pawket.session=synthetic" },
      }),
      { params: Promise.resolve({ assetId, variant: "display" }) },
    );

    const [forwarded] = platform.mediaHandlers.deliver.mock.calls[0]!;
    expect(Object.getPrototypeOf(forwarded) === Request.prototype).toBe(true);
    expect((forwarded as Request).headers.get("cookie")).toBe(
      "pawket.session=synthetic",
    );
    await expectSeries(
      'pawket_public_media_operations_total{operation="delivery",outcome="succeeded",purpose="none",variant="display"}',
    );
    expect(await metricsRegistry.metrics()).not.toContain(assetId);
  });

  test("records challenge and report submission with only the closed report reason", async () => {
    const challenge = await import("../src/app/api/v1/content-reports/challenge/route.js");
    const submit = await import("../src/app/api/v1/content-reports/route.js");

    await challenge.GET(new Request(`${origin}/api/v1/content-reports/challenge`));
    await submit.POST(post("/api/v1/content-reports", {
      reason: "privacy",
      detail: "private prose that must never become a label",
    }));

    await expectSeries(
      'pawket_public_content_report_operations_total{operation="challenge",outcome="succeeded",reason="none"}',
    );
    await expectSeries(
      'pawket_public_content_report_operations_total{operation="submit",outcome="succeeded",reason="privacy"}',
    );
    expect(await metricsRegistry.metrics()).not.toContain("private prose");
  });

  test.each(["dismiss", "hide", "restore"] as const)(
    "records the bounded %s triage action without operator prose",
    async (action) => {
      const route = await import(
        "../src/app/api/v1/admin/content-reports/[reportId]/route.js"
      );

      await route.POST(
        post(`/api/v1/admin/content-reports/${reportId}`, {
          action,
          reason: "operator explanation must stay private",
        }),
        { params: Promise.resolve({ reportId }) },
      );

      await expectSeries(
        `pawket_public_content_report_operations_total{operation="${action}",outcome="succeeded",reason="none"}`,
      );
      expect(await metricsRegistry.metrics()).not.toContain("operator explanation");
      expect(await metricsRegistry.metrics()).not.toContain(reportId);
    },
  );
});
