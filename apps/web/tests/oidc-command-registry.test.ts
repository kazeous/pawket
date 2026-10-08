import { describe, expect, test, vi } from "vitest";
import { oidcCommand } from "../src/platform/oidc-command-registry.js";
import type { WebPlatformRuntime } from "../src/platform/runtime.js";

const id = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const freshness = { commission: { primaryFreshMs: 900_000, mfaFreshMs: 300_000 } };
const command = (path: string, method: "POST" | "PUT" = "POST") => oidcCommand({ method, path, body: "{}", idempotencyKey: "synthetic-command-key", ifMatch: null, returnPath: "/" }, freshness);
const shared = [
  ["proposals", "orders.commission_propose", "propose"],
  [`proposals/${child}/respond`, "orders.commission_proposal_respond", "respondProposal"],
  [`proposals/${child}/withdraw`, "orders.commission_proposal_withdraw", "withdrawProposal"],
  ["disputes", "orders.commission_dispute_open", "openDispute"],
  [`disputes/${child}/statements`, "orders.commission_dispute_statement", "addStatement"],
  [`disputes/${child}/withdraw`, "orders.commission_dispute_withdraw", "withdrawDispute"],
] as const;
const exclusive = [
  [false, `refunds/${child}/destination`, "payments.commission_refund_destination", true, "enterRefundDestination"],
  [false, `refunds/${child}/receipt`, "payments.commission_refund_receipt", false, "confirmRefundReceipt"],
  [true, `refunds/${child}/reveal`, "payments.commission_refund_reveal", true, "revealRefund"],
  [true, `refunds/${child}/send`, "payments.commission_refund_send", true, "recordRefundSend"],
  [false, "late-claim", "orders.commission_late_claim", false, "fileLateClaim"],
  [true, `late-claim/${child}/answer`, "orders.commission_late_claim_answer", true, "answerLateClaim"],
  [false, "suspension-cancel", "orders.commission_suspension_cancel", false, "cancelAfterSuspension"],
] as const;
describe("party resolution command registry", () => {
  test.each(shared)("%s resolves for both parties and dispatches the fixed role", async (suffix, actionClass, handler) => {
    for (const creator of [false, true]) {
      const back = `${creator ? "/creator" : ""}/commissions/${id}`; const result = command(`/api/v1${back}/${suffix}`)!;
      expect(result).toMatchObject({ policy: { actionClass, fresh: false }, returnPath: back }); expect(result.policy.primaryFreshMs).toBeUndefined();
      const execute = vi.fn().mockResolvedValue(new Response()); const request = new Request("https://pawket.example.invalid", { method: "POST" });
      await result.execute({ resolutionHandlers: { [handler]: execute } } as unknown as WebPlatformRuntime, request);
      expect(execute).toHaveBeenCalledWith(request, id, ...(suffix.includes(child) ? [child] : []), creator ? "creator" : "buyer");
    }
  });
  test.each(exclusive)("%s %s resolves with exact freshness and rejects the wrong prefix", async (creator, suffix, actionClass, fresh, handler) => {
    const back = `${creator ? "/creator" : ""}/commissions/${id}`; const result = command(`/api/v1${back}/${suffix}`)!;
    expect(result).toMatchObject({ policy: { actionClass, fresh, ...(fresh ? freshness.commission : {}) }, returnPath: back });
    if (!fresh) { expect(result.policy.primaryFreshMs).toBeUndefined(); expect(result.policy.mfaFreshMs).toBeUndefined(); }
    expect(command(`/api/v1${creator ? "" : "/creator"}/commissions/${id}/${suffix}`)).toBeNull();
    const execute = vi.fn().mockResolvedValue(new Response()); const request = new Request("https://pawket.example.invalid", { method: "POST" });
    await result.execute({ resolutionHandlers: { [handler]: execute } } as unknown as WebPlatformRuntime, request);
    expect(execute).toHaveBeenCalledWith(request, id, ...(suffix.includes(child) ? [child] : []));
  });
  test("reads, invalid IDs, and unknown paths cannot be resumed", () => {
    for (const suffix of ["resolution", "unknown", `refunds/${child}/unknown`]) expect(command(`/api/v1/commissions/${id}/${suffix}`)).toBeNull();
    expect(command(`/api/v1/commissions/${id}/proposals`, "PUT")).toBeNull(); expect(command("/api/v1/commissions/invalid/proposals")).toBeNull(); expect(command("/api/v1/help/cases")).toBeNull();
    expect(command(`/api/v1/creator/commissions/${id}/confirm`)?.policy).toEqual({ actionClass: "payments.commission_confirm", fresh: true, ...freshness.commission });
  });
});
