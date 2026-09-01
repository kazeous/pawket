import { createHmac } from "node:crypto";

import type { Page } from "@playwright/test";
import { createDatabase, identitySessions, identityUsers } from "@pawket/database";
import { hashSessionToken } from "@pawket/identity";
import { eq } from "drizzle-orm";

export const creatorSessionToken = "task15-creator-session-token-00000000000000000000";
export const ownerSessionToken = "task15-owner-session-token-0000000000000000000000";
const authSecret = "playwright-only-better-auth-secret-000000000000";
const ownerTotpSecret = "3132333435363738393031323334353637383930";

export function currentOwnerTotp(now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", ownerTotpSecret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

function signedSessionToken(token: string) {
  return `${token}.${createHmac("sha256", authSecret).update(token).digest("base64")}`;
}

async function setSession(page: Page, token: string) {
  await page.context().addCookies([{ name: "pawket.session", value: signedSessionToken(token), domain: "127.0.0.1", path: "/" }]);
}

export async function signInAsCreator(page: Page) {
  const database = createDatabase("postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev");
  const now = new Date();
  try {
    const [user] = await database.db.select({ authorizationVersion: identityUsers.authorizationVersion }).from(identityUsers).where(eq(identityUsers.id, "task15-creator"));
    await database.db.delete(identitySessions).where(eq(identitySessions.id, "task15-creator-session"));
    await database.db.insert(identitySessions).values({ id: "task15-creator-session", token: hashSessionToken(creatorSessionToken), userId: "task15-creator", expiresAt: new Date(now.getTime() + 60 * 60_000), createdAt: now, updatedAt: now, assuranceState: "active", primaryAuthenticatedAt: now, mfaVerifiedAt: null, lastUsedAt: now, absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000), idleExpiresAt: new Date(now.getTime() + 60 * 60_000), authorizationVersion: user!.authorizationVersion });
  } finally {
    await database.close();
  }
  return setSession(page, creatorSessionToken);
}
export function signInAsOwner(page: Page) { return setSession(page, ownerSessionToken); }
