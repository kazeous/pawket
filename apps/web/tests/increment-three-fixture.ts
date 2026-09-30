
import type { Page } from "@playwright/test";
import { createDatabase, identitySessions, identityUsers } from "@pawket/database";
import { hashSessionToken } from "@pawket/identity";
import { eq } from "drizzle-orm";

import { refreshBrowserSession } from "./oidc-browser-fixture";
import { attachSyntheticOidcSession } from "./oidc-test-support";
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
async function setSession(page: Page, token: string) {
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/" }]);
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
    const session = {
      id: input.sessionId,
      token: hashSessionToken(input.token),
      userId: input.userId,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      createdAt: now,
      updatedAt: now,
      assuranceState: "active" as const,
      primaryAuthenticatedAt: now,
      mfaVerifiedAt: null,
      lastUsedAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      idleExpiresAt: new Date(now.getTime() + 60 * 60_000),
      authorizationVersion: user.authorizationVersion,
      revokedAt: null,
      revocationReason: null,
    };
    await database.db.insert(identitySessions).values(session).onConflictDoUpdate({ target: identitySessions.id, set: session });
    await attachSyntheticOidcSession(database.db, { ...input, now });
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
export async function signInAsOwner(page: Page) { await refreshBrowserSession(ownerSessionToken); return setSession(page, ownerSessionToken); }
