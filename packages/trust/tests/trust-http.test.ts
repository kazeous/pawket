import { describe, expect, test, vi } from "vitest";

import { createTrustHttpHandlers } from "../src/trust-http.js";

const origin = "https://pawket.example";
const target = {
  targetType: "page" as const,
  targetId: "10000000-0000-4000-8000-000000000001",
  publicationRevisionId: "20000000-0000-4000-8000-000000000002",
};
const privateCreatorSentinel = "private-creator-sentinel";
const privateMediaSentinel = "90000000-0000-4000-8000-000000000009";
const queueProjection = {
  reportId: "30000000-0000-4000-8000-000000000003",
  target,
  reason: "other" as const,
  detail: "Contextual report.",
  state: "open" as const,
  version: 3,
  authenticatedReporter: true,
  snapshot: {
    target,
    pageId: target.targetId,
    creatorUserId: privateCreatorSentinel,
    canonicalHandle: "safe-artist",
    displayName: "Safe Artist",
    showcaseTitle: null,
    mediaAssetIds: [privateMediaSentinel],
  },
  activeHold: null,
  priorActions: [{
    action: "dismiss" as const,
    reason: "Earlier review was incomplete.",
    beforeState: "open" as const,
    afterState: "dismissed" as const,
    resultingReportVersion: 2,
    occurredAt: "2026-08-31T11:00:00.000Z",
  }],
};

function fixture(options: { authenticated?: boolean; owner?: boolean } = {}) {
  const report = {
    issueChallenge: vi.fn(async () => ({
      token: "challenge-token",
      difficulty: 18 as const,
      expiresAt: "2026-08-31T12:10:00.000Z",
    })),
    submitReport: vi.fn(async () => ({ accepted: true as const, reportReference: "report:v1:safe" })),
  };
  const triage = {
    listQueue: vi.fn(async () => [queueProjection]),
    dismiss: vi.fn(async (command: unknown) => command),
    hide: vi.fn(async (command: unknown) => command),
    restore: vi.fn(async (command: unknown) => command),
  };
  const issueOwnerStepUpProof = vi.fn(async ({ actionClass }: { actionClass: string }) => ({
    id: `server-proof:${actionClass}`,
  }));
  const handlers = createTrustHttpHandlers({
    appBaseUrl: origin,
    lookupHmacKey: new Uint8Array(32).fill(73),
    optionalAuthoritativeSession: vi.fn(async () => options.authenticated
      ? { userId: "reporter-1", sessionId: "reporter-session", primaryAuthenticatedAt: new Date() }
      : null),
    authorizeOwner: vi.fn(async () => options.owner ? "authorized" as const : "forbidden" as const),
    issueOwnerStepUpProof,
    report,
    triage,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  return { handlers, issueOwnerStepUpProof, report, triage };
}

function reportRequest(overrides: {
  body?: string;
  challenge?: { token: string; solution: number } | null;
  contentType?: string;
  origin?: string;
  realIp?: string | null;
} = {}): Request {
  const challenge = overrides.challenge === undefined
    ? { token: "challenge-token", solution: 7 }
    : overrides.challenge;
  const payload = {
    target,
    reason: "other",
    detail: "Contextual report.",
    ...(challenge === null ? {} : { challenge }),
  };
  const headers = new Headers({
    "content-type": overrides.contentType ?? "application/json; charset=utf-8",
    origin: overrides.origin ?? origin,
  });
  if (overrides.realIp !== null) headers.set("x-real-ip", overrides.realIp ?? "203.0.113.7");
  return new Request(`${origin}/api/v1/content-reports`, {
    method: "POST",
    headers,
    body: overrides.body ?? JSON.stringify(payload),
  });
}

function triageRequest(overrides: {
  action?: string;
  idempotencyKey?: string | null;
  ifMatch?: string | null;
} = {}): Request {
  const headers = new Headers({
    "content-type": "application/json",
    origin,
  });
  if (overrides.idempotencyKey !== null) {
    headers.set("idempotency-key", overrides.idempotencyKey ?? "hide-report-001");
  }
  if (overrides.ifMatch !== null) headers.set("if-match", overrides.ifMatch ?? "3");
  return new Request(`${origin}/api/v1/admin/content-reports/${target.targetId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: overrides.action ?? "hide",
      reason: "Violates the public-content policy.",
    }),
  });
}

describe("Trust HTTP boundary", () => {
  test("public report submission rejects a guest without a challenge", async () => {
    // Catches guest submission bypassing the proof-of-work requirement.
    const { handlers, report } = fixture();

    const response = await handlers.submitReport(reportRequest({ challenge: null }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "REPORT_NOT_ACCEPTED" });
    expect(report.submitReport).not.toHaveBeenCalled();
  });

  test.each([
    [{ origin: "https://evil.example" }, 403],
    [{ contentType: "text/plain" }, 415],
    [{ body: "x".repeat(32_769) }, 413],
  ] as const)("public report submission rejects an invalid HTTP control with %s", async (overrides, status) => {
    // Catches origin, media-type, or 32 KiB body controls being removed.
    const { handlers, report } = fixture();

    const response = await handlers.submitReport(reportRequest(overrides));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code: "REPORT_NOT_ACCEPTED" });
    expect(report.submitReport).not.toHaveBeenCalled();
  });

  test.each([null, "203.0.113.7, 198.51.100.2", "not-an-ip"])(
    "guest submission rejects a missing, multiple, or malformed trusted network value",
    async (realIp) => {
      // Catches raw or ambiguous proxy-header data crossing into Trust.
      const { handlers, report } = fixture();

      const response = await handlers.submitReport(reportRequest({ realIp }));

      expect(response.status).toBe(400);
      expect(report.submitReport).not.toHaveBeenCalled();
    },
  );

  test("guest submission derives a contextual HMAC and never passes the raw address", async () => {
    // Catches raw IP retention or the wrong network-HMAC composition.
    const { handlers, report } = fixture();

    const response = await handlers.submitReport(reportRequest());

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(report.submitReport).toHaveBeenCalledWith({
      requester: { kind: "guest", networkKeyHmac: expect.stringMatching(/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/) },
      target,
      reason: "other",
      detail: "Contextual report.",
      challenge: { token: "challenge-token", solution: 7 },
    });
    expect(JSON.stringify(report.submitReport.mock.calls)).not.toContain("203.0.113.7");
  });

  test("authenticated submission uses authoritative actor state and requires no proxy address", async () => {
    // Catches trusting body actor identity or incorrectly requiring guest network state.
    const { handlers, report } = fixture({ authenticated: true });

    const response = await handlers.submitReport(reportRequest({ challenge: null, realIp: null }));

    expect(response.status).toBe(202);
    expect(report.submitReport).toHaveBeenCalledWith({
      requester: { kind: "authenticated", actorUserId: "reporter-1" },
      target,
      reason: "other",
      detail: "Contextual report.",
    });
  });

  test("public report submission accepts a valid body at exactly 32 KiB", async () => {
    // Catches an off-by-one implementation that rejects the documented maximum.
    const { handlers, report } = fixture();
    const base = await reportRequest().text();
    const body = base.padEnd(32 * 1024, " ");

    const response = await handlers.submitReport(reportRequest({ body }));

    expect(new TextEncoder().encode(body)).toHaveLength(32 * 1024);
    expect(response.status).toBe(202);
    expect(report.submitReport).toHaveBeenCalledOnce();
  });

  test("unexpected hostile public-report errors still map to a stable safe response", async () => {
    // Catches error introspection exposing an unexpected report-service failure.
    const { handlers, report } = fixture();
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("do not expose this failure");
      },
    });
    report.submitReport.mockRejectedValueOnce(hostile);

    const response = await handlers.submitReport(reportRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "REPORT_NOT_ACCEPTED" });
  });

  test("challenge returns only the public challenge projection with private no-store", async () => {
    // Catches challenge responses leaking network or persistence facts.
    const { handlers } = fixture();

    const response = await handlers.challenge(new Request(`${origin}/api/v1/content-reports/challenge`, {
      headers: { "x-real-ip": "2001:db8::7" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      token: "challenge-token",
      difficulty: 18,
      expiresAt: "2026-08-31T12:10:00.000Z",
    });
  });

  test("owner triage requires authorization and mints an action-scoped proof from current assurance", async () => {
    // Catches owner authorization or fresh action-scoped TOTP proof bypasses.
    const denied = fixture();
    expect((await denied.handlers.queue(new Request(`${origin}/api/v1/admin/content-reports`))).status).toBe(403);

    const { handlers, issueOwnerStepUpProof, triage } = fixture({ authenticated: true, owner: true });
    const request = new Request(`${origin}/api/v1/admin/content-reports/${target.targetId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "hide-report-001",
        "if-match": "3",
        origin,
        "x-request-id": "triage-request",
      },
      body: JSON.stringify({ action: "hide", reason: "Violates the public-content policy." }),
    });

    const response = await handlers.triage(request, target.targetId);

    expect(response.status).toBe(200);
    expect(issueOwnerStepUpProof).toHaveBeenCalledWith({
      userId: "reporter-1",
      sessionId: "reporter-session",
      actionClass: "owner.public_report_hide",
      now: new Date("2026-08-31T12:00:00.000Z"),
    });
    expect(triage.hide).toHaveBeenCalledWith({
      ownerUserId: "reporter-1",
      ownerSessionId: "reporter-session",
      stepUpProofId: "server-proof:owner.public_report_hide",
      reportId: target.targetId,
      expectedVersion: 3,
      reason: "Violates the public-content policy.",
      idempotencyKey: "hide-report-001",
      requestId: "triage-request",
    });
  });

  test("authorized owner queue returns only the exact safe moderation projection", async () => {
    // Catches verbatim domain serialization exposing reporter, creator identity, or media facts.
    const { handlers } = fixture({ authenticated: true, owner: true });

    const response = await handlers.queue(new Request(`${origin}/api/v1/admin/content-reports`));

    expect(response.status).toBe(200);
    const serialized = await response.clone().text();
    expect(await response.json()).toEqual({
      reports: [{
        reportId: queueProjection.reportId,
        target,
        reason: "other",
        detail: "Contextual report.",
        state: "open",
        version: 3,
        snapshot: {
          target,
          pageId: target.targetId,
          canonicalHandle: "safe-artist",
          displayName: "Safe Artist",
          showcaseTitle: null,
        },
        activeHold: null,
        priorActions: [{
          action: "dismiss",
          reason: "Earlier review was incomplete.",
          beforeState: "open",
          afterState: "dismissed",
          resultingReportVersion: 2,
          occurredAt: "2026-08-31T11:00:00.000Z",
        }],
      }],
    });
    expect(serialized).not.toContain("authenticatedReporter");
    expect(serialized).not.toContain(privateCreatorSentinel);
    expect(serialized).not.toContain(privateMediaSentinel);
  });

  test.each([
    { ifMatch: null },
    { idempotencyKey: null },
    { action: "publish" },
  ] as const)("owner triage rejects invalid controls %#", async (overrides) => {
    // Catches optimistic-concurrency, replay, or closed-action controls being bypassed.
    const { handlers, issueOwnerStepUpProof, triage } = fixture({ authenticated: true, owner: true });

    const response = await handlers.triage(triageRequest(overrides), target.targetId);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(issueOwnerStepUpProof).not.toHaveBeenCalled();
    expect(triage.hide).not.toHaveBeenCalled();
  });

  test("unexpected hostile service errors still map to a stable safe response", async () => {
    // Catches error introspection allowing hostile persistence failures to escape the adapter.
    const { handlers, triage } = fixture({ authenticated: true, owner: true });
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("do not expose this failure");
      },
    });
    triage.hide.mockRejectedValueOnce(hostile);

    const response = await handlers.triage(triageRequest(), target.targetId);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "TRIAGE_UNAVAILABLE" });
  });
});
