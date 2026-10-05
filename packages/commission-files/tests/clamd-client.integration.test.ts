import { describe, expect, test } from "vitest";
import { classifyCommissionFile, createClamdClient, createCommissionFileInspector } from "../src/index.js";
import { storedZip } from "./zip-fixtures.js";

const host = process.env.COMMISSION_FILES_CLAMD_HOST ?? "127.0.0.1";
const port = Number(process.env.COMMISSION_FILES_CLAMD_PORT ?? "3310");
const client = createClamdClient({ host, port, timeoutMs: 60_000 });
// The standard antivirus test string. It is not malware; every engine flags it by design.
const EICAR = new TextEncoder().encode(String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`);
async function* once(bytes: Uint8Array) { yield bytes; }

describe("real clamd", () => {
  test("EICAR inside a ZIP submission is malware", async () => {
    const archive = storedZip([{ name: "eicar.txt", data: EICAR }]);
    const inspector = createCommissionFileInspector(); inspector.update(archive);
    expect(classifyCommissionFile("submission", inspector.finish())).toEqual({ kind: "allowed", type: "zip" });
    await expect(client.scan(once(archive))).resolves.toMatchObject({ kind: "found", reason: "malware" });
  });
  test("reports its signature date", async () => {
    const version = await client.version();
    expect(version.signatureVersion).toBeGreaterThan(0);
    expect(version.signatureDate.getTime()).toBeLessThan(Date.now() + 86_400_000);
  });
  test("passes harmless bytes", async () => {
    await expect(client.scan(once(new TextEncoder().encode("harmless reference text")))).resolves.toEqual({ kind: "clean" });
  });
  test("finds EICAR plain, zipped and nested", async () => {
    for (const bytes of [EICAR, storedZip([{ name: "eicar.txt", data: EICAR }]), storedZip([{ name: "inner.zip", data: storedZip([{ name: "eicar.txt", data: EICAR }]) }])]) {
      await expect(client.scan(once(bytes))).resolves.toMatchObject({ kind: "found", reason: "malware" });
    }
  });
  test("flags an encrypted archive instead of skipping it", async () => {
    await expect(client.scan(once(storedZip([{ name: "secret.txt", data: new Uint8Array(64).fill(1), encrypted: true }])))).resolves.toMatchObject({ kind: "found", reason: "encrypted_archive" });
  });
  test("flags an archive nested beyond MaxRecursion instead of skipping it", async () => {
    // ops/clamav/clamd.conf sets `MaxRecursion 16`; 20 wrapping levels exceeds it with margin.
    let payload: Uint8Array = new TextEncoder().encode("harmless nested payload");
    for (let level = 0; level < 20; level += 1) payload = storedZip([{ name: `level-${level}.zip`, data: payload }]);
    await expect(client.scan(once(payload))).resolves.toMatchObject({ kind: "found", reason: "limits_exceeded" });
  });
});
