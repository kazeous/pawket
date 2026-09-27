import { createHash } from "node:crypto";
import { createLookupHmac } from "@pawket/security";
import { commissionFail } from "./contracts.js";

/** Normalized commission text can exceed the shared lookup primitive's 8 KiB
 * input limit. Hash the bounded command before HMAC; only the keyed digest is
 * stored, so predictable briefs cannot be tested against a public plain hash. */
export function commissionCommandFingerprint(key: Uint8Array, context: string, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 131_072) commissionFail("invalid_request");
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  return createLookupHmac({ key, context, value: `commission-command-sha256:v1:${digest}` });
}
