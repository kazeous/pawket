import { afterEach, describe, expect, test, vi } from "vitest";
import { formatVnd, readCreatedInstruction, tipErrorText, tipRequest } from "../src/ui/tips/tip-client";

afterEach(() => vi.unstubAllGlobals());
describe("private tip browser boundary", () => {
  test("rejects oversized, malformed and non-JSON responses with a stable safe error", async () => {
    for (const response of [new Response("private html", { headers: { "content-type": "text/html" } }),
      new Response('"' + "x".repeat(16_385) + '"', { headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
      new Response("bad json", { headers: { "content-type": "application/json" } })]) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await expect(tipRequest("/api/v1/tips/example")).rejects.toMatchObject({ code: "dependency_unavailable", message: "dependency_unavailable" });
    }
  });
  test("uses private fetch policy and never displays a remote error message", async () => {
    const fetcher = vi.fn(async () => Response.json({ code: "unknown_sensitive_value", message: "private account" }, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(tipRequest("/api/v1/tips/example")).rejects.toMatchObject({ code: "unknown_sensitive_value" });
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/tips/example", expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" })]);
    expect(tipErrorText("unknown_sensitive_value")).not.toMatch(/unknown_sensitive_value|private account/u);
  });
  test("requires creator, amount and pending-state binding before displaying a destination", () => {
    const instruction = { reference: "PW0123456789ABCDEF0123", creator: { displayName: "Artist", handle: "test-artist" }, amountVnd: 50_000, currency: "VND", state: "awaiting_transfer",
      expiresAt: "2026-10-01T00:00:00.000Z", confirmedAt: null, transferClaimedAt: null,
      destination: { bankBin: "970436", bankName: "Vietcombank", accountNumber: "0000001234567", accountName: "TEST ARTIST" }, qrPayload: "0".repeat(100) };
    expect(readCreatedInstruction({ instruction: { ...instruction, privateField: "never kept" } }, "test-artist", 50_000)).toEqual(instruction);
    for (const changed of [{ creator: { handle: "other-artist", displayName: "Other" } }, { amountVnd: 100_000 }, { state: "confirmed" }, { reference: "invalid" }]) {
      expect(() => readCreatedInstruction({ instruction: { ...instruction, ...changed } }, "test-artist", 50_000)).toThrow("dependency_unavailable");
    }
    expect(formatVnd(5_000_000)).toBe("5.000.000 ₫");
  });
});
