import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  normalizeSePayId, normalizeSePayReference, normalizeSePayVnd, parseSePayJson,
  parseSePayVietnamTime, sepayNullableText, sepayRecord, sepayText,
  type SePayReference,
} from "./sepay-normalization.js";

export const SEPAY_WEBHOOK_MAX_BYTES = 16 * 1_024;
export const SEPAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type SePayWebhookErrorCode = "body_too_large" | "unsupported_media" | "invalid_authentication" | "invalid_payload";
export class SePayWebhookError extends Error {
  constructor(readonly code: SePayWebhookErrorCode) { super(code); this.name = "SePayWebhookError"; }
}

export type SePayWebhookEvent = Readonly<{
  id: string;
  bankGateway: string;
  accountNumber: string;
  subAccount: string | null;
  amountVnd: number;
  occurredAt: Date;
  reference: string | null;
  referenceStatus: SePayReference["referenceStatus"];
  bankReference: string | null;
}>;

export type SePayWebhookDisposition =
  | Readonly<{ kind: "accepted"; event: SePayWebhookEvent; digest: string }>
  | Readonly<{ kind: "ignored"; reason: "outgoing" | "non_pawket" | "mock"; providerEventId: string; digest: string }>;

/** Authentication is over original bytes, before decoding or business parsing. */
export function authenticateAndParseSePayWebhook(input: Readonly<{
  rawBody: Uint8Array;
  contentType: string | null;
  contentEncoding?: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now: Date;
}>): SePayWebhookDisposition {
  if (input.rawBody.byteLength > SEPAY_WEBHOOK_MAX_BYTES) throw new SePayWebhookError("body_too_large");
  if (!input.contentType || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(input.contentType) ||
    (input.contentEncoding !== undefined && input.contentEncoding !== null && input.contentEncoding !== "identity")) throw new SePayWebhookError("unsupported_media");
  if (!input.timestamp || !/^[1-9][0-9]{9,10}$/.test(input.timestamp) || !input.signature || !/^sha256=[0-9a-fA-F]{64}$/.test(input.signature) ||
    input.secret.length < 32 || input.secret.length > 512 || !Number.isFinite(input.now.getTime()) ||
    Math.abs(input.now.getTime() / 1_000 - Number(input.timestamp)) > SEPAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) throw new SePayWebhookError("invalid_authentication");
  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.`, "utf8").update(input.rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(input.signature.slice(7), "hex"))) throw new SePayWebhookError("invalid_authentication");

  return parseAuthenticatedSePayWebhook(input.rawBody);
}

/** Only for raw evidence already authenticated and loaded from the durable inbox. */
export function parseAuthenticatedSePayWebhook(rawBody: Uint8Array): SePayWebhookDisposition {
  if (rawBody.byteLength > SEPAY_WEBHOOK_MAX_BYTES) throw new SePayWebhookError("body_too_large");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
    const raw = sepayRecord(parseSePayJson(text));
    const id = normalizeSePayId(raw.id, true);
    const bankGateway = sepayText(raw.gateway, 80);
    const accountNumber = sepayText(raw.accountNumber, 64);
    const subAccount = sepayNullableText(raw.subAccount, 64);
    const amountVnd = normalizeSePayVnd(raw.transferAmount);
    const occurredAt = parseSePayVietnamTime(raw.transactionDate);
    const references = normalizeSePayReference(raw.code, raw.content);
    const bankReference = sepayNullableText(raw.referenceCode, 128);
    if (raw.transferType !== "in" && raw.transferType !== "out") throw new SePayWebhookError("invalid_payload");
    const digest = createHash("sha256").update(rawBody).digest("hex");
    if (id === "0") return { kind: "ignored", reason: "mock", providerEventId: id, digest };
    if (raw.transferType === "out") return { kind: "ignored", reason: "outgoing", providerEventId: id, digest };
    if (!references.isPawket) return { kind: "ignored", reason: "non_pawket", providerEventId: id, digest };
    return {
      kind: "accepted", digest,
      event: { id, bankGateway, accountNumber, subAccount, amountVnd, occurredAt, reference: references.reference, referenceStatus: references.referenceStatus, bankReference },
    };
  } catch { throw new SePayWebhookError("invalid_payload"); }
}
