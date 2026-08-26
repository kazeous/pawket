import { beforeEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";

const runtime = vi.hoisted(() => ({
  creatorHandlers: {
    save: vi.fn(async () => Response.json({ application: {} })),
    submit: vi.fn(async () => Response.json({ application: {} })),
    withdraw: vi.fn(async () => Response.json({ application: {} })),
  },
  creatorReviewHandlers: {
    decide: vi.fn(async (request: Request) => {
      void request;
      return Response.json({ decision: {} });
    }),
    setCapability: vi.fn(async () => Response.json({ capability: {} })),
  },
  paymentsHandlers: {
    issueChallenge: vi.fn(async () => Response.json({ challenge: {} })),
    reportDepositSent: vi.fn(async () => Response.json({ deposit: {} })),
    reconcileDeposit: vi.fn(async () =>
      Response.json({ reconciliation: { kind: "matched" } }),
    ),
    recordRefund: vi.fn(async () => Response.json({ refund: {} })),
  },
}));

vi.mock("../src/auth/runtime", () => ({
  getIdentityRuntime: () => runtime,
}));

const origin = "https://pawket.example";
const applicationId = "10000000-0000-4000-8000-000000000001";
const userId = "creator-user";
const obligationId = "20000000-0000-4000-8000-000000000002";

async function expectSeries(series: string): Promise<void> {
  expect(await metricsRegistry.metrics()).toContain(`${series} 1`);
}

describe("business route metrics", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
    vi.clearAllMocks();
  });

  test.each([
    ["draft", "../src/app/api/v1/creator-application/route.js"],
    ["submit", "../src/app/api/v1/creator-application/submit/route.js"],
    ["withdraw", "../src/app/api/v1/creator-application/withdraw/route.js"],
  ] as const)("records the creator %s boundary", async (operation, modulePath) => {
    const route = await import(modulePath);
    await route.POST(new Request(`${origin}/api/v1/creator-application/${operation}`, {
      method: "POST",
    }));

    await expectSeries(
      `pawket_creator_operations_total{operation="${operation}",outcome="succeeded"}`,
    );
  });

  test.each([
    ["request_changes", "changes_requested"],
    ["approve", "approve"],
    ["reject", "reject"],
    ["reopen", "reopen"],
  ] as const)("records the bounded %s review decision", async (action, operation) => {
    const route = await import(
      "../src/app/api/v1/admin/creator-applications/[applicationId]/decision/route.js"
    );
    await route.POST(
      new Request(`${origin}/api/v1/admin/creator-applications/${applicationId}/decision`, {
        method: "POST",
        headers: { "content-length": "32", "content-type": "application/json" },
        body: JSON.stringify({ action }),
      }),
      { params: Promise.resolve({ applicationId }) },
    );

    await expectSeries(
      `pawket_creator_operations_total{operation="${operation}",outcome="succeeded"}`,
    );
  });

  test.each(["suspend", "reinstate"] as const)(
    "records the bounded %s capability decision",
    async (operation) => {
      const route = await import(
        "../src/app/api/v1/admin/creator-capabilities/[userId]/route.js"
      );
      await route.POST(
        new Request(`${origin}/api/v1/admin/creator-capabilities/${userId}`, {
          method: "POST",
          headers: { "content-length": "32", "content-type": "application/json" },
          body: JSON.stringify({ action: operation }),
        }),
        { params: Promise.resolve({ userId }) },
      );

      await expectSeries(
        `pawket_creator_operations_total{operation="${operation}",outcome="succeeded"}`,
      );
    },
  );

  test("records challenge, report, and the bounded reconciliation result", async () => {
    const challenge = await import(
      "../src/app/api/v1/admin/creator-applications/[applicationId]/deposit/challenge/route.js"
    );
    await challenge.POST(
      new Request(`${origin}/challenge`, { method: "POST" }),
      { params: Promise.resolve({ applicationId }) },
    );
    const report = await import(
      "../src/app/api/v1/creator-application/deposit/report/route.js"
    );
    await report.POST(new Request(`${origin}/report`, { method: "POST" }));
    const reconcile = await import(
      "../src/app/api/v1/admin/verification-deposits/reconcile/route.js"
    );
    await reconcile.POST(new Request(`${origin}/reconcile`, { method: "POST" }));

    await expectSeries(
      'pawket_receiving_proof_operations_total{operation="challenge",outcome="succeeded"}',
    );
    await expectSeries(
      'pawket_receiving_proof_operations_total{operation="report",outcome="succeeded"}',
    );
    await expectSeries(
      'pawket_receiving_proof_operations_total{operation="matched",outcome="succeeded"}',
    );
  });

  test.each([
    ["sent", "succeeded"],
    ["attention_required", "attention_required"],
  ] as const)("records the bounded refund %s result", async (operation, outcome) => {
    const route = await import(
      "../src/app/api/v1/admin/refund-obligations/[obligationId]/refund/route.js"
    );
    await route.POST(
      new Request(`${origin}/api/v1/admin/refund-obligations/${obligationId}/refund`, {
        method: "POST",
        headers: { "content-length": "32", "content-type": "application/json" },
        body: JSON.stringify({ outcome: operation }),
      }),
      { params: Promise.resolve({ obligationId }) },
    );

    await expectSeries(
      `pawket_refund_operations_total{operation="${operation}",outcome="${outcome}"}`,
    );
  });

  test.each(["buffered", "streamed"] as const)(
    "records a valid %s decision body without a content-length and preserves the original",
    async (kind) => {
      // Catches telemetry depending on Content-Length or consuming the handler's body.
      const route = await import(
        "../src/app/api/v1/admin/creator-applications/[applicationId]/decision/route.js"
      );
      runtime.creatorReviewHandlers.decide.mockImplementationOnce(async (request) => {
        const body = await request.json() as { action?: unknown };
        return Response.json({ receivedAction: body.action });
      });
      const encoded = new TextEncoder().encode(JSON.stringify({ action: "approve" }));
      const body = kind === "buffered"
        ? encoded
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoded.slice(0, 5));
              controller.enqueue(encoded.slice(5));
              controller.close();
            },
          });
      const request = new Request(
        `${origin}/api/v1/admin/creator-applications/${applicationId}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          ...(kind === "streamed" ? { duplex: "half" } : {}),
        } as RequestInit,
      );
      expect(request.headers.get("content-length")).toBeNull();

      const response = await route.POST(request, {
        params: Promise.resolve({ applicationId }),
      });

      await expect(response.json()).resolves.toEqual({ receivedAction: "approve" });
      await expectSeries(
        'pawket_creator_operations_total{operation="approve",outcome="succeeded"}',
      );
    },
  );

  test("accepts an exact 8192-byte body without changing the original request", async () => {
    // Catches an off-by-one bound or telemetry disturbing the product handler's read.
    const route = await import(
      "../src/app/api/v1/admin/creator-applications/[applicationId]/decision/route.js"
    );
    const prefix = '{"action":"approve","padding":"';
    const suffix = '"}';
    const body = `${prefix}${"x".repeat(8_192 - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(body)).toHaveLength(8_192);
    runtime.creatorReviewHandlers.decide.mockImplementationOnce(async (request) => {
      const parsed = await request.json() as { padding: string };
      return Response.json({ paddingLength: parsed.padding.length });
    });

    const response = await route.POST(
      new Request(`${origin}/api/v1/admin/creator-applications/${applicationId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      { params: Promise.resolve({ applicationId }) },
    );

    await expect(response.json()).resolves.toEqual({ paddingLength: 8_159 });
    await expectSeries(
      'pawket_creator_operations_total{operation="approve",outcome="succeeded"}',
    );
  });

  test("stops and cancels telemetry parsing after 8192 streamed bytes", async () => {
    // Catches a header-only bound that still clones and parses an oversized body.
    const route = await import(
      "../src/app/api/v1/admin/creator-applications/[applicationId]/decision/route.js"
    );
    const prefix = '{"action":"approve","padding":"';
    const suffix = '"}';
    const encoded = new TextEncoder().encode(
      `${prefix}${"x".repeat(20_000 - prefix.length - suffix.length)}${suffix}`,
    );
    const chunks = Array.from(
      { length: Math.ceil(encoded.byteLength / 512) },
      (_, index) => encoded.slice(index * 512, (index + 1) * 512),
    );
    let pulledChunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulledChunks];
        pulledChunks += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    runtime.creatorReviewHandlers.decide.mockResolvedValueOnce(
      Response.json({ handlerRan: true }),
    );

    const request = new Request(
      `${origin}/api/v1/admin/creator-applications/${applicationId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit,
    );
    const response = await route.POST(
      request,
      { params: Promise.resolve({ applicationId }) },
    );

    await expect(response.json()).resolves.toEqual({ handlerRan: true });
    expect(pulledChunks).toBeLessThan(chunks.length);
    expect(request.bodyUsed).toBe(false);
    await request.body?.cancel();
    expect(await metricsRegistry.metrics()).not.toContain("pawket_creator_operations_total{");
    expect(await metricsRegistry.metrics()).toContain(
      'pawket_http_requests_total{method="POST",route="/api/v1/admin",status_code="200"} 1',
    );
  });

  test("fails closed to generic HTTP telemetry for malformed dynamic JSON", async () => {
    // Catches parse failures guessing an operation or preventing the product handler from running.
    const route = await import(
      "../src/app/api/v1/admin/creator-applications/[applicationId]/decision/route.js"
    );
    runtime.creatorReviewHandlers.decide.mockImplementationOnce(async (request) =>
      Response.json({ raw: await request.text() }),
    );
    const response = await route.POST(
      new Request(`${origin}/api/v1/admin/creator-applications/${applicationId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"action":',
      }),
      { params: Promise.resolve({ applicationId }) },
    );

    await expect(response.json()).resolves.toEqual({ raw: '{"action":' });
    const metrics = await metricsRegistry.metrics();
    expect(metrics).not.toContain("pawket_creator_operations_total{");
    expect(metrics).toContain(
      'pawket_http_requests_total{method="POST",route="/api/v1/admin",status_code="200"} 1',
    );
  });
});
