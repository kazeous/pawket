import { describe, expect, test } from "vitest";
import { classifyCommissionFile, createCommissionFileInspector, detectCommissionFileType, hasZipDirectory } from "../src/index.js";
import { storedZip } from "./zip-fixtures.js";

const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((part) => typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "IHDR");
const EOCD = bytes([0x50, 0x4b, 0x05, 0x06], new Array(18).fill(0));
function inspect(...chunks: Uint8Array[]) {
  const inspector = createCommissionFileInspector();
  for (const chunk of chunks) inspector.update(chunk);
  return inspector.finish();
}

describe("commission file signatures", () => {
  test.each([
    ["jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])], ["png", PNG], ["webp", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")],
    ["gif", bytes("GIF89a")], ["gif", bytes("GIF87a")], ["pdf", bytes("%PDF-1.7")], ["zip", bytes([0x50, 0x4b, 0x03, 0x04])],
  ])("detects %s from bytes", (type, head) => {
    expect(detectCommissionFileType(head)).toBe(type);
  });
  test.each([
    ["renamed executable", bytes("MZ", [0x90, 0])], ["empty", new Uint8Array()], ["truncated jpeg", bytes([0xff, 0xd8])],
    ["RIFF that is not WebP", bytes("RIFF", [0, 0, 0, 0], "AVI ")], ["svg", bytes("<svg")],
  ])("refuses %s", (_label, head) => {
    expect(detectCommissionFileType(head)).toBeNull();
  });
  test("hashes and keeps head and tail across tiny chunks", () => {
    const content = bytes("abc");
    const result = inspect(...[...content].map((b) => new Uint8Array([b])));
    expect(result).toMatchObject({ bytes: 3, sha256: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect([...result.head]).toEqual([...content]);
    expect([...result.tail]).toEqual([...content]);
  });
  test("bounds the tail window for large inputs", () => {
    const result = inspect(new Uint8Array(70_000), new Uint8Array(70_000).fill(7));
    expect(result.bytes).toBe(140_000);
    expect(result.head.byteLength).toBe(64);
    expect(result.tail.byteLength).toBe(65_557);
    expect(result.tail.every((b) => b === 7)).toBe(true);
  });
  test("rejects an image that is also a ZIP archive", () => {
    expect(hasZipDirectory(EOCD)).toBe(true);
    expect(classifyCommissionFile("brief", inspect(bytes("GIF89a"), new Uint8Array(100), EOCD))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
    expect(classifyCommissionFile("brief", inspect(bytes("%PDF-1.7"), EOCD))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
    expect(classifyCommissionFile("brief", inspect(PNG, new Uint8Array(100)))).toEqual({ kind: "allowed", type: "png" });
    expect(classifyCommissionFile("brief", inspect(bytes("MZ")))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
  });
  test.each([1, 2])("psd and psb heads are psd (version %i)", (version) => {
    const content = bytes("8BPS", [0, version]);
    expect(detectCommissionFileType(content)).toBe("psd");
    expect(classifyCommissionFile("submission", inspect(content))).toEqual({ kind: "allowed", type: "psd" });
  });
  test("clip head is clip", () => {
    const content = bytes("CSFCHUNK", new Array(24).fill(0));
    expect(detectCommissionFileType(content)).toBe("clip");
    expect(classifyCommissionFile("submission", inspect(content))).toEqual({ kind: "allowed", type: "clip" });
  });
  test("zip with a directory is allowed only for submissions", () => {
    const inspection = inspect(storedZip([{ name: "payload", data: bytes("harmless") }]));
    expect(hasZipDirectory(inspection.tail)).toBe(true);
    expect(classifyCommissionFile("submission", inspection)).toEqual({ kind: "allowed", type: "zip" });
  });
  test.each(["brief", "thread"] as const)("%s rejects a valid ZIP with a directory", (context) => {
    const inspection = inspect(storedZip([{ name: "payload", data: bytes("harmless") }]));
    expect(hasZipDirectory(inspection.tail)).toBe(true);
    expect(classifyCommissionFile(context, inspection)).toEqual({ kind: "rejected", reason: "type_not_allowed" });
  });
  test.each([bytes([0x50, 0x4b, 0x05, 0x06], new Array(18).fill(0)), bytes([0x50, 0x4b, 0x07, 0x08], new Array(18).fill(0))])(
    "empty-archive and spanned markers are not zip", (content) => {
      expect(detectCommissionFileType(content)).toBeNull();
      expect(classifyCommissionFile("submission", inspect(content))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
    });
  test("zip head without a directory is rejected", () => {
    expect(classifyCommissionFile("submission", inspect(bytes([0x50, 0x4b, 0x03, 0x04], new Array(26).fill(0)))))
      .toEqual({ kind: "rejected", reason: "type_not_allowed" });
  });
  test.each([bytes([0xff, 0xd8, 0xff]), PNG, bytes("RIFF", [0, 0, 0, 0], "WEBP"), bytes("GIF89a"), bytes("%PDF-1.7")])(
    "previewable image or PDF ending in a ZIP directory is rejected for submissions", (head) => {
      expect(classifyCommissionFile("submission", inspect(head, EOCD))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
    });
  test.each([["psd", bytes("8BPS", [0, 1])], ["clip", bytes("CSFCHUNK")]] as const)(
    "%s whose tail contains a ZIP directory is allowed", (type, head) => {
      expect(classifyCommissionFile("submission", inspect(head, EOCD))).toEqual({ kind: "allowed", type });
    });
  test.each(["brief", "thread", "submission"] as const)("renamed executable is rejected in %s", (context) => {
    expect(classifyCommissionFile(context, inspect(bytes("MZ", [0x90, 0])))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
  });
  test.each(["brief", "thread"] as const)("%s keeps the brief type and polyglot rules", (context) => {
    for (const head of [bytes([0xff, 0xd8, 0xff]), PNG, bytes("RIFF", [0, 0, 0, 0], "WEBP"), bytes("GIF89a"), bytes("%PDF-1.7")]) {
      expect(classifyCommissionFile(context, inspect(head))).toEqual({ kind: "allowed", type: detectCommissionFileType(head) });
      expect(classifyCommissionFile(context, inspect(head, EOCD))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
    }
    for (const head of [bytes("8BPS", [0, 1]), bytes("CSFCHUNK")]) {
      expect(classifyCommissionFile(context, inspect(head))).toEqual({ kind: "rejected", reason: "type_not_allowed" });
    }
  });
});
