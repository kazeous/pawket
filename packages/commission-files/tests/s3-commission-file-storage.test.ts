import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { CommissionFileStorageError, createS3CommissionFileStorage } from "../src/index.js";

const options = { endpoint: "http://127.0.0.1:9090", region: "us-east-1", accessKeyId: "unit-key", secretAccessKey: "unit-secret",
  quarantineBucket: "pawket-unit-quarantine", cleanBucket: "pawket-unit-clean", forcePathStyle: true, now: () => new Date("2026-10-01T00:00:00Z") };
const key = `commission/${randomUUID()}`;

describe("commission file storage boundary", () => {
  test("aborts actual silent TCP requests before headers for every worker operation", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => { sockets.add(socket); socket.on("data", () => undefined); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const storage = createS3CommissionFileStorage({ ...options, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, operationTimeoutMs: 150 });
      const calls = [() => storage.head("quarantine", key), () => storage.open("quarantine", key, "v1"),
        () => storage.copyToClean({ key, sourceVersionId: "v1", contentType: "image/png" }),
        () => storage.deleteAllVersions("clean", key), () => storage.headBucket("clean")];
      for (const call of calls) {
        const started = Date.now();
        await expect(call()).rejects.toMatchObject({ code: "unavailable" });
        expect(Date.now() - started).toBeLessThan(2_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("refuses shared buckets and invalid options", () => {
    expect(() => createS3CommissionFileStorage({ ...options, cleanBucket: options.quarantineBucket })).toThrow(CommissionFileStorageError);
    expect(() => createS3CommissionFileStorage({ ...options, endpoint: "https://user:pw@host" })).toThrow(CommissionFileStorageError);
  });
  test("signs uploads with an exact length and a fixed octet-stream type", async () => {
    const grant = await createS3CommissionFileStorage(options).presignUpload({ key, contentLength: 1234, expiresInSeconds: 900 });
    const url = new URL(grant.url);
    expect(url.pathname).toBe(`/${options.quarantineBucket}/${key}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect([...url.searchParams.keys()].some((name) => /^x-amz-checksum-/iu.test(name) || name === "x-amz-sdk-checksum-algorithm")).toBe(false);
    expect(grant.requiredHeaders).toEqual({ "content-type": "application/octet-stream", "content-length": "1234" });
    expect(grant.expiresAt.toISOString()).toBe("2026-10-01T00:15:00.000Z");
    expect(grant.url).not.toContain(options.secretAccessKey);
  });
  test("signs downloads from the clean bucket with response overrides", async () => {
    const grant = await createS3CommissionFileStorage(options).presignDownload({ key, versionId: "v1", contentType: "image/png",
      contentDisposition: `attachment; filename="a.png"; filename*=UTF-8''a.png`, expiresInSeconds: 300 });
    const url = new URL(grant.url);
    expect(url.pathname).toBe(`/${options.cleanBucket}/${key}`);
    expect(url.searchParams.get("versionId")).toBe("v1");
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("response-content-disposition")).toContain("attachment;");
    expect(url.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });
  test.each([
    ["a non-commission key", () => createS3CommissionFileStorage(options).presignUpload({ key: `quarantine/${randomUUID()}`, contentLength: 1, expiresInSeconds: 60 })],
    ["a traversal key", () => createS3CommissionFileStorage(options).presignUpload({ key: "commission/../x", contentLength: 1, expiresInSeconds: 60 })],
    ["an empty upload", () => createS3CommissionFileStorage(options).presignUpload({ key, contentLength: 0, expiresInSeconds: 60 })],
    ["an oversized upload", () => createS3CommissionFileStorage(options).presignUpload({ key, contentLength: 250 * 1024 * 1024 + 1, expiresInSeconds: 60 })],
    ["a long upload grant", () => createS3CommissionFileStorage(options).presignUpload({ key, contentLength: 1, expiresInSeconds: 901 })],
    ["a long download grant", () => createS3CommissionFileStorage(options).presignDownload({ key, versionId: "v1", contentType: "image/png", contentDisposition: "attachment", expiresInSeconds: 301 })],
    ["a header-injecting disposition", () => createS3CommissionFileStorage(options).presignDownload({ key, versionId: "v1", contentType: "image/png", contentDisposition: "attachment\r\nx: y", expiresInSeconds: 60 })],
    ["an unknown content type", () => createS3CommissionFileStorage(options).presignDownload({ key, versionId: "v1", contentType: "text/html", contentDisposition: "attachment", expiresInSeconds: 60 })],
  ])("rejects %s", async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: "invalid_input" });
  });
});
