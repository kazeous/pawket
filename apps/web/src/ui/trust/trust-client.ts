import { z } from "zod";
import { tipRequest } from "../tips/tip-client";

const uuid = z.uuid(); const time = z.iso.datetime();
export type TrustMode = "disabled" | "enabled";
export const penaltyKindLabels = { warning: "Cảnh cáo", restriction: "Hạn chế", suspension: "Tạm khóa", removal: "Gỡ bỏ" };
export const restrictionLabels = { commission_intake: "Nhận đơn commission", commission_buying: "Đặt commission", dispute_opening: "Mở khiếu nại", reporting: "Gửi báo cáo" };
export const appealStateLabels = { open: "Đang được Pawket xem xét", upheld: "Đã giữ nguyên biện pháp", reduced: "Đã giảm biện pháp", reversed: "Đã hủy biện pháp" };
export const reportStateLabels = { received: "Đã nhận", closed: "Đã xử lý" };
export const targetKindLabels = { commission_package: "Gói commission", commission_brief: "Brief", commission_message: "Tin nhắn", commission_file: "Tệp" };
export const penaltyStateLabels = { active: "Đang có hiệu lực", expired: "Đã hết hạn", lifted: "Đã gỡ", reversed: "Đã hủy", reduced: "Đã giảm biện pháp" };
export const penaltyTargetLabels = { creator_capability: "Quyền nghệ sĩ", account: "Tài khoản" };
export const penaltyReasonLabels = { spam_or_scam: "Spam hoặc lừa đảo", harassment_or_hate: "Quấy rối hoặc thù ghét", prohibited_or_age_restricted_content: "Nội dung bị cấm",
  intellectual_property: "Quyền sở hữu trí tuệ", privacy: "Quyền riêng tư", impersonation: "Mạo danh", refund_non_compliance: "Không thực hiện nghĩa vụ hoàn tiền", dispute_or_report_abuse: "Lạm dụng khiếu nại hoặc báo cáo", other: "Lý do khác" };
// Match the I3 reporting form's labels, including its additional violence reason.
export const reportReasonLabels = { privacy: "Quyền riêng tư", intellectual_property: "Quyền sở hữu trí tuệ", impersonation: "Mạo danh", spam_or_scam: "Spam hoặc lừa đảo",
  harassment_or_hate: "Quấy rối hoặc thù ghét", violence_or_self_harm: "Bạo lực hoặc tự gây hại", prohibited_or_age_restricted_content: "Nội dung bị cấm", other: "Lý do khác" };
const appealState = z.enum(["open", "upheld", "reduced", "reversed"]);
const appealFields = { canAppeal: z.boolean(), appealDeadline: time.nullable(), appealState: appealState.nullable() };
export const penaltySchema = z.object({ penaltyId: uuid, kind: z.enum(["warning", "restriction", "suspension", "removal"]),
  restriction: z.enum(["commission_intake", "commission_buying", "dispute_opening", "reporting"]).nullable(), target: z.enum(["creator_capability", "account"]).nullable(),
  reasonCategoryLabel: z.string(), explanation: z.string(), startsAt: time, endsAt: time.nullable(), endedAt: time.nullable(), acknowledgedAt: time.nullable(),
  state: z.enum(["active", "expired", "lifted", "reversed", "reduced"]), ...appealFields });
export const hideSchema = z.object({ hideId: uuid, targetKind: z.enum(["commission_message", "commission_file", "commission_package"]),
  hiddenAt: time, explanation: z.string(), releasedAt: time.nullable(), ...appealFields });
export const appealSchema = z.object({ appealId: uuid, penaltyId: uuid.nullable(), hideId: uuid.nullable(), state: appealState,
  reasoning: z.string().nullable(), createdAt: time, decidedAt: time.nullable() });
export const myTrustCasesSchema = z.object({ reportsFiled: z.array(z.object({ reportReference: z.string(), targetKind: z.enum(["commission_package", "commission_brief", "commission_message", "commission_file"]), state: z.enum(["received", "closed"]) })),
  penalties: z.array(penaltySchema), hides: z.array(hideSchema), appeals: z.array(appealSchema) });
export const reportResultSchema = z.object({ accepted: z.literal(true), reportReference: z.string().min(1) });
export const appealResultSchema = z.object({ appealId: uuid });
export const acknowledgeResultSchema = z.object({ acknowledged: z.literal(true) });
export const reportTargetSchema = z.union([z.strictObject({ kind: z.literal("commission_package"), packageId: uuid, revisionId: uuid }),
  z.strictObject({ kind: z.literal("commission_brief"), orderId: uuid }), z.strictObject({ kind: z.literal("commission_message"), orderId: uuid, messageId: uuid }),
  z.strictObject({ kind: z.literal("commission_file"), orderId: uuid, fileId: uuid })]);
export const normalizedTrustText = (minimum: number, maximum: number) => z.string().transform((value) => value.normalize("NFC").replace(/\r\n?/gu, "\n"))
  .refine((value) => value.trim().length > 0 || minimum === 0).refine((value) => [...value].length >= minimum && [...value].length <= maximum && !/[\p{Cc}\p{Cs}]/u.test(value.replaceAll("\n", "")));
export const reportInputSchema = z.strictObject({ target: reportTargetSchema, reason: z.enum(["privacy", "intellectual_property", "impersonation", "spam_or_scam", "harassment_or_hate", "violence_or_self_harm", "prohibited_or_age_restricted_content", "other"]), detail: normalizedTrustText(0, 1000).optional() });
export const appealInputSchema = z.strictObject({ target: z.union([z.strictObject({ penaltyId: uuid }), z.strictObject({ hideId: uuid })]), statement: normalizedTrustText(1, 4000) });
export const reportChallengeSchema = z.object({ token: z.string().min(1).max(512), difficulty: z.literal(18) });
export type ReportTarget = z.infer<typeof reportTargetSchema>;
export type AppealTarget = z.infer<typeof appealInputSchema>["target"];
export type PenaltyView = z.infer<typeof penaltySchema>;
export type HideView = z.infer<typeof hideSchema>;
export type AppealView = z.infer<typeof appealSchema>;
export type MyTrustCasesView = z.infer<typeof myTrustCasesSchema>;
export const trustClient = { request: (path: string, init: RequestInit = {}, maximumBytes = 131_072) => {
  const headers = new Headers(init.headers); headers.set("content-type", "application/json");
  if (!headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
  return tipRequest(path, { ...init, method: "POST", headers }, maximumBytes);
} };
export function trustErrorText(code: string) {
  const labels: Record<string, string> = { enforcement_disabled: "Tính năng báo cáo và kháng nghị đang tạm đóng.", REPORT_NOT_ACCEPTED: "Chưa thể gửi báo cáo. Hãy thử lại sau.",
    duplicate: "Bạn đã gửi yêu cầu cho nội dung này. Xem trạng thái trong Yêu cầu của tôi.", window_closed: "Đã hết hạn kháng nghị. Tải lại trang để kiểm tra.",
    restricted: "Tài khoản của bạn hiện bị hạn chế thao tác này.", invalid_request: "Kiểm tra nội dung và giới hạn ký tự trước khi gửi.", not_available: "Nội dung hoặc thao tác này hiện không khả dụng." };
  return labels[code];
}
