import { z } from "zod";
import { commissionPath, type Role } from "../commissions/commission-client";
import { tipRequest } from "../tips/tip-client";

const uuid = z.uuid(); const time = z.iso.datetime(); const amount = z.number().int().min(0).max(50_000_000);
export const proposalKinds = ["cancel_with_refund", "complete_with_refund"] as const;
export const reasonLabels = { not_delivered: "Chưa nhận được bài", not_as_agreed: "Không đúng thỏa thuận", incomplete_delivery: "Bàn giao chưa đầy đủ",
  creator_cannot_complete: "Nghệ sĩ không thể hoàn thành", communication_breakdown: "Mất liên lạc", other: "Lý do khác" };
const proposal = z.object({ id: uuid, proposerRole: z.enum(["buyer", "creator"]), kind: z.enum(proposalKinds), refundAmountVnd: amount,
  note: z.string(), state: z.enum(["pending", "accepted", "declined", "withdrawn", "expired", "lapsed", "superseded"]), stale: z.boolean(), respondBy: time.nullable(), createdAt: time, endedAt: time.nullable() });
export const refundSchema = z.object({ obligationId: uuid, source: z.string(), sourceId: uuid, amountVnd: amount, reference: z.string().regex(/^PKR[0-9A-HJKMNP-TV-Z]{12}$/u),
  state: z.enum(["awaiting_destination", "awaiting_send", "sent", "received", "presumed_received", "not_received", "waived"]),
  bankBin: z.string().nullable(), bankName: z.string().nullable(), suffix: z.string().nullable(), dueAt: time.nullable(), confirmBy: time.nullable(),
  endedAt: time.nullable(), destinationPurgedAt: time.nullable(), currentSendId: uuid.nullable(), hasRecordedSend: z.boolean(), version: z.number().int().positive(), createdAt: time,
  sends: z.array(z.object({ id: uuid, transferDate: z.string(), recordedAt: time, bankReference: z.string(), note: z.string().nullable() })) });
const lateClaim = z.object({ id: uuid, state: z.enum(["awaiting_creator", "escalated", "refund_owed", "rejected"]), transferAt: time, claimedAmountVnd: amount,
  bankReference: z.string(), note: z.string().nullable(), creatorRespondBy: time.nullable(), receivedAmountVnd: amount.nullable(), filedAt: time, endedAt: time.nullable() });
export const resolutionSchema = z.object({ controls: z.object({ mode: z.enum(["disabled", "enabled"]) }), resolution: z.object({ role: z.enum(["buyer", "creator"]),
  proposals: z.object({ pending: proposal.nullable(), history: z.array(proposal) }),
  dispute: z.object({ id: uuid, state: z.enum(["open", "withdrawn", "settled", "ruled", "superseded"]), reason: z.enum(Object.keys(reasonLabels) as [keyof typeof reasonLabels, ...Array<keyof typeof reasonLabels>]),
    trigger: z.string(), respondBy: time.nullable(), statements: z.array(z.object({ authorRole: z.enum(["buyer", "creator", "owner"]), kind: z.enum(["opening", "response", "statement", "question"]), text: z.string(), createdAt: time })),
    ruling: z.object({ outcome: z.enum(["complete", "close"]), refundAmountVnd: amount, reasoning: z.string(), ruledAt: time }).nullable() }).nullable(),
  refunds: z.array(refundSchema), lateClaim: lateClaim.nullable(), actions: z.object({ canPropose: z.boolean(), canOpenDispute: z.boolean(),
    disputeTrigger: z.enum(["final_delivery", "overdue", "proposal_declined"]).nullable(), disputeTriggerEndsAt: time.nullable(), canCancelAfterSuspension: z.boolean() }) }) });
export const myCasesSchema = z.object({ cases: z.object({ disputes: z.array(z.object({ id: uuid, orderId: uuid, state: z.string(), reason: z.string(), trigger: z.string(), openedAt: time, closedAt: time.nullable() })),
  refunds: z.array(refundSchema.extend({ orderId: uuid })), lateClaims: z.array(lateClaim.extend({ orderId: uuid })) }) });
export const revealSchema = z.object({ bankName: z.string(), accountNumber: z.string().regex(/^[0-9]{6,19}$/u), accountHolder: z.string(), amountVnd: amount,
  reference: z.string(), qrPayload: z.string().min(50).max(1000), dueAt: time });
export type ResolutionView = z.infer<typeof resolutionSchema>;
export type RefundView = z.infer<typeof refundSchema>;
export type MyCasesView = z.infer<typeof myCasesSchema>["cases"];
export type ResolutionAction = "propose" | "respondProposal" | "withdrawProposal" | "openDispute" | "addStatement" | "withdrawDispute"
  | "enterDestination" | "confirmReceipt" | "reveal" | "recordSend" | "fileLateClaim" | "answerLateClaim" | "cancelAfterSuspension";
export function resolutionPath(role: Role, orderId: string, action: ResolutionAction, targetId?: string) {
  const suffixes: Record<ResolutionAction, string> = { propose: "proposals", respondProposal: `proposals/${targetId}/respond`, withdrawProposal: `proposals/${targetId}/withdraw`,
    openDispute: "disputes", addStatement: `disputes/${targetId}/statements`, withdrawDispute: `disputes/${targetId}/withdraw`, enterDestination: `refunds/${targetId}/destination`,
    confirmReceipt: `refunds/${targetId}/receipt`, reveal: `refunds/${targetId}/reveal`, recordSend: `refunds/${targetId}/send`, fileLateClaim: "late-claim",
    answerLateClaim: `late-claim/${targetId}/answer`, cancelAfterSuspension: "suspension-cancel" };
  return `/api/v1${commissionPath(role)}/${orderId}/${suffixes[action]}`;
}
// Use the same bounded request and opaque OIDC redirect as all commission commands.
export const resolutionRequest: typeof tipRequest = (path, init = {}, maximumBytes = 131_072) => {
  const headers = new Headers(init.headers); headers.set("content-type", "application/json");
  if (!headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
  return tipRequest(path, { ...init, method: "POST", headers }, maximumBytes);
};
export function disputeBefore(trigger: string | null, endsAt: string): string {
  return new Date(Date.parse(endsAt) + (trigger === "proposal_declined" ? 1 : 0)).toISOString();
}
export const resolutionText = (value: string, maximum: number) => { const text = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim(); return !!text && [...text].length <= maximum && !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}]/u.test(text); };
export const proposalStateLabels = { pending: "Đang chờ phản hồi", accepted: "Đã đồng ý", declined: "Đã từ chối", withdrawn: "Đã rút", expired: "Đã hết hạn", lapsed: "Không còn phù hợp", superseded: "Đã thay thế" };
export const refundStateLabels = { awaiting_destination: "Chờ tài khoản nhận hoàn tiền", awaiting_send: "Chờ chuyển hoàn tiền", sent: "Nghệ sĩ đã ghi nhận chuyển", received: "Đã nhận tiền",
  presumed_received: "Hết hạn xác nhận hoàn tiền", not_received: "Đã báo chưa nhận tiền · Pawket đang xem xét", waived: "Khoản hoàn tiền đã được miễn" };
export const claimStateLabels = { awaiting_creator: "Chờ nghệ sĩ đối chiếu", escalated: "Pawket đang xem xét", refund_owed: "Đã xác nhận khoản cần hoàn", rejected: "Yêu cầu không được chấp nhận" };
