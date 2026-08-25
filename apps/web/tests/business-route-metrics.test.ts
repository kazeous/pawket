import { beforeEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";

const runtime = vi.hoisted(() => ({
  creatorHandlers: {
    save: vi.fn(async () => Response.json({ application: {} })),
    submit: vi.fn(async () => Response.json({ application: {} })),
    withdraw: vi.fn(async () => Response.json({ application: {} })),
  },
  creatorReviewHandlers: {
    decide: vi.fn(async () => Response.json({ decision: {} })),
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

  test("does not duplicate an oversized decision body for telemetry", async () => {
    const route = await import(
      "../src/app/api/v1/admin/creator-applications/[applicationId]/decision/route.js"
    );
    await route.POST(
      new Request(`${origin}/api/v1/admin/creator-applications/${applicationId}/decision`, {
        method: "POST",
        headers: { "content-length": "9000", "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      { params: Promise.resolve({ applicationId }) },
    );

    expect(await metricsRegistry.metrics()).not.toContain("pawket_creator_operations_total{");
  });
});
