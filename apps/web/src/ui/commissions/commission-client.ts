import { z } from "zod";
import { TipRequestError, tipRequest } from "@/ui/tips/tip-client";

const uuid = z.uuid();
const time = z.iso.datetime();
const text = (max: number) => z.string().refine((value) => [...value].length <= max);
const amount = z.number().int().min(50_000).max(50_000_000);
export const routeSchema = z.enum(["fixed_immediate", "fixed_approval", "custom_quote"]);
export const stateSchema = z.enum(["requested", "quoted", "awaiting_payment", "in_progress", "delivered", "completed", "closed"]);
export const termsSchema = z.object({ amountVnd: amount, turnaroundDays: z.number().int().min(1).max(90),
  revisionAllowance: z.number().int().min(0).max(10), reviewWindowDays: z.number().int().min(3).max(14),
  scope: text(2000), deliverables: text(2000), usageRights: text(2000), artistTerms: text(2000), policyRevisionId: uuid });
export const draftSchema = z.object({ title: text(120), description: text(2000), discipline: text(80), route: routeSchema,
  briefInstructions: text(2000), terms: termsSchema.nullable(), showcaseId: uuid.nullable() });
const publicPackageSchema = z.object({ id: uuid, revisionId: uuid, title: text(120), description: text(2000), discipline: text(80),
  route: routeSchema, briefInstructions: text(2000), terms: termsSchema.nullable(), showcaseId: uuid.nullable(),
  policy: z.object({ revisionId: uuid, document: z.string().nullable(), checksum: z.string() }).nullable(), accepting: z.boolean(), capacityAvailable: z.boolean() });
export const publicPackagesSchema = z.object({ packages: z.array(publicPackageSchema).max(12) });
const controlsSchema = z.object({ intakeMode: z.enum(["disabled", "enabled"]), paymentsMode: z.enum(["disabled", "manual_only", "sepay_optional"]) });
export const workspaceSchema = z.object({ controls: controlsSchema, workspace: z.object({ pageId: uuid.nullable(),
  showcases: z.array(z.object({ id: uuid, title: text(100) })).max(12),
  policy: z.object({ revisionId: uuid, document: z.string().nullable(), acceptsOrders: z.boolean() }).nullable(),
  settings: z.object({ version: z.number().int().nonnegative(), enabled: z.boolean(), capacityLimit: z.number().int().min(1).max(20), used: z.number().int().nonnegative() }),
  intakePause: z.object({ paused: z.boolean(), overdue: z.array(z.object({ obligationId: uuid, dueAt: time })) }).optional(),
  packages: z.array(z.object({ id: uuid, version: z.number().int().positive(), state: z.enum(["draft", "open", "paused"]),
    publishedRevisionId: uuid.nullable(), draft: draftSchema })).max(12) }) });
const paymentSchema = z.object({ id: uuid, orderId: uuid, amountVnd: amount, state: z.enum(["awaiting_transfer", "confirmed", "expired", "rejected"]),
  destination: z.object({ bankBin: z.string().regex(/^[0-9]{6}$/u), bankName: text(120), accountNumber: z.string().regex(/^[0-9]{6,19}$/u), accountName: text(120) }),
  reference: z.string().regex(/^PW[A-F0-9]{20}$/u), expiresAt: time, confirmedAt: time.nullable(), transferClaimedAt: time.nullable(),
  settlementLane: z.enum(["manual_attested", "provider_bound"]), confirmationSource: z.enum(["creator_manual", "sepay_automatic", "creator_reviewed_sepay"]).nullable(),
  instruction: z.object({ creator: z.object({ displayName: text(80), handle: z.string().max(30) }), reference: z.string().regex(/^PW[A-F0-9]{20}$/u), amountVnd: amount,
    expiresAt: time, qrPayload: z.string().min(50).max(1000), settlementLane: z.enum(["manual_attested", "provider_bound"]),
    destination: z.object({ bankBin: z.string().regex(/^[0-9]{6}$/u), bankName: text(120), accountNumber: z.string().regex(/^[0-9]{6,19}$/u), accountName: text(120) }) }).nullable() });
export const referenceFileSchema = z.object({ fileId: uuid, name: z.string().max(255).nullable(), sizeBytes: z.number().int().min(1).max(262_144_000), detectedType: z.enum(["jpeg", "png", "webp", "gif", "pdf", "psd", "clip", "zip"]), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u), previewable: z.boolean(), availability: z.enum(["available", "withdrawn", "deleted"]) });
export type ReferenceFileView = z.infer<typeof referenceFileSchema>;
const attachedFileSchema = referenceFileSchema.extend({ availability: z.enum(["available", "deleted"]) });
export const submissionSchema = z.object({ sequence: z.number().int().positive(), kind: z.literal("submission"), id: uuid, submissionKind: z.enum(["draft", "final"]),
  note: text(2000).nullable(), files: z.array(attachedFileSchema).min(1).max(20), submittedAt: time, late: z.boolean(),
  response: z.enum(["approved", "changes_requested", "superseded"]).nullable(), responseNote: text(2000).nullable(), respondedAt: time.nullable(), actionable: z.boolean() });
export const threadSchema = z.object({ thread: z.object({ items: z.array(z.discriminatedUnion("kind", [
  z.object({ sequence: z.number().int().positive(), kind: z.literal("message"), id: uuid, author: z.enum(["buyer", "creator"]), text: text(4000).nullable(), files: z.array(attachedFileSchema).max(10), createdAt: time }),
  submissionSchema,
])).max(50), nextBeforeSequence: z.number().int().positive().nullable(), writable: z.boolean() }) });
export const messageResultSchema = z.object({ message: z.object({ messageId: uuid, sequence: z.number().int().positive() }) });
export const detailSchema = z.object({ controls: controlsSchema.extend({ fulfillmentMode: z.enum(["disabled", "enabled"]) }), order: z.object({ id: uuid, version: z.number().int().positive(), role: z.enum(["buyer", "creator"]),
  state: stateSchema, route: routeSchema, closeReason: z.string().nullable(), createdAt: time, expiresAt: time.nullable(), acceptedAt: time.nullable(), confirmedAt: time.nullable(),
  dueAt: time.nullable(), overdue: z.boolean(), deadlinePassed: z.boolean(),
  fulfillment: z.object({ deliveredAt: time.nullable(), reviewEndsAt: time.nullable(), completionDueAt: time.nullable(), completedAt: time.nullable(),
    completionKind: z.enum(["buyer_accepted", "review_window_elapsed", "agreement", "ruling"]).nullable(), revisionsUsed: z.number().int().min(0).max(10), revisionAllowance: z.number().int().min(0).max(10),
    lateDelivery: z.boolean(), fileDeletionAt: time.nullable() }).nullable(), package: z.object({ id: uuid, revisionId: uuid, title: text(120) }),
  brief: z.object({ text: text(3000), referenceLinks: z.array(z.url({ protocol: /^https$/u })).max(5) }), referenceFiles: z.array(referenceFileSchema).max(10), terms: termsSchema.nullable(),
  policy: z.object({ id: uuid, document: z.string().nullable(), checksum: z.string() }).nullable(),
  currentPolicy: z.object({ revisionId: uuid, document: z.string().nullable(), acceptsOrders: z.boolean() }).nullable(),
  quote: z.object({ id: uuid, revisionNumber: z.number().int().positive(), issuedAt: time, expiresAt: time }).nullable(), payment: paymentSchema.nullable() }) });
export const ordersSchema = z.object({ orders: z.object({ items: z.array(z.object({ id: uuid, state: stateSchema, version: z.number().int().positive(), route: routeSchema,
  amountVnd: amount.nullable(), createdAt: time, expiresAt: time.nullable(), dueAt: time.nullable(), reviewEndsAt: time.nullable(), awaitingBuyer: z.boolean(), overdue: z.boolean(), title: text(120) })).max(50),
  nextBefore: z.object({ id: uuid, createdAt: time }).nullable() }) });
export const quotesSchema = z.object({ history: z.object({ items: z.array(z.object({ id: uuid, revisionNumber: z.number().int().positive(), issuedAt: time, expiresAt: time, terms: termsSchema })).max(25), nextBeforeRevision: z.number().int().positive().nullable() }) });
export const timelineSchema = z.object({ history: z.object({ items: z.array(z.object({ version: z.number().int().positive(), type: z.string(), reason: z.string().nullable(), occurredAt: time })).max(50), nextBeforeVersion: z.number().int().positive().nullable() }) });
export const orderResultSchema = z.object({ orderId: uuid });
export type TermsView = z.infer<typeof termsSchema>;
export type PackageDraft = z.infer<typeof draftSchema>;
export type PublicPackage = z.infer<typeof publicPackageSchema>;
export type WorkspaceView = z.infer<typeof workspaceSchema>;
export type OrderView = z.infer<typeof detailSchema>;
export type OrdersView = z.infer<typeof ordersSchema>["orders"];
export type QuotesView = z.infer<typeof quotesSchema>["history"];
export type TimelineView = z.infer<typeof timelineSchema>["history"];
export type ThreadView = z.infer<typeof threadSchema>["thread"];
export type SubmissionView = z.infer<typeof submissionSchema>;
export type Role = "buyer" | "creator";
export const commissionPath = (role: Role) => role === "creator" ? "/creator/commissions" : "/commissions";
export const routeLabels = { fixed_immediate: "Giá cố định · đặt ngay", fixed_approval: "Giá cố định · nghệ sĩ duyệt", custom_quote: "Báo giá riêng" };
export const stateLabels = { requested: "Chờ nghệ sĩ", quoted: "Chờ duyệt báo giá", awaiting_payment: "Chờ thanh toán", in_progress: "Đang thực hiện", delivered: "Đã giao, chờ duyệt", completed: "Hoàn tất", closed: "Đã đóng" };
export const closeLabels: Record<string, string> = { buyer_withdrawn: "Người đặt đã rút yêu cầu", creator_declined: "Nghệ sĩ đã từ chối", quote_withdrawn: "Nghệ sĩ đã rút báo giá", quote_declined: "Người đặt đã từ chối báo giá",
  cancelled_by_agreement: "Đã hủy theo thỏa thuận", cancelled_by_ruling: "Đã hủy theo kết luận của Pawket", buyer_cancelled_after_suspension: "Người đặt đã hủy sau khi nghệ sĩ bị tạm ngưng", fulfillment_frozen: "Pawket đã dừng thực hiện đơn",
  request_expired: "Yêu cầu đã hết hạn", quote_expired: "Báo giá đã hết hạn", buyer_cancelled: "Người đặt đã hủy", creator_cancelled: "Nghệ sĩ đã hủy", payment_expired: "Hết hạn thanh toán", security_invalidated: "Đơn bị đóng do điều kiện an toàn", eligibility_invalidated: "Điều kiện nhận thanh toán đã thay đổi" };
export function commissionErrorText(code: string, context: "brief" | "thread" | "submission" = "brief"): string {
  if (code === "OIDC_ACTOR_CHANGED") code = "account_changed";
  const messages: Record<string, string> = { authentication_required: "Đăng nhập lại để tiếp tục.", account_changed: "Tài khoản đã thay đổi. Mở lại trang bằng tài khoản ban đầu để tiếp tục.",
    recent_auth_required: "Cần xác thực lại trước khi xác nhận tiền.", totp_required: "Cần xác thực hai bước trước khi xác nhận tiền.", not_available: "Nội dung hoặc thao tác này hiện không khả dụng.",
    intake_disabled: "Tạm dừng nhận yêu cầu và báo giá mới. Lịch sử vẫn được giữ.", payments_disabled: "Tạm dừng thanh toán. Thời hạn của đơn vẫn tiếp tục tính.",
    version_conflict: "Nội dung đã thay đổi. Tải lại trang và xem lại trước khi tiếp tục.", policy_changed: "Chính sách đã thay đổi hoặc chưa sẵn sàng. Tải lại để kiểm tra.",
    capacity_full: "Nghệ sĩ đã hết suất nhận việc. Vui lòng quay lại sau.", request_limit: "Bạn đã có tối đa 3 yêu cầu hoặc đơn đang mở với nghệ sĩ này.",
    expired: "Đã quá thời hạn. Tải lại để xem trạng thái mới.", invalid_transition: "Trạng thái đơn đã đổi. Tải lại để kiểm tra.",
    idempotency_conflict: "Yêu cầu này không còn khớp. Kiểm tra lại lịch sử trước khi thao tác tiếp.", evidence_mismatch: "Thông tin chưa khớp giao dịch cần xác nhận. Kiểm tra số tiền và nội dung chuyển khoản.",
    bank_transaction_conflict: "Mã giao dịch ngân hàng đã được sử dụng. Kiểm tra lịch sử thanh toán.", intent_not_pending: "Thanh toán không còn ở trạng thái chờ. Tải lại đơn để kiểm tra.",
    invalid_request: "Dữ liệu chưa hợp lệ. Kiểm tra các trường và giới hạn nội dung.", invalid_terms: "Điều khoản chưa hợp lệ. Kiểm tra số tiền, thời hạn và nội dung.", invalid_brief: "Brief cần 1–3.000 ký tự và tối đa 5 liên kết HTTPS riêng biệt.",
    invalid_reference_files: "Một số tệp tham khảo chưa sẵn sàng hoặc không còn dùng được. Kiểm tra lại danh sách tệp.",
    files_disabled: "Tạm dừng nhận tệp tham khảo. Bạn vẫn có thể gửi brief chỉ có chữ và liên kết.",
    fulfillment_disabled: "Tạm dừng trao đổi và giao bài. Lịch sử vẫn được giữ.", revisions_exhausted: "Đã dùng hết lượt chỉnh sửa.",
    resolution_disabled: "Tạm dừng xử lý hủy đơn, khiếu nại và hoàn tiền. Bạn vẫn xem được lịch sử.",
    deadline_passed: "Đã quá thời hạn. Cập nhật trạng thái để kiểm tra.", proposal_stale: "Đơn đã thay đổi sau khi gửi đề nghị. Cập nhật trạng thái và xem lại.",
    proposal_limit: "Bạn đã dùng hết 3 đề nghị cho đơn này.", statement_limit: "Bạn đã dùng hết 10 lần trình bày cho khiếu nại này.",
    invalid_destination: "Kiểm tra lại ngân hàng, số tài khoản và tên chủ tài khoản nhận hoàn tiền.",
    invalid_statement: "Trình bày cần 1–4.000 ký tự hợp lệ.", invalid_proposal: "Kiểm tra loại đề nghị, số tiền và lời nhắn.",
    completion_held: "Đơn đang được tạm giữ, chưa thể hoàn tất.", order_quota_exceeded: "Đơn đã dùng hết 1 GB dung lượng tệp.",
    invalid_attachment_files: "Một số tệp đính kèm chưa sẵn sàng hoặc không dùng được. Kiểm tra lại danh sách tệp.",
    file_too_large: context === "submission" ? "Tệp vượt quá 250 MB." : "Tệp vượt quá 25 MB.", pending_limit: "Đang có tối đa 10 tệp chờ tải hoặc kiểm tra. Đợi các tệp đó xong rồi thử lại.",
    unsent_limit: "Bạn chỉ giữ được tối đa 10 tệp chưa gửi. Gỡ bớt tệp rồi thử lại.", upload_expired: "Liên kết tải lên đã hết hạn. Hãy chọn lại tệp.",
    preview_not_allowed: "Tệp này chỉ tải xuống được, không xem trước.", storage_unavailable: "Kho lưu trữ tạm thời không phản hồi. Thử lại sau ít phút.",
    rate_limited: "Bạn đã thao tác nhiều lần. Vui lòng đợi trước khi thử lại." };
  return messages[code] ?? "Chưa nhận được kết quả. Thử kiểm tra lại cùng yêu cầu.";
}
export function parseCommission<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new TipRequestError("dependency_unavailable"); return parsed.data;
}
export async function commissionRead<T>(path: string, schema: z.ZodType<T>, maxBytes = 524_288, signal?: AbortSignal): Promise<T> {
  return parseCommission(schema, await tipRequest(path, { signal }, maxBytes));
}
