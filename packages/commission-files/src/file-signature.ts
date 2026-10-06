import { createHash } from "node:crypto";

import { COMMISSION_FILE_CONTEXT_TYPES, type CommissionFileContext, type CommissionFileType } from "./file-policy.js";

const HEAD_BYTES = 64;
/** End-of-central-directory record (22 bytes) plus the largest ZIP comment (65,535 bytes). */
const TAIL_BYTES = 65_557;

export type CommissionFileInspection = Readonly<{ bytes: number; sha256: string; head: Uint8Array; tail: Uint8Array }>;

export function detectCommissionFileType(head: Uint8Array): CommissionFileType | null {
  const startsWith = (expected: readonly number[], offset = 0) => head.byteLength >= offset + expected.length && expected.every((byte, index) => head[offset + index] === byte);
  const ascii = (text: string, offset = 0) => startsWith([...text].map((character) => character.charCodeAt(0)), offset);
  if (startsWith([0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "webp";
  if (ascii("GIF87a") || ascii("GIF89a")) return "gif";
  if (ascii("%PDF-")) return "pdf";
  if (ascii("8BPS")) return "psd";
  if (ascii("CSFCHUNK")) return "clip";
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return "zip";
  return null;
}

export function hasZipDirectory(tail: Uint8Array): boolean {
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (tail[index] === 0x50 && tail[index + 1] === 0x4b && tail[index + 2] === 0x05 && tail[index + 3] === 0x06) return true;
  }
  return false;
}

export function createCommissionFileInspector() {
  const hash = createHash("sha256");
  const head = new Uint8Array(HEAD_BYTES);
  let headLength = 0; let bytes = 0; let tail = new Uint8Array(0); let finished = false;
  return {
    update(chunk: Uint8Array): void {
      if (finished) throw new Error("Inspector already finished");
      hash.update(chunk); bytes += chunk.byteLength;
      if (headLength < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - headLength, chunk.byteLength);
        head.set(chunk.subarray(0, take), headLength); headLength += take;
      }
      if (chunk.byteLength >= TAIL_BYTES) { tail = chunk.slice(chunk.byteLength - TAIL_BYTES); return; }
      const merged = new Uint8Array(tail.byteLength + chunk.byteLength);
      merged.set(tail); merged.set(chunk, tail.byteLength);
      tail = merged.byteLength > TAIL_BYTES ? merged.slice(merged.byteLength - TAIL_BYTES) : merged;
    },
    finish(): CommissionFileInspection {
      finished = true;
      return { bytes, sha256: `sha256:${hash.digest("hex")}`, head: head.slice(0, headLength), tail };
    },
  };
}

/** Bytes decide the type. An image or PDF that also ends in a ZIP directory is a polyglot and is refused. */
export function classifyCommissionFile(context: CommissionFileContext, inspection: CommissionFileInspection):
  Readonly<{ kind: "allowed"; type: CommissionFileType }> | Readonly<{ kind: "rejected"; reason: "type_not_allowed" }> {
  const type = detectCommissionFileType(inspection.head);
  if (!type || !COMMISSION_FILE_CONTEXT_TYPES[context].includes(type)) return { kind: "rejected", reason: "type_not_allowed" };
  const zipDirectory = hasZipDirectory(inspection.tail);
  if ((type === "zip" && !zipDirectory) || (["jpeg", "png", "webp", "gif", "pdf"].includes(type) && zipDirectory)) {
    return { kind: "rejected", reason: "type_not_allowed" };
  }
  return { kind: "allowed", type };
}
