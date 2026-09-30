import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
  identityOidcTransactions,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import {
  decryptSensitiveField, encryptSensitiveField, hashOpaqueToken,
  type EncryptionKeyring,
} from "@pawket/security";
import { OIDC_TRANSACTION_MS, OidcIdentityError } from "./oidc-policy.js";
import type { OidcAuthorizationMaterial, OidcProviderConfig } from "./oidc-protocol.js";
import { expireOidcTransientData } from "./oidc-cleanup.js";

export type OidcTransaction = typeof identityOidcTransactions.$inferSelect;
export type OidcActorBinding = Readonly<{
  userId: string; sessionId: string; authorizationVersion: number; subject: string;
}>;
export type OidcTransactionIntent =
  | { purpose: "login" }
  | { purpose: "lease_check"; actor: OidcActorBinding }
  | { purpose: "step_up"; actor: OidcActorBinding; actionClass: string; commandDigest: string }
  | { purpose: "owner_link"; userId: string; subject: string; authorizationVersion: number };

const providerMatches = (config: OidcProviderConfig) => and(
  eq(identityOidcTransactions.issuer, config.issuer),
  eq(identityOidcTransactions.clientId, config.clientId),
  eq(identityOidcTransactions.providerRevision, config.providerRevision),
);
const verifierBinding = (id: string) => ({ recordType: "identity_oidc_transaction", recordId: id, fieldName: "verifier" });

/** A return location is always a local route; never carry OAuth response parameters forward. */
export function safeOidcReturnPath(value: string): string {
  if (value.length > 2048 || /[\\\u0000-\u0020\u007f]/u.test(value) || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u0020\u007f]/u.test(decoded) || decoded.startsWith("//")) return "/";
    const url = new URL(value, "https://pawket.invalid");
    if (url.origin !== "https://pawket.invalid" || url.hash ||
      /^\/(?:api|login|sign-in|register|verify-email|reset-password)(?:\/|$)/u.test(url.pathname)) return "/";
    if ([...url.searchParams.keys()].some((key) => ["code", "state", "error", "id_token", "access_token"].includes(key))) return "/";
    return `${url.pathname}${url.search}`;
  } catch { return "/"; }
}

export function createOidcTransactionRepository(deps: {
  db: PawketDatabase; keyring: EncryptionKeyring; config: OidcProviderConfig;
}) {
  const { db, keyring, config } = deps;
  return {
    async start(input: {
      material: OidcAuthorizationMaterial; browserBinding: string;
      intent: OidcTransactionIntent; returnPath: string; now: Date;
    }): Promise<OidcTransaction> {
      if (input.browserBinding.length < 32 || input.browserBinding.length > 256 ||
        !Number.isFinite(input.now.getTime())) throw new OidcIdentityError("invalid_response");
      const id = randomUUID();
      const intent = input.intent;
      const actor = "actor" in intent ? intent.actor : undefined;
      const [created] = await db.insert(identityOidcTransactions).values({
        id, stateHash: hashOpaqueToken(input.material.state, "oidc-state"),
        browserBindingHash: hashOpaqueToken(input.browserBinding, "oidc-browser"),
        nonce: input.material.nonce,
        verifierEnvelope: encryptSensitiveField({ plaintext: input.material.verifier, binding: verifierBinding(id), keyring }),
        purpose: intent.purpose, issuer: config.issuer, clientId: config.clientId, providerRevision: config.providerRevision,
        expectedUserId: actor?.userId ?? (intent.purpose === "owner_link" ? intent.userId : null),
        expectedSessionId: actor?.sessionId ?? null,
        expectedSubject: actor?.subject ?? (intent.purpose === "owner_link" ? intent.subject : null),
        expectedAuthorizationVersion: actor?.authorizationVersion ?? (intent.purpose === "owner_link" ? intent.authorizationVersion : null),
        actionClass: intent.purpose === "step_up" ? intent.actionClass : null,
        commandDigest: intent.purpose === "step_up" ? intent.commandDigest : null,
        returnPath: safeOidcReturnPath(input.returnPath), createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + OIDC_TRANSACTION_MS),
      }).returning();
      return created!;
    },

    /** Commit the claim BEFORE contacting the IdP. A crash burns this transaction. */
    async claim(input: { state: string; browserBinding: string; now: Date }): Promise<{
      transaction: OidcTransaction; material: OidcAuthorizationMaterial;
    }> {
      if (!input.state || input.state.length > 256 || !input.browserBinding || input.browserBinding.length > 256) {
        throw new OidcIdentityError("invalid_response");
      }
      const [transaction] = await db.update(identityOidcTransactions)
        .set({ status: "exchanging", claimedAt: input.now })
        .where(and(providerMatches(config), eq(identityOidcTransactions.status, "pending"),
          eq(identityOidcTransactions.stateHash, hashOpaqueToken(input.state, "oidc-state")),
          eq(identityOidcTransactions.browserBindingHash, hashOpaqueToken(input.browserBinding, "oidc-browser")),
          gt(identityOidcTransactions.expiresAt, input.now)))
        .returning();
      if (!transaction?.verifierEnvelope) throw new OidcIdentityError("transaction_expired");
      try {
        const verifier = decryptSensitiveField({ envelope: transaction.verifierEnvelope, binding: verifierBinding(transaction.id), keyring });
        return { transaction, material: { state: input.state, nonce: transaction.nonce, verifier } };
      } catch {
        await db.update(identityOidcTransactions).set({ status: "failed", completedAt: input.now, verifierEnvelope: null })
          .where(eq(identityOidcTransactions.id, transaction.id));
        throw new OidcIdentityError("invalid_response");
      }
    },

    async fail(id: string, now: Date): Promise<void> {
      await db.update(identityOidcTransactions).set({ status: "failed", completedAt: now, verifierEnvelope: null })
        .where(and(eq(identityOidcTransactions.id, id), providerMatches(config), inArray(identityOidcTransactions.status, ["pending", "exchanging"])));
    },

    /** Terminal state is committed atomically with provisioning/session/proof updates. */
    async complete<T>(input: { id: string; now: Date }, apply: (tx: PawketTransaction, transaction: OidcTransaction) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const [transaction] = await tx.select().from(identityOidcTransactions).where(and(
          eq(identityOidcTransactions.id, input.id), providerMatches(config),
          eq(identityOidcTransactions.status, "exchanging"), gt(identityOidcTransactions.expiresAt, input.now),
        )).for("update");
        if (!transaction) throw new OidcIdentityError("transaction_expired");
        const result = await apply(tx, transaction);
        await tx.update(identityOidcTransactions).set({ status: "consumed", completedAt: input.now, verifierEnvelope: null })
          .where(eq(identityOidcTransactions.id, transaction.id));
        return result;
      });
    },

    /** Bounded cleanup preserves rows referenced by sessions while erasing transient secrets. */
    async expire(now: Date, limit = 100): Promise<number> {
      return expireOidcTransientData(db, now, limit);
    },
  };
}

/** Both callback and logout acquire these before user/session locks, in lexical order. */
export async function lockOidcRevocationScope(tx: PawketTransaction, input: {
  issuer: string; clientId: string; subject?: string; sid?: string;
}): Promise<void> {
  const keys = [input.sid ? ["sid", input.sid] : null, input.subject ? ["sub", input.subject] : null]
    .filter((key): key is string[] => key !== null)
    .map((key) => JSON.stringify(["pawket-oidc", input.issuer, input.clientId, ...key])).sort();
  for (const key of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
