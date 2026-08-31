import { describe, expect, test, vi } from "vitest";

import { createMediaCommandHttpHandlers } from "../src/platform/media-command-http.js";

const origin = "https://pawket.example";
const intentId = "10000000-0000-4000-8000-000000000001";
const assetId = "20000000-0000-4000-8000-000000000002";

function fixture() {
  const media = {
    createUploadIntent: vi.fn(async (command: unknown) => command),
    completeUpload: vi.fn(async (command: unknown) => command),
  };
  const handlers = createMediaCommandHttpHandlers({
    appBaseUrl: origin,
    authenticate: vi.fn(async () => ({
      userId: "creator-1",
      sessionId: "creator-session",
      primaryAuthenticatedAt: new Date(),
    })),
    media,
  });
  return { handlers, media };
}

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/v1/creator-page/media/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "upload-key-001",
      origin,
      "x-request-id": "upload-request",
      ...headers,
    },
    body,
  });
}

describe("public media command HTTP boundary", () => {
  test("upload intent enforces exact origin, JSON, and the 32 KiB body bound", async () => {
    // Catches web routes bypassing mutation controls before the media service.
    const { handlers, media } = fixture();
    const valid = JSON.stringify({ purpose: "showcase", declaredSourceFormat: "webp", contentType: "image/webp", declaredBytes: 1024 });

    expect((await handlers.createUpload(request(valid, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await handlers.createUpload(request(valid, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handlers.createUpload(request("x".repeat(32_769)))).status).toBe(413);
    expect(media.createUploadIntent).not.toHaveBeenCalled();
  });

  test("upload intent uses the authoritative actor and header controls", async () => {
    // Catches actor, idempotency, or request IDs being accepted from the body.
    const { handlers, media } = fixture();

    const response = await handlers.createUpload(request(JSON.stringify({
      purpose: "avatar",
      declaredSourceFormat: "png",
      contentType: "image/png",
      declaredBytes: 4096,
    })));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(media.createUploadIntent).toHaveBeenCalledWith({
      actor: { userId: "creator-1" },
      purpose: "avatar",
      declaredSourceFormat: "png",
      contentType: "image/png",
      declaredBytes: 4096,
      idempotencyKey: "upload-key-001",
      requestId: "upload-request",
    });
  });

  test("upload completion binds the route intent ID and authenticates asset ownership", async () => {
    // Catches completion trusting a body-controlled intent or actor identifier.
    const { handlers, media } = fixture();

    const response = await handlers.completeUpload(request(JSON.stringify({ assetId })), intentId);

    expect(response.status).toBe(200);
    expect(media.completeUpload).toHaveBeenCalledWith({
      actor: { userId: "creator-1" },
      assetId,
      intentId,
      idempotencyKey: "upload-key-001",
      requestId: "upload-request",
    });
  });
});
