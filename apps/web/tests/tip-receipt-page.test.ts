import { describe, expect, test, vi } from "vitest";
import { resolveTipReceiptPage } from "../src/platform/tip-receipt-page";
import { readTipReceipt } from "../src/ui/tips/tip-client";

const reference = "PW0123456789ABCDEF0123";
const receipt = { reference, creator: { handle: "test-artist", displayName: "Artist" }, amountVnd: 50_000, currency: "VND", state: "confirmed", settlementLane: "manual_attested", confirmationSource: "creator_manual", confirmedAt: "2026-09-12T00:00:00Z", expiresAt: "2026-09-13T00:00:00Z", transferClaimedAt: null };
const data = { receipt, instruction: null, paymentsEnabled: false };
function input(response: Response, cookie = "") {
  return { reference, headers: new Headers({ cookie, "x-real-ip": "192.0.2.5" }), appBaseUrl: "https://pawket.test", handlers: { receipt: vi.fn(async () => response) }, authenticate: vi.fn(async (): Promise<{ userId: string } | null> => null) };
}
describe("server-rendered private receipt", () => {
  test("returns only the authorized display projection even when payments are disabled", async () => {
    const options = input(Response.json({ ...data, secret: "never serialized" }));
    expect(await resolveTipReceiptPage(options)).toEqual({ kind: "ready", data });
    expect(options.authenticate).not.toHaveBeenCalled();
    expect(options.handlers.receipt).toHaveBeenCalledWith(expect.any(Request), reference);
  });
  test("explains absent local access without disclosing whether a reference exists", async () => {
    for (const unknown of [reference, "PWFFFFFFFFFFFFFFFFFFFF"]) {
      expect(await resolveTipReceiptPage({ ...input(Response.json({ code: "not_available" }, { status: 404 })), reference: unknown })).toEqual({ kind: "unavailable", code: "missing_access" });
    }
    expect(await resolveTipReceiptPage(input(Response.json({ code: "not_available" }, { status: 404 }), `__Secure-pawket_tip_${reference}=invalid`))).toEqual({ kind: "unavailable", code: "not_available" });
    const signedIn = input(Response.json({ code: "not_available" }, { status: 404 })); signedIn.authenticate.mockResolvedValue({ userId: "other-buyer" });
    expect(await resolveTipReceiptPage(signedIn)).toEqual({ kind: "unavailable", code: "not_available" });
  });
  test("does not reflect dependency details or call services for malformed references", async () => {
    expect(await resolveTipReceiptPage(input(new Response("private internal failure", { status: 503 })))).toEqual({ kind: "unavailable", code: "dependency_unavailable" });
    const options = input(Response.json(data));
    expect(await resolveTipReceiptPage({ ...options, reference: "invalid" })).toEqual({ kind: "unavailable", code: "not_available" });
    expect(options.handlers.receipt).not.toHaveBeenCalled();
  });
  test("rejects unbound, terminal or disabled-mode instructions and inconsistent confirmation states", () => {
    expect(() => readTipReceipt(data, "PWFFFFFFFFFFFFFFFFFFFF")).toThrow();
    expect(() => readTipReceipt({ ...data, instruction: {} }, reference)).toThrow();
    expect(() => readTipReceipt({ ...data, receipt: { ...receipt, confirmedAt: null } }, reference)).toThrow();
    expect(() => readTipReceipt({ ...data, receipt: { ...receipt, state: "awaiting_transfer" } }, reference)).toThrow();
    expect(readTipReceipt({ ...data, receipt: { ...receipt, state: "expired", confirmedAt: null, confirmationSource: null } }, reference).receipt.state).toBe("expired");
  });
  test("requires lane-specific provenance and never treats provider evidence as manual attestation", () => {
    for (const confirmationSource of ["sepay_automatic", "creator_reviewed_sepay"]) {
      expect(readTipReceipt({ ...data, receipt: { ...receipt, settlementLane: "provider_bound", confirmationSource } }, reference).receipt.confirmationSource).toBe(confirmationSource);
      expect(() => readTipReceipt({ ...data, receipt: { ...receipt, confirmationSource } }, reference)).toThrow();
    }
    for (const change of [{ settlementLane: "provider_bound" }, { confirmationSource: null }, { settlementLane: undefined }, { confirmationSource: undefined }]) {
      expect(() => readTipReceipt({ ...data, receipt: { ...receipt, ...change } }, reference)).toThrow();
    }
  });
});
