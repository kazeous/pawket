import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { identityEmailHandoffs, identityUsers, systemOutbox } from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import { deliverSecurityEmailHandoff, queueSecurityEmailHandoff } from "../src/security-email-handoff.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase(); const { db } = database;
const now = new Date("2026-09-27T10:00:00Z");
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
beforeAll(() => database.setup(), 30_000); afterAll(() => database.close());
test("retired credential email is audited once without decrypting or sending; business notices still deliver", async () => {
  const userId = randomUUID(); await db.insert(identityUsers).values({ id: userId, name: "Synthetic", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`, emailVerified: false, createdAt: now, updatedAt: now });
  const sender = { send: vi.fn(async () => {}) };
  for (const purpose of ["email_verification", "password_reset", "email_change"] as const) {
    const handoffId = randomUUID();
    await db.transaction((tx) => queueSecurityEmailHandoff(tx, { id: handoffId, userId, purpose, destination: "synthetic@example.test", secret: "synthetic-legacy-token", now, keyring }));
    // Missing decryption keys deliberately prove retirement does not inspect secrets.
    const input = { handoffId, sender, workerId: "synthetic-worker", keyring: {} as typeof keyring, now };
    expect(await deliverSecurityEmailHandoff(db, input)).toBe("attention_required");
    expect(await deliverSecurityEmailHandoff(db, input)).toBe("already_attention_required");
    const [row] = await db.select().from(identityEmailHandoffs).where(eq(identityEmailHandoffs.id, handoffId));
    expect(row).toMatchObject({ status: "attention_required", failureCode: "auth_moved", destinationEnvelope: null, secretEnvelope: null, attempts: 0 });
    expect(await db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, handoffId), eq(systemOutbox.eventType, "identity.credential_email_retired.v1")))).toHaveLength(1);
  }
  expect(sender.send).not.toHaveBeenCalled();
  const handoffId = randomUUID(); await db.transaction((tx) => queueSecurityEmailHandoff(tx, { id: handoffId, userId, purpose: "security_notice", destination: "synthetic@example.test",
    templateData: { event: "session_revoked", returnPath: "/settings/security" }, now, keyring }));
  expect(await deliverSecurityEmailHandoff(db, { handoffId, sender, workerId: "synthetic-worker", keyring, now })).toBe("delivered");
  expect(sender.send).toHaveBeenCalledTimes(1);
});
