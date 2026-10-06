import type { OidcCommandPolicy, OidcPendingPayload, OidcFreshness } from "@pawket/identity";
import type { WebPlatformRuntime } from "./runtime.js";

type Command = { policy: OidcCommandPolicy; title: string; returnPath: string;
  execute: (runtime: WebPlatformRuntime, request: Request) => Promise<Response> };
const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
function action(payload: OidcPendingPayload, allowed: readonly string[]) {
  try { const value: unknown = JSON.parse(payload.body); if (!value || typeof value !== "object" || !("action" in value)) return null;
    return typeof value.action === "string" && allowed.includes(value.action) ? value.action : null;
  } catch { return null; }
}

/** Only these existing application handlers can be resumed. No arbitrary URL fetch or action supplied by the client. */
export function oidcCommand(payload: OidcPendingPayload, freshness: { tip?: OidcFreshness; commission?: OidcFreshness } = {}): Command | null {
  if (payload.method !== "POST") return null;
  const { path } = payload;
  const make = (actionClass: string, fresh: boolean, title: string, returnPath: string, execute: Command["execute"]): Command =>
    ({ policy: { actionClass, fresh, ...(actionClass === "payments.commission_confirm" ? freshness.commission :
      ["payments.tip_confirm", "catalog.tip_settings"].includes(actionClass) ? freshness.tip : {}) }, title, returnPath, execute });
  let match: RegExpExecArray | null;
  if (path === "/api/v1/creator-application/receiving-account") return make("payments.receiving_account", true, "Cập nhật tài khoản nhận tiền", "/creator/apply", (r, q) => r.paymentsHandlers.proposeReceivingAccount(q));
  if ((match = new RegExp(`^/api/v1/creator/tips/${uuid}/confirm$`, "u").exec(path))) {
    const id = match[1]!; return make("payments.tip_confirm", true, "Xác nhận đã nhận tip", "/creator/tips", (r, q) => r.creatorTipHandlers.confirm(q, id));
  }
  if (path === "/api/v1/creator/tip-settings") return make("catalog.tip_settings", true, "Cập nhật nhận tip", "/creator/tips", (r, q) => r.creatorTipSettingsHandlers.save(q));
  if (path === "/api/v1/commissions") return make("orders.commission_request", false, "Gửi yêu cầu commission", "/commissions", (r, q) => r.commissionHandlers.request(q));
  if (path === "/api/v1/creator/commissions/packages") return make("catalog.commission_package", false, "Lưu gói commission", "/creator/commissions", (r, q) => r.commissionHandlers.savePackage(q));
  if (path === "/api/v1/creator/commissions/packages/change") return make("catalog.commission_publish", false, "Cập nhật gói commission", "/creator/commissions", (r, q) => r.commissionHandlers.changePackage(q));
  if (path === "/api/v1/creator/commissions/settings") return make("catalog.commission_settings", false, "Cập nhật nhận commission", "/creator/commissions", (r, q) => r.commissionHandlers.saveSettings(q));
  if ((match = new RegExp(`^/api/v1/creator/commissions/${uuid}/submissions$`, "u").exec(path))) {
    const id = match[1]!; return make("orders.commission_submit", false, "Cập nhật commission", `/creator/commissions/${id}`, (r, q) => r.commissionHandlers.submit(q, id));
  }
  if ((match = new RegExp(`^/api/v1/commissions/${uuid}/submissions/${uuid}/respond$`, "u").exec(path))) {
    const id = match[1]!; const submissionId = match[2]!;
    return make("orders.commission_respond", false, "Cập nhật commission", `/commissions/${id}`, (r, q) => r.commissionHandlers.respond(q, id, submissionId));
  }
  if ((match = new RegExp(`^/api/v1/(creator/)?commissions/${uuid}/(accept|quote|close|claim|confirm)$`, "u").exec(path))) {
    const creator = Boolean(match[1]); const id = match[2]!; const operation = match[3]!;
    if ((operation === "quote" || operation === "confirm") && !creator) return null;
    if (operation === "claim" && creator) return null;
    const back = `${creator ? "/creator" : ""}/commissions/${id}`;
    if (operation === "confirm") return make("payments.commission_confirm", true, "Xác nhận thanh toán commission", back, (r, q) => r.commissionHandlers.confirm(q, id));
    return make(`orders.commission_${operation}`, false, "Cập nhật commission", back,
      (r, q) => r.commissionHandlers.mutate(q, id, creator ? "creator" : "buyer", operation as "accept" | "quote" | "close" | "claim"));
  }
  if (path === "/api/v1/creator/tips/sepay/start") return make("payments.sepay_start", true, "Kết nối SePay", "/creator/tips/sepay", (r, q) => r.sepayHandlers.start(q));
  if ((match = new RegExp(`^/api/v1/creator/tips/sepay/${uuid}/(bind|change)$`, "u").exec(path))) {
    const id = match[1]!; const operation = match[2] as "bind" | "change";
    return make(`payments.sepay_${operation}`, true, "Cập nhật kết nối SePay", "/creator/tips/sepay", (r, q) => r.sepayHandlers[operation](q, id));
  }
  if ((match = new RegExp(`^/api/v1/creator/tips/sepay/reviews/${uuid}/(confirm|decide)$`, "u").exec(path))) {
    const id = match[1]!; const operation = match[2] as "confirm" | "decide";
    return make(`payments.sepay_${operation}`, operation === "confirm", "Xử lý giao dịch SePay", "/creator/tips/sepay", (r, q) => r.sepayHandlers[operation](q, id));
  }
  if (path === "/api/v1/admin/tip-policy") return make("owner.tip_policy_update", true, "Cập nhật chính sách tip", "/admin/tip-policy", (r, q) => r.tipPolicyHandlers.save(q));
  if ((match = new RegExp(`^/api/v1/admin/creator-applications/${uuid}/(detail|claim|decision|deposit/challenge)$`, "u").exec(path))) {
    const id = match[1]!; const operation = match[2]!; const back = "/admin/creator-applications";
    if (operation === "deposit/challenge") return make("owner.verification_deposit_challenge", true, "Tạo yêu cầu xác minh tài khoản", back, (r, q) => r.paymentsHandlers.issueChallenge(q, id));
    if (operation === "detail") return make("owner.creator_application_detail", true, "Xem hồ sơ nghệ sĩ", back, (r, q) => r.creatorReviewHandlers.detail(q, id));
    if (operation === "claim") return make("owner.creator_application_claim", false, "Nhận duyệt hồ sơ", back, (r, q) => r.creatorReviewHandlers.claim(q, id));
    const decision = action(payload, ["request_changes", "approve", "reject", "reopen"]);
    return decision ? make(`owner.creator_application_${decision}`, true, "Duyệt hồ sơ nghệ sĩ", back, (r, q) => r.creatorReviewHandlers.decide(q, id)) : null;
  }
  if ((match = /^\/api\/v1\/admin\/creator-capabilities\/([A-Za-z0-9._:-]{1,200})$/u.exec(path))) {
    const id = match[1]!; const decision = action(payload, ["suspend", "reinstate"]);
    return decision ? make(`owner.creator_capability_${decision}`, true, "Cập nhật quyền nghệ sĩ", "/admin/creator-applications", (r, q) => r.creatorReviewHandlers.setCapability(q, id)) : null;
  }
  if (path === "/api/v1/admin/verification-deposits/reconcile") return make("owner.verification_deposit_reconciliation", true, "Đối soát khoản xác minh", "/admin/creator-applications", (r, q) => r.paymentsHandlers.reconcileDeposit(q));
  if ((match = new RegExp(`^/api/v1/admin/refund-obligations/${uuid}/(reveal|refund)$`, "u").exec(path))) {
    const id = match[1]!;
    return match[2] === "reveal" ? make("owner.refund_destination_reveal", true, "Xem tài khoản hoàn tiền", "/admin/creator-applications", (r, q) => r.paymentsHandlers.revealRefundDestination(q, id))
      : make("owner.refund", true, "Ghi nhận hoàn tiền", "/admin/creator-applications", (r, q) => r.paymentsHandlers.recordRefund(q, id));
  }
  if ((match = new RegExp(`^/api/v1/admin/content-reports/${uuid}$`, "u").exec(path))) {
    const id = match[1]!; const decision = action(payload, ["dismiss", "hide", "restore"]);
    return decision ? make(`owner.public_report_${decision}`, true, "Xử lý báo cáo nội dung", "/admin/content-reports", (r, q) => r.trustHandlers.triage(q, id)) : null;
  }
  return null;
}
