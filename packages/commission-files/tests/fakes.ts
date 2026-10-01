import { createHash } from "node:crypto";
import { ClamdUnavailableError, type ClamdVerdict } from "../src/clamd-client.js";
import { CommissionFileStorageError, type CommissionFileStoragePort, type CommissionObjectArea } from "../src/storage-port.js";

export const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function createFakeCommissionFileStorage() {
  const objects = new Map<string, Array<{ bytes: Uint8Array; versionId: string }>>(); let counter = 0; let copies = 0;
  const slot = (area: CommissionObjectArea, key: string) => `${area}:${key}`;
  function put(area: CommissionObjectArea, key: string, bytes: Uint8Array): string {
    const versionId = `v${++counter}`; objects.set(slot(area, key), [...(objects.get(slot(area, key)) ?? []), { bytes, versionId }]); return versionId;
  }
  const port: CommissionFileStoragePort = {
    async presignUpload({ key, contentLength, expiresInSeconds }) {
      return { url: `https://storage.invalid/quarantine/${key}?signed=1`, requiredHeaders: { "content-type": "application/octet-stream", "content-length": String(contentLength) }, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
    },
    async presignDownload({ key, versionId, expiresInSeconds }) {
      return { url: `https://storage.invalid/clean/${key}?versionId=${versionId}&signed=1`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
    },
    async head(area, key) { const latest = objects.get(slot(area, key))?.at(-1); return latest ? { contentLength: latest.bytes.byteLength, versionId: latest.versionId } : null; },
    async open(area, key, versionId) {
      const match = objects.get(slot(area, key))?.find((entry) => entry.versionId === versionId);
      if (!match) throw new CommissionFileStorageError("unavailable");
      return (async function* () { yield match.bytes; })();
    },
    async copyToClean({ key, sourceVersionId }) {
      copies += 1; const source = objects.get(slot("quarantine", key))?.find((entry) => entry.versionId === sourceVersionId);
      if (!source) throw new CommissionFileStorageError("unavailable");
      return { versionId: put("clean", key, source.bytes) };
    },
    async deleteAllVersions(area, key) { const count = objects.get(slot(area, key))?.length ?? 0; objects.delete(slot(area, key)); return count; },
    async headBucket() { /* always available */ },
  };
  return { port, put, copies: () => copies, has: (area: CommissionObjectArea, key: string) => objects.has(slot(area, key)) };
}

/**
 * `wrapSourceErrors` mimics the real `createClamdClient`: its `exchange()` catches anything the
 * source iterable throws and re-wraps it as `ClamdUnavailableError("closed")` unless it already
 * is one (see `clamd-client.ts`'s `send(socket).catch(...)`). Without this option, a plain fake
 * would pass a source error through unchanged, which no real scanner implementation does and
 * would make processor tests pass for the wrong reason.
 */
export function fakeScanner(options: Readonly<{ verdict?: ClamdVerdict; error?: Error; signatureDate?: () => Date; wrapSourceErrors?: boolean }> = {}) {
  return {
    async version() { return { engine: "fake", signatureVersion: 1, signatureDate: options.signatureDate?.() ?? new Date() }; },
    async scan(source: AsyncIterable<Uint8Array>): Promise<ClamdVerdict> {
      try {
        for await (const chunk of source) void chunk;
      } catch (error) {
        if (!options.wrapSourceErrors) throw error;
        throw error instanceof ClamdUnavailableError ? error : new ClamdUnavailableError("closed");
      }
      if (options.error) throw options.error;
      return options.verdict ?? { kind: "clean" };
    },
  };
}
