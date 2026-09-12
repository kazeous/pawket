import { TipPaymentError, TIP_GUEST_MESSAGE_MAX_SCALARS, TIP_GUEST_NAME_MAX_SCALARS } from "@pawket/payments";

export type TipGuestContent = Readonly<{ name: string | null; message: string | null }>;

function normalize(value: unknown, limit: number, multiline: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > limit * 4) throw new TipPaymentError("invalid_guest_content");
  // In Unicode mode this detects lone surrogates, but allows surrogate pairs.
  if (/[\uD800-\uDFFF]/u.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) throw new TipPaymentError("invalid_guest_content");
  const text = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  const result = multiline ? text : text.replace(/\s+/gu, " ");
  if (Array.from(result).length > limit) throw new TipPaymentError("invalid_guest_content");
  return result || null;
}

export function normalizeTipGuestContent(input: { name?: unknown; message?: unknown }): TipGuestContent {
  return Object.freeze({ name: normalize(input.name, TIP_GUEST_NAME_MAX_SCALARS, false), message: normalize(input.message, TIP_GUEST_MESSAGE_MAX_SCALARS, true) });
}
