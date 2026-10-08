"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../async-state";
import { evidenceLabels, type EvidenceSection, type CaseKind } from "./case-client";

// Display known evidence fields as text. No images, links or file URLs are prefetched.
const labels: Record<string, string> = { brief: "Yêu cầu sáng tác", text: "Nội dung", links: "Liên kết tham khảo", package: "Gói commission", title: "Tên", terms: "Điều kiện đã chốt",
  scope: "Phạm vi", deliverables: "Sản phẩm bàn giao", usageRights: "Quyền sử dụng", artistTerms: "Điều kiện của nghệ sĩ", amountVnd: "Số tiền (VND)", turnaroundDays: "Số ngày thực hiện",
  revisionAllowance: "Số lần chỉnh sửa", reviewWindowDays: "Số ngày kiểm tra", referenceFiles: "Tệp tham khảo", files: "Tệp", items: "Tin nhắn và bàn giao", note: "Lời nhắn", responseNote: "Phản hồi",
  author: "Người gửi", authorRole: "Người trình bày", kind: "Loại", submissionKind: "Loại bàn giao", response: "Phản hồi", state: "Trạng thái", reason: "Lý do", trigger: "Điều kiện mở",
  proposals: "Đề nghị", proposerRole: "Bên đề nghị", refundAmountVnd: "Số tiền hoàn (VND)", requestedRefundVnd: "Số tiền yêu cầu hoàn (VND)", requestedOutcome: "Kết quả yêu cầu",
  disputes: "Khiếu nại", statements: "Trình bày", ruling: "Kết luận", reasoning: "Kết luận gửi hai bên", internalNote: "Ghi chú nội bộ (chỉ owner thấy)", corrections: "Đính chính",
  outcome: "Kết quả", effect: "Kết quả đính chính", refunds: "Nghĩa vụ hoàn tiền", lateClaim: "Yêu cầu thanh toán muộn", claimedAmountVnd: "Số tiền khai báo (VND)", receivedAmountVnd: "Số tiền đã nhận (VND)",
  bankReference: "Mã giao dịch ngân hàng", bankName: "Ngân hàng", accountNumber: "Số tài khoản", accountHolder: "Tên chủ tài khoản", holderName: "Tên chủ tài khoản", reference: "Nội dung chuyển tiền", suffix: "Bốn số cuối tài khoản",
  createdAt: "Thời điểm tạo", openedAt: "Thời điểm mở", closedAt: "Thời điểm đóng", endedAt: "Thời điểm kết thúc", submittedAt: "Thời điểm bàn giao", respondedAt: "Thời điểm phản hồi",
  respondBy: "Hạn phản hồi", dueAt: "Hạn chuyển", confirmBy: "Hạn xác nhận", ruledAt: "Thời điểm kết luận", correctedAt: "Thời điểm đính chính", transferAt: "Thời điểm chuyển", filedAt: "Thời điểm khai báo",
  payment: "Thanh toán", confirmedAt: "Thời điểm xác nhận", settlementLane: "Kênh xác nhận", confirmationSource: "Nguồn xác nhận", sends: "Lần chuyển hoàn tiền", transferDate: "Ngày chuyển", recordedAt: "Thời điểm ghi nhận",
  policy: "Chính sách đã chốt", document: "Nội dung chính sách", quote: "Báo giá", fulfillment: "Thực hiện đơn", deliveredAt: "Thời điểm bàn giao cuối", completedAt: "Thời điểm hoàn tất", completionKind: "Cách hoàn tất",
  closeReason: "Lý do đóng đơn", reviewEndsAt: "Hạn kiểm tra", completionFloorAt: "Hạn kiểm tra được khôi phục", completionDueAt: "Hạn hoàn tất", revisionsUsed: "Số lần đã chỉnh sửa", lateDelivery: "Bàn giao trễ", section: "Mục bằng chứng" };
const values: Record<string, string> = { buyer: "Người mua", creator: "Nghệ sĩ", owner: "Owner", open: "Đang mở", resolved: "Đã giải quyết", complete: "Hoàn tất", close: "Đóng đơn", completed: "Đã hoàn tất", closed: "Đã đóng",
  in_progress: "Đang thực hiện", delivered: "Đã bàn giao", message: "Tin nhắn", submission: "Bàn giao", opening: "Trình bày ban đầu", response: "Phản hồi", statement: "Trình bày bổ sung", question: "Câu hỏi của Pawket",
  draft: "Bản nháp", final: "Bản cuối", approved: "Đã duyệt", changes_requested: "Yêu cầu chỉnh sửa", superseded: "Đã được thay thế", pending: "Đang chờ", accepted: "Đã đồng ý", declined: "Đã từ chối", withdrawn: "Đã rút", expired: "Đã hết hạn", lapsed: "Không còn phù hợp", settled: "Đã thỏa thuận", ruled: "Đã kết luận",
  cancel_with_refund: "Hủy đơn và hoàn tiền", complete_with_refund: "Hoàn tất và hoàn tiền", awaiting_destination: "Chờ tài khoản", awaiting_send: "Chờ chuyển", sent: "Đã ghi nhận chuyển", received: "Đã nhận", presumed_received: "Được xem là đã nhận", not_received: "Chưa nhận", waived: "Đã miễn nghĩa vụ",
  awaiting_creator: "Chờ nghệ sĩ", escalated: "Chờ owner xem xét", refund_owed: "Cần hoàn tiền", rejected: "Đã từ chối", not_delivered: "Chưa nhận được bài", not_as_agreed: "Không đúng thỏa thuận", incomplete_delivery: "Bàn giao chưa đầy đủ",
  creator_cannot_complete: "Nghệ sĩ không thể hoàn thành", communication_breakdown: "Mất liên lạc", other: "Lý do khác", final_delivery: "Bàn giao cuối", overdue: "Quá hạn", proposal_declined: "Đề nghị không được chấp nhận",
  awaiting_transfer: "Chờ chuyển khoản", confirmed: "Đã xác nhận", manual_attested: "Xác nhận thủ công", provider_bound: "Đối soát qua nhà cung cấp", creator_manual: "Nghệ sĩ xác nhận", sepay_automatic: "SePay tự đối soát", creator_reviewed_sepay: "Nghệ sĩ kiểm tra giao dịch SePay",
  requested: "Đã yêu cầu", quoted: "Đã báo giá", awaiting_payment: "Chờ thanh toán", agreement: "Theo thỏa thuận", ruling: "Theo kết luận", cancelled_by_agreement: "Hủy theo thỏa thuận", cancelled_by_ruling: "Hủy theo kết luận", buyer_cancelled_after_suspension: "Người mua hủy sau khi nghệ sĩ bị tạm dừng", fulfillment_frozen: "Owner đóng băng thực hiện", increased: "Tăng số tiền hoàn", reduced: "Giảm số tiền hoàn", recorded_only: "Chỉ ghi nhận đính chính" };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const enumFields = new Set(["state", "kind", "author", "authorRole", "proposerRole", "outcome", "requestedOutcome", "section", "response", "submissionKind", "trigger", "effect", "completionKind", "closeReason", "settlementLane", "confirmationSource"]);
export function EvidenceView({ value, onFile }: Readonly<{ value: unknown; onFile?(fileId: string): void }>) {
  return <EvidenceValue value={value} onFile={onFile} />;
}
function EvidenceValue({ value, onFile, field, context }: Readonly<{ value: unknown; onFile?(fileId: string): void; field?: string; context?: string }>) {
  if (value === null || value === undefined) return <span>Không có</span>;
  if (Array.isArray(value)) return value.length ? <ul className="stack">{value.map((item, index) => <li key={index}><EvidenceValue value={item} onFile={onFile} field={field} context={context} /></li>)}</ul> : <span>Không có</span>;
  if (!record(value)) {
    const text = String(value); const enumValue = field !== undefined && (enumFields.has(field) || field === "reason" && context === "disputes");
    const translated = enumValue && Object.hasOwn(values, text) ? values[text] : enumValue && field === "section" && Object.hasOwn(evidenceLabels, text) ? evidenceLabels[text as EvidenceSection] : text;
    return <span className="whitespace-pre-wrap break-words">{typeof value === "boolean" ? value ? "Có" : "Không" : translated}</span>;
  }
  if (typeof value.fileId === "string") return <div className="button-row"><span>{typeof value.name === "string" ? value.name : "Tệp đính kèm"}</span>
    {onFile && value.availability === "available" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.fileId) ? <Button variant="outline" onClick={() => onFile(value.fileId as string)}>Tải tệp</Button> : <span>{value.availability === "available" ? "Quay lại vụ việc để tải tệp." : "Tệp không còn khả dụng."}</span>}</div>;
  return <dl className="summary-list">{Object.entries(value).filter(([key]) => Object.hasOwn(labels, key)).map(([key, item]) => <div key={key}><dt>{labels[key]}</dt><dd><EvidenceValue value={item} onFile={onFile} field={key} context={field ?? context} /></dd></div>)}</dl>;
}
export function EvidenceTabs({ kind, disabled, onRead, onFile }: Readonly<{ kind: CaseKind; disabled: boolean; onRead(section: EvidenceSection, cursor?: number): Promise<unknown>; onFile(fileId: string): void }>) {
  const [section, setSection] = useState<EvidenceSection>("order_summary"); const [evidence, setEvidence] = useState<unknown>(null); const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false); const generation = useRef(0);
  const clear = () => { generation.current++; setEvidence(null); setOpened(false); };
  useEffect(() => { if (!opened) return; const timer = window.setTimeout(() => { generation.current++; setEvidence(null); setOpened(false); }, 300_000); return () => window.clearTimeout(timer); }, [opened, evidence]);
  useEffect(() => { const invalidate = () => { generation.current++; }; const hidden = () => { if (document.visibilityState === "hidden") { invalidate(); setEvidence(null); setOpened(false); } };
    document.addEventListener("visibilitychange", hidden); return () => { invalidate(); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  async function read(cursor?: number) {
    const current = ++generation.current; setEvidence(null); setOpened(false); setBusy(true);
    try { const result = await onRead(section, cursor); if (current === generation.current) { setEvidence(result); setOpened(true); } }
    catch { /* Parent displays the reasoned error and refreshes case metadata. */ }
    finally { setBusy(false); }
  }
  const nextCursor = record(evidence) && typeof evidence.nextBeforeSequence === "number" ? evidence.nextBeforeSequence : null;
  const sections: EvidenceSection[] = ["order_summary", "thread_page", "resolution_records", ...kind.startsWith("refund_") ? ["refund_destination" as const] : []];
  return <section className="stack"><h2>Bằng chứng riêng tư</h2><p>Mỗi lần xem bằng chứng hoặc tải tệp cần xác thực owner và được ghi vào nhật ký truy cập.</p>
    <div className="button-row" role="navigation" aria-label="Mục bằng chứng">{sections.map((value) => <Button key={value} variant={section === value ? "outline" : "ghost"} aria-pressed={section === value} disabled={disabled || busy} onClick={() => { clear(); setSection(value); }}>{evidenceLabels[value]}</Button>)}</div>
    {opened ? <><EvidenceView value={evidence} onFile={onFile} /><div className="button-row"><Button variant="outline" onClick={clear}>Ẩn bằng chứng</Button>{nextCursor !== null ? <Button disabled={disabled || busy} onClick={() => void read(nextCursor)}>Xem tin nhắn cũ hơn</Button> : null}</div></> : <><EmptyState title="Bằng chứng chưa được mở" /><Button disabled={disabled || busy} onClick={() => void read()}>{busy ? "Đang mở bằng chứng…" : "Xem bằng chứng"}</Button></>}
  </section>;
}
