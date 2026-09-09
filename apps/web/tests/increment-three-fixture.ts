import { createHmac } from "node:crypto";

import type { Page } from "@playwright/test";
import { createDatabase, identitySessions, identityUsers } from "@pawket/database";
import { hashSessionToken } from "@pawket/identity";
import { eq } from "drizzle-orm";

import { browserDatabaseUrl } from "./increment-three-database";

export const creatorSessionToken = "task15-creator-session-token-00000000000000000000";
export const ownerSessionToken = "task15-owner-session-token-0000000000000000000000";
export const acceptanceCreatorUserId = "task17-creator";
export const acceptanceCreatorSessionId = "task17-creator-session";
export const acceptanceCreatorSessionToken =
  "task17-creator-session-token-00000000000000000000";
export const acceptanceCreatorApprovedRevisionId =
  "17000000-0000-4000-8000-000000000002";
export const seededAvatarAssetId = "15000000-0000-4000-8000-000000000010";
export const syntheticPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQqLiDFTEMpAQAv8JHQTwGDCgAAAAASUVORK5CYII=", "base64");
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

async function signInAsCreatorUser(
  page: Page,
  input: Readonly<{ userId: string; sessionId: string; token: string }>,
) {
  const database = createDatabase(browserDatabaseUrl);
  const now = new Date();
  try {
    const [user] = await database.db
      .select({ authorizationVersion: identityUsers.authorizationVersion })
      .from(identityUsers)
      .where(eq(identityUsers.id, input.userId));
    if (!user) throw new Error("Synthetic creator fixture is missing");
    await database.db
      .delete(identitySessions)
      .where(eq(identitySessions.id, input.sessionId));
    await database.db.insert(identitySessions).values({
      id: input.sessionId,
      token: hashSessionToken(input.token),
      userId: input.userId,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      createdAt: now,
      updatedAt: now,
      assuranceState: "active",
      primaryAuthenticatedAt: now,
      mfaVerifiedAt: null,
      lastUsedAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      idleExpiresAt: new Date(now.getTime() + 60 * 60_000),
      authorizationVersion: user.authorizationVersion,
    });
  } finally {
    await database.close();
  }
  return setSession(page, input.token);
}

export function signInAsCreator(page: Page) {
  return signInAsCreatorUser(page, {
    userId: "task15-creator",
    sessionId: "task15-creator-session",
    token: creatorSessionToken,
  });
}

export function signInAsAcceptanceCreator(page: Page) {
  return signInAsCreatorUser(page, {
    userId: acceptanceCreatorUserId,
    sessionId: acceptanceCreatorSessionId,
    token: acceptanceCreatorSessionToken,
  });
}
export function signInAsOwner(page: Page) { return setSession(page, ownerSessionToken); }
