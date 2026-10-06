import { commissionFileFail } from "./file-policy.js";

/** Display-only plain text. Rendering must preserve it as text nodes. */
export function normalizeCommissionMessageText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") commissionFileFail("invalid_request");
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(normalized) ||
    /\p{Cs}/u.test(normalized)) commissionFileFail("invalid_request");
  const text = normalized.trim();
  if ([...text].length > 4_000 || Buffer.byteLength(JSON.stringify(text), "utf8") > 16_384) commissionFileFail("invalid_request");
  return text || null;
}
