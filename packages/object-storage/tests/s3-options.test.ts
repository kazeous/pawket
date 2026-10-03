import { describe, expect, test } from "vitest";
import { isBoundedS3Text, isValidS3Bucket, isValidS3Endpoint } from "../src/index.js";

describe("S3 option validation", () => {
  test("accepts plain http(s) endpoints only", () => {
    expect(isValidS3Endpoint("https://objectstorage.ap-singapore-1.oraclecloud.com")).toBe(true);
    expect(isValidS3Endpoint("http://127.0.0.1:9090")).toBe(true);
    for (const value of ["ftp://host", "https://user:pass@host", "https://host/?x=1", "https://host/#f", "not a url", 7]) expect(isValidS3Endpoint(value)).toBe(false);
  });
  test("enforces bucket naming", () => {
    expect(isValidS3Bucket("pawket-commission-clean")).toBe(true);
    for (const value of ["ab", "Upper", "-start", "end-", "a".repeat(64), null]) expect(isValidS3Bucket(value)).toBe(false);
  });
  test("bounds credential text and rejects control characters", () => {
    expect(isBoundedS3Text("us-east-1", 128)).toBe(true);
    expect(isBoundedS3Text("", 128)).toBe(false);
    expect(isBoundedS3Text("a".repeat(129), 128)).toBe(false);
    expect(isBoundedS3Text("key\nvalue", 256)).toBe(false);
  });
});
