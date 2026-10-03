import { describe, expect, test } from "vitest";
import {
  COMMISSION_FILE_POLICY, CommissionFileError, commissionFileContentDisposition, commissionFileObjectKey, commissionFileRetryDelayMs,
  isInlinePreviewAllowed, normalizeCommissionFileName,
} from "../src/index.js";

const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;

describe("commission file policy", () => {
  test("keeps the approved limits", () => {
    expect(COMMISSION_FILE_POLICY).toMatchObject({ briefFileMaxBytes: 25 * 1024 * 1024, maxBriefFiles: 10, maxUnsentReferences: 10, maxPendingPerActor: 10,
      uploadGrantMs: 15 * 60_000, downloadGrantSeconds: 300, scanDeadlineMs: 86_400_000, signatureMaxAgeMs: 86_400_000, closedUnpaidRetentionMs: 30 * 86_400_000 });
    expect(Object.isFrozen(COMMISSION_FILE_POLICY)).toBe(true);
  });
  test("normalises hostile filenames", () => {
    expect(normalizeCommissionFileName("\u202Egnp.exe")).toBe("gnp.exe");
    expect(normalizeCommissionFileName("a\r\nb\u0000c.png")).toBe("abc.png");
    expect(normalizeCommissionFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(normalizeCommissionFileName("  tham   khảo .png ")).toBe("tham khảo .png");
    expect(normalizeCommissionFileName("Cafe\u0301.png")).toBe("Café.png");
    const long = normalizeCommissionFileName(`${"ả".repeat(150)}.png`);
    expect(utf8(long)).toBeLessThanOrEqual(255);
    expect(long).not.toContain("\uFFFD");
  });
  test.each(["", "   ", "\u202E", "...", 42, null, "a".repeat(4097)])("rejects unusable filename %j", (value) => {
    expect(() => normalizeCommissionFileName(value)).toThrow(CommissionFileError);
  });
  test("builds a header-safe Content-Disposition", () => {
    const value = commissionFileContentDisposition('ảnh "mẫu";\\%.png', "attachment");
    expect(value).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%._~!$&+,\-]+$/u);
    expect(value).not.toMatch(/[\r\n]/u);
    expect(value.slice(value.indexOf('"') + 1, value.lastIndexOf('"'))).not.toMatch(/["\\%;]/u);
    expect(decodeURIComponent(value.split("UTF-8''")[1]!)).toBe('ảnh "mẫu";_%.png');
    expect(commissionFileContentDisposition("a.png", "inline")).toMatch(/^inline; /u);
  });
  test("allows inline preview only for small images", () => {
    expect(isInlinePreviewAllowed("png", 1024)).toBe(true);
    expect(isInlinePreviewAllowed("gif", 25 * 1024 * 1024)).toBe(true);
    expect(isInlinePreviewAllowed("png", 25 * 1024 * 1024 + 1)).toBe(false);
    expect(isInlinePreviewAllowed("pdf", 10)).toBe(false);
  });
  test("derives keys and retry delays", () => {
    expect(commissionFileObjectKey("0b2c1f7e-8d55-4a3e-9f10-2b6f1e1a9c44")).toBe("commission/0b2c1f7e-8d55-4a3e-9f10-2b6f1e1a9c44");
    expect(() => commissionFileObjectKey("../x")).toThrow(CommissionFileError);
    expect([1, 2, 3, 10, 50].map(commissionFileRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
  });
});
