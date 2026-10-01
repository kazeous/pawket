import { describe, expect, test } from "vitest";
import { createClamdClient } from "../src/index.js";
import { storedZip } from "./zip-fixtures.js";

const host = process.env.COMMISSION_FILES_CLAMD_HOST ?? "127.0.0.1";
const port = Number(process.env.COMMISSION_FILES_CLAMD_PORT ?? "3310");
const client = createClamdClient({ host, port, timeoutMs: 60_000 });
// The standard antivirus test string. It is not malware; every engine flags it by design.
const EICAR = new TextEncoder().encode(String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`);
async function* once(bytes: Uint8Array) { yield bytes; }

describe("real clamd", () => {
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
});
