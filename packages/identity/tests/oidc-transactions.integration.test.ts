import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { identityOidcTransactions } from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import { createOidcTransactionRepository, safeOidcReturnPath } from "../src/oidc-transactions.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase();
const config = { issuer: "https://idp.example/pawket/", clientId: "test-pawket", clientSecret: "x".repeat(40),
  redirectUri: "http://localhost:3000/api/identity/oidc/callback", accountPortalUrl: "https://idp.example/if/user/", providerRevision: "v1" };
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
const repo = createOidcTransactionRepository({ db: database.db, keyring, config });
const now = new Date("2026-09-27T10:00:00Z");
beforeAll(() => database.setup(), 30_000);
afterAll(() => database.close());
async function start() {
  const material = { state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url") };
  const browserBinding = randomBytes(32).toString("base64url");
  const transaction = await repo.start({ material, browserBinding, intent: { purpose: "login" }, returnPath: "/settings/security", now });
  return { material, browserBinding, transaction };
}
async function stored(id: string) {
  return (await database.db.select().from(identityOidcTransactions).where(eq(identityOidcTransactions.id, id)))[0]!;
}
describe("durable browser-bound OIDC transactions", () => {
  test("concurrent callbacks claim once; plaintext state and verifier are never stored", async () => {
    const t = await start();
    const row = await stored(t.transaction.id);
    expect(row.stateHash).not.toContain(t.material.state);
    expect(JSON.stringify(row)).not.toContain(t.material.verifier);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => repo.claim({ state: t.material.state, browserBinding: t.browserBinding, now })));
    const success = results.filter((result) => result.status === "fulfilled");
    expect(success).toHaveLength(1);
    expect(success[0]!.value.material).toEqual(t.material);
    expect((await stored(t.transaction.id)).status).toBe("exchanging");
  });
  test("wrong browser and changed provider cannot burn a valid transaction", async () => {
    const t = await start();
    await expect(repo.claim({ state: t.material.state, browserBinding: "different-browser", now })).rejects.toMatchObject({ code: "transaction_expired" });
    const changed = createOidcTransactionRepository({ db: database.db, keyring, config: { ...config, providerRevision: "v2" } });
    await expect(changed.claim({ state: t.material.state, browserBinding: t.browserBinding, now })).rejects.toMatchObject({ code: "transaction_expired" });
    expect((await stored(t.transaction.id)).status).toBe("pending");
    await expect(repo.claim({ state: t.material.state, browserBinding: t.browserBinding, now })).resolves.toMatchObject({ material: t.material });
  });
  test("completion and session work share a transaction; failed callback cannot replay", async () => {
    const t = await start(); await repo.claim({ state: t.material.state, browserBinding: t.browserBinding, now });
    await expect(repo.complete({ id: t.transaction.id, now }, async () => { throw new Error("session write failed"); })).rejects.toThrow("session write failed");
    expect((await stored(t.transaction.id)).status).toBe("exchanging");
    await repo.fail(t.transaction.id, now);
    expect(await stored(t.transaction.id)).toMatchObject({ status: "failed", verifierEnvelope: null });
    await expect(repo.complete({ id: t.transaction.id, now }, async () => true)).rejects.toMatchObject({ code: "transaction_expired" });
    await expect(repo.claim({ state: t.material.state, browserBinding: t.browserBinding, now })).rejects.toMatchObject({ code: "transaction_expired" });
  });
  test("concurrent completion runs one mutation and erases PKCE material", async () => {
    const t = await start(); await repo.claim({ state: t.material.state, browserBinding: t.browserBinding, now });
    let calls = 0;
    const results = await Promise.allSettled([1, 2].map(() => repo.complete({ id: t.transaction.id, now }, async () => ++calls)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(calls).toBe(1);
    expect(await stored(t.transaction.id)).toMatchObject({ status: "consumed", verifierEnvelope: null, returnPath: "/settings/security" });
  });
  test("deadline includes time spent exchanging; cleanup erases crashed transactions", async () => {
    const t = await start(); await repo.claim({ state: t.material.state, browserBinding: t.browserBinding, now });
    const expired = new Date(now.getTime() + 600_000);
    await expect(repo.complete({ id: t.transaction.id, now: expired }, async () => true)).rejects.toMatchObject({ code: "transaction_expired" });
    await repo.expire(expired);
    expect(await stored(t.transaction.id)).toMatchObject({ status: "failed", verifierEnvelope: null });
  });
  test("copies of encrypted verifiers cannot be transplanted to another transaction", async () => {
    const first = await start(); const second = await start();
    await database.db.update(identityOidcTransactions).set({ verifierEnvelope: first.transaction.verifierEnvelope }).where(eq(identityOidcTransactions.id, second.transaction.id));
    await expect(repo.claim({ state: second.material.state, browserBinding: second.browserBinding, now })).rejects.toMatchObject({ code: "invalid_response" });
    expect(await stored(second.transaction.id)).toMatchObject({ status: "failed", verifierEnvelope: null });
  });
  test.each(["https://evil.example", "//evil.example", "/%2fevil.example", "/\\evil.example", "/%5cevil.example", "/api/auth/callback", "/settings?code=secret", "/settings#access_token=secret", "/settings\r\nLocation:evil"])("rejects unsafe return location %s", (value) => {
    expect(safeOidcReturnPath(value)).toBe("/");
  });
  test("preserves local draft location", () => expect(safeOidcReturnPath("/creator/commissions?draft=123")).toBe("/creator/commissions?draft=123"));
});
