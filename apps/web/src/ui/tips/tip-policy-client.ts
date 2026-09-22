import { isRecord, TipRequestError } from "./tip-client";

export type TipPolicyView = Readonly<{
  revisionId: string; revisionNumber: number; minimumVnd: number; maximumVnd: number;
  allowedPresetsVnd: readonly number[]; effectiveAt: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function readTipPolicy(value: unknown): TipPolicyView {
  if (!isRecord(value) || typeof value.revisionId !== "string" || !uuid.test(value.revisionId) ||
    typeof value.revisionNumber !== "number" || !Number.isSafeInteger(value.revisionNumber) || value.revisionNumber < 1 ||
    typeof value.minimumVnd !== "number" || typeof value.maximumVnd !== "number" || !Number.isSafeInteger(value.minimumVnd) || !Number.isSafeInteger(value.maximumVnd) ||
    value.minimumVnd < 10_000 || value.maximumVnd > 5_000_000 || value.minimumVnd > value.maximumVnd ||
    !Array.isArray(value.allowedPresetsVnd) || value.allowedPresetsVnd.length < 3 || value.allowedPresetsVnd.length > 10 || new Set(value.allowedPresetsVnd).size !== value.allowedPresetsVnd.length ||
    value.allowedPresetsVnd.some((amount) => typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < (value.minimumVnd as number) || amount > (value.maximumVnd as number)) ||
    typeof value.effectiveAt !== "string" || !Number.isFinite(Date.parse(value.effectiveAt))) throw new TipRequestError("dependency_unavailable");
  return { revisionId: value.revisionId, revisionNumber: value.revisionNumber, minimumVnd: value.minimumVnd, maximumVnd: value.maximumVnd,
    allowedPresetsVnd: [...value.allowedPresetsVnd] as number[], effectiveAt: value.effectiveAt };
}

export type TipPolicyDraft = { minimum: string; maximum: string; presets: string[]; reason: string };
export type TipPolicyDraftErrors = Partial<Record<"minimum" | "maximum" | "reason" | `preset-${number}` | "presets", string>>;
export type TipPolicyCommand = { expectedRevision: number; minimumVnd: number; maximumVnd: number; allowedPresetsVnd: number[]; reason: string };
export const tipPolicyDraft = (policy: TipPolicyView): TipPolicyDraft => ({ minimum: String(policy.minimumVnd), maximum: String(policy.maximumVnd), presets: policy.allowedPresetsVnd.map(String), reason: "" });
export function validateTipPolicyDraft(draft: TipPolicyDraft, expectedRevision: number): { errors: TipPolicyDraftErrors; command: TipPolicyCommand | null } {
  const errors: TipPolicyDraftErrors = {};
  const amount = (value: string) => /^[0-9]{1,7}$/u.test(value) && Number(value) >= 10_000 && Number(value) <= 5_000_000;
  if (!amount(draft.minimum)) errors.minimum = "Nhập số nguyên từ 10000 đến 5000000, chỉ dùng chữ số.";
  if (!amount(draft.maximum)) errors.maximum = "Nhập số nguyên từ 10000 đến 5000000, chỉ dùng chữ số.";
  if (!errors.minimum && !errors.maximum && Number(draft.minimum) > Number(draft.maximum)) errors.maximum = "Mức tối đa phải bằng hoặc lớn hơn mức tối thiểu.";
  if (draft.presets.length < 3 || draft.presets.length > 10) errors.presets = "Cần từ 3 đến 10 mức gợi ý khác nhau.";
  const seen = new Set<number>();
  draft.presets.forEach((value, index) => {
    const numeric = Number(value);
    if (!amount(value) || numeric < Number(draft.minimum) || numeric > Number(draft.maximum)) errors[`preset-${index}`] = "Nhập số nguyên trong giới hạn đã chọn.";
    else if (seen.has(numeric)) errors[`preset-${index}`] = "Mức gợi ý này đã có trong danh sách.";
    seen.add(numeric);
  });
  const reason = draft.reason.trim();
  if (Array.from(reason).length < 3 || Array.from(reason).length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(reason)) errors.reason = "Nhập lý do từ 3 đến 500 ký tự trên một dòng.";
  return { errors, command: Object.keys(errors).length ? null : { expectedRevision, minimumVnd: Number(draft.minimum), maximumVnd: Number(draft.maximum), allowedPresetsVnd: draft.presets.map(Number), reason } };
}
