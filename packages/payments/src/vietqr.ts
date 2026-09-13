import { type IntegerVnd, requireIntegerVnd } from "./tip-contracts.js";

// Reviewed against the public directory on 2026-09-12. Keep the existing
// product bank boundary; arbitrary BINs/configured operating banks are not tips.
export const VIETQR_RECEIVING_BANKS: Readonly<Record<string, string>> = Object.freeze({
  "970415": "VietinBank",
  "970436": "Vietcombank",
});
export const VIETQR_MAX_AMOUNT_VND = 9_999_999_999_999;
export const VIETQR_MAX_REFERENCE_LENGTH = 25;

export type VietQrErrorCode = "unsupported_bank" | "invalid_account" | "invalid_amount" | "invalid_reference";
export class VietQrError extends Error {
  constructor(readonly code: VietQrErrorCode) {
    super(code);
    this.name = "VietQrError";
  }
}

export type VietQrDestination = Readonly<{ bankBin: string; accountNumber: string }>;
export type VietQrTransferInput = VietQrDestination & Readonly<{
  amountVnd: IntegerVnd;
  transferReference: string;
}>;
// Sensitive receiving facts: only expose after transaction authorization.
// These text facts remain usable independently of a QR image renderer.
export type VietQrTransferInstruction = VietQrTransferInput & Readonly<{
  bankName: string;
  currency: "VND";
  payload: string;
}>;

export function isVietQrDestinationSupported(destination: VietQrDestination): boolean {
  return typeof destination.bankBin === "string" &&
    Object.hasOwn(VIETQR_RECEIVING_BANKS, destination.bankBin) &&
    typeof destination.accountNumber === "string" &&
    destination.accountNumber.trim() === destination.accountNumber &&
    /^[0-9]{6,19}$/u.test(destination.accountNumber);
}

function tlv(id: string, value: string): string {
  // All callers supply validated ASCII with 1–99 characters. Character and
  // byte lengths therefore agree (NAPAS public v1.0 §5.1).
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

/** NAPAS v1.0 §5.2.15. Internal format utility; not authentication. */
export function vietQrCrc16(bytes: Uint8Array): string {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Encodes locked, normalized facts without modifying or transmitting them. */
export function createVietQrTransferInstruction(input: VietQrTransferInput): VietQrTransferInstruction {
  if (typeof input.bankBin !== "string" || !Object.hasOwn(VIETQR_RECEIVING_BANKS, input.bankBin)) {
    throw new VietQrError("unsupported_bank");
  }
  if (!isVietQrDestinationSupported(input)) throw new VietQrError("invalid_account");
  let amountVnd: IntegerVnd;
  try {
    amountVnd = requireIntegerVnd(input.amountVnd, { minimumVnd: 1, maximumVnd: VIETQR_MAX_AMOUNT_VND });
  } catch {
    throw new VietQrError("invalid_amount");
  }
  const reference = input.transferReference;
  if (typeof reference !== "string" || reference.trim() !== reference || reference.length > VIETQR_MAX_REFERENCE_LENGTH ||
    !/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/u.test(reference)) {
    throw new VietQrError("invalid_reference");
  }
  const beneficiary = tlv("00", input.bankBin) + tlv("01", input.accountNumber);
  const account = tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA");
  const data = tlv("00", "01") + tlv("01", "12") + tlv("38", account) +
    tlv("53", "704") + tlv("54", amountVnd.toString()) + tlv("58", "VN") +
    tlv("62", tlv("08", reference)) + "6304";
  return Object.freeze({
    bankBin: input.bankBin,
    bankName: VIETQR_RECEIVING_BANKS[input.bankBin]!,
    accountNumber: input.accountNumber,
    amountVnd,
    currency: "VND",
    transferReference: reference,
    payload: data + vietQrCrc16(new TextEncoder().encode(data)),
  });
}
