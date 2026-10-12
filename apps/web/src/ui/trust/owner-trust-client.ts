import { z } from "zod";
import { normalizedTrustText, penaltyKindLabels, penaltyTargetLabels, restrictionLabels, penaltyReasonLabels } from "./trust-client";
export { penaltyKindLabels, penaltyTargetLabels, restrictionLabels, penaltyReasonLabels };
const time = z.iso.datetime(); const uuid = z.uuid();
export const ownerPenaltiesSchema = z.object({ penalties: z.array(z.object({ penaltyId: uuid, subjectUserId: z.string().min(1), kind: z.enum(["warning", "restriction", "suspension", "removal"]),
  restriction: z.enum(["commission_intake", "commission_buying", "dispute_opening", "reporting"]).nullable(), target: z.enum(["creator_capability", "account"]).nullable(), reasonCategory: z.enum(["spam_or_scam", "harassment_or_hate", "prohibited_or_age_restricted_content", "intellectual_property", "privacy", "impersonation", "refund_non_compliance", "dispute_or_report_abuse", "other"]), explanation: z.string(), startsAt: time, endsAt: time.nullable(), sourceCaseId: uuid.nullable(), sourcePublicReportId: uuid.nullable(), state: z.literal("active") })).max(100) });
export type OwnerPenalty = z.infer<typeof ownerPenaltiesSchema>["penalties"][number];
export const policyKindLabels = { community_rules: "Quy định cộng đồng", enforcement_appeals: "Chính sách xử lý vi phạm và kháng nghị" };
export const ownerPoliciesSchema = z.object({ policies: z.array(z.object({ kind: z.enum(["community_rules", "enforcement_appeals"]), current: z.object({ revisionId: uuid, kind: z.enum(["community_rules", "enforcement_appeals"]), revisionNumber: z.number().int().positive(), document: z.string(), effectiveAt: time }).nullable() })).length(2) });
export type OwnerPolicy = z.infer<typeof ownerPoliciesSchema>["policies"][number];
export function ownerText(value: FormDataEntryValue | null, maximum: number, multiline = true): string | null {
  const result = normalizedTrustText(1, maximum).safeParse(typeof value === "string" ? value.trim() : value);
  if (!result.success || !multiline && result.data.includes("\n")) return null;
  return result.data;
}
export function penaltyEffect(kind: keyof typeof penaltyKindLabels, target: keyof typeof penaltyTargetLabels, restriction: keyof typeof restrictionLabels) {
  if (kind === "warning") return "Người dùng sẽ thấy cảnh cáo cho đến khi xác nhận đã hiểu. Quyền sử dụng vẫn giữ nguyên.";
  if (kind === "restriction") return `Người dùng sẽ bị hạn chế thao tác: ${restrictionLabels[restriction]}.`;
  if (kind === "suspension") return target === "account" ? "Tạm khóa tài khoản sẽ đăng xuất người dùng khỏi mọi phiên." : "Tạm khóa quyền nghệ sĩ sẽ ẩn trang và dừng nhận đơn mới. Các đơn đang thực hiện vẫn tiếp tục nếu không chọn đóng băng.";
  return target === "account" ? "Đóng tài khoản sẽ đăng xuất người dùng khỏi mọi phiên. Nếu có quyền nghệ sĩ, quyền đó sẽ bị gỡ và mọi đơn đã thanh toán đang thực hiện sẽ đóng, phát sinh hoàn tiền toàn bộ." : "Gỡ quyền nghệ sĩ sẽ ẩn trang, dừng nhận đơn và đóng mọi đơn đã thanh toán đang thực hiện, phát sinh hoàn tiền toàn bộ.";
}
