import { createHash, randomUUID } from "node:crypto";

import type { BetterAuthOptions } from "better-auth";
import type {
  DBAdapter,
  DBTransactionAdapter,
  JoinOption,
  Where,
} from "better-auth/adapters";

import {
  decryptSensitiveField,
  encryptSensitiveField,
  type EncryptionEnvelope,
  type EncryptionKeyring,
} from "@pawket/security";
import { canonicalizeEmailAddress } from "../core-identity-policy.js";

const SESSION_HASH_PREFIX = "sha256:";
const TOTP_MODELS = new Set(["twoFactor", "identityTwoFactors", "identityTotpAuthenticators"]);

function providerIssuer(providerId: unknown): string | null {
  if (providerId === "credential") return "local:credential";
  if (providerId === "google") return "https://accounts.google.com";
  if (providerId === "discord") return "https://discord.com";
  return null;
}

function totpBinding(authenticatorId: string) {
  return {
    recordType: "identity_totp_authenticator",
    recordId: authenticatorId,
    fieldName: "secret",
  } as const;
}

export function hashSessionToken(token: string): string {
  return `${SESSION_HASH_PREFIX}${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

function hashWhereValue(value: Where["value"]): Where["value"] {
  if (typeof value === "string") return hashSessionToken(value);
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? hashSessionToken(item) : item)) as
      | string[]
      | number[];
  }
  return value;
}

function protectWhere(model: string, where: Where[]): Where[] {
  if (model !== "session") return where;
  return where.map((item) =>
    item.field === "token" ? { ...item, value: hashWhereValue(item.value) } : item,
  );
}

function rawTokenFromWhere(model: string, where: Where[]): string | null {
  if (model !== "session") return null;
  const token = where.find((item) => item.field === "token")?.value;
  return typeof token === "string" ? token : null;
}

function restoreRawToken<T>(value: T, rawToken: string | null): T {
  if (!rawToken || !value || typeof value !== "object") return value;
  return { ...value, token: rawToken };
}

function protectWrite<T extends Record<string, unknown>>(
  model: string,
  value: T,
  keyring?: EncryptionKeyring,
  current?: Record<string, unknown> | null,
): T {
  if (model === "session" && typeof value.token === "string") {
    return { ...value, token: hashSessionToken(value.token) } as T;
  }

  if (model === "account") {
    const issuer = providerIssuer(value.providerId ?? current?.providerId);
    return {
      ...value,
      ...(issuer ? { issuer } : {}),
      ...(Object.hasOwn(value, "accessToken") ? { accessToken: null } : {}),
      ...(Object.hasOwn(value, "refreshToken") ? { refreshToken: null } : {}),
      ...(Object.hasOwn(value, "idToken") ? { idToken: null } : {}),
      ...(Object.hasOwn(value, "accessTokenExpiresAt") ? { accessTokenExpiresAt: null } : {}),
      ...(Object.hasOwn(value, "refreshTokenExpiresAt") ? { refreshTokenExpiresAt: null } : {}),
      ...(Object.hasOwn(value, "scope") ? { scope: null } : {}),
    } as T;
  }

  if (TOTP_MODELS.has(model) && typeof value.secret === "string") {
    const authenticatorId = value.id ?? current?.id;
    if (!keyring || typeof authenticatorId !== "string") {
      throw new Error("TOTP encryption is unavailable");
    }
    return {
      ...value,
      secret: encryptSensitiveField({
        plaintext: value.secret,
        binding: totpBinding(authenticatorId),
        keyring,
      }),
      ...(Object.hasOwn(value, "backupCodes") ? { backupCodes: "[]" } : {}),
    } as T;
  }

  return value;
}

function restoreRead<T>(model: string, value: T, keyring?: EncryptionKeyring): T {
  if (!TOTP_MODELS.has(model) || !value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!keyring || typeof record.id !== "string" || typeof record.secret !== "object") {
    return value;
  }
  return {
    ...record,
    secret: decryptSensitiveField({
      envelope: record.secret as EncryptionEnvelope<"identity_totp_authenticator", "secret">,
      binding: totpBinding(record.id),
      keyring,
    }),
  } as T;
}

function wrapOperations<Options extends BetterAuthOptions>(
  adapter: DBTransactionAdapter<Options>,
  protection?: { keyring?: EncryptionKeyring; requireVerifiedSocialUser?: boolean },
): DBTransactionAdapter<Options> {
  return {
    ...adapter,
    async create<T extends Record<string, unknown>, R = T>(input: {
      model: string;
      data: Omit<T, "id">;
      select?: string[];
      forceAllowId?: boolean;
    }): Promise<R> {
      const rawToken =
        input.model === "session" && typeof input.data.token === "string" ? input.data.token : null;
      let inputData = input.data;
      if (protection?.requireVerifiedSocialUser && input.model === "user") {
        if (input.data.emailVerified !== true || typeof input.data.email !== "string") {
          throw new Error("Verified provider identity is required");
        }
        const email = canonicalizeEmailAddress(input.data.email);
        const verifiedAt = new Date();
        inputData = {
          ...input.data,
          email: email.display,
          canonicalEmail: email.canonical,
          emailVerifiedAt: verifiedAt,
          emailVerificationProvenance: "provider_assertion",
          accessStatus: "active",
          authorizationVersion: 1,
          twoFactorEnabled: false,
        };
      }
      let forceAllowId = input.forceAllowId;
      if (TOTP_MODELS.has(input.model) && typeof inputData.id !== "string") {
        inputData = { ...inputData, id: randomUUID() };
        forceAllowId = true;
      }
      const stored = await adapter.create<T, R>({
        ...input,
        forceAllowId,
        data: protectWrite(input.model, inputData, protection?.keyring),
      });
      return restoreRead(input.model, restoreRawToken(stored, rawToken), protection?.keyring);
    },
    async update<T>(input: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Promise<T | null> {
      const rawToken =
        input.model === "session" && typeof input.update.token === "string"
          ? input.update.token
          : rawTokenFromWhere(input.model, input.where);
      const protectedWhere = protectWhere(input.model, input.where);
      let current: Record<string, unknown> | null = null;
      if (TOTP_MODELS.has(input.model)) {
        current = await adapter.findOne<Record<string, unknown>>({
          model: input.model,
          where: protectedWhere,
        });
      }
      let protectedUpdate = protectWrite(
        input.model,
        input.update,
        protection?.keyring,
        current,
      );
      if (input.model === "session" && input.update.expiresAt instanceof Date) {
        const current = await adapter.findOne<Record<string, unknown>>({
          model: input.model,
          where: protectedWhere,
        });
        if (
          current?.absoluteExpiresAt instanceof Date &&
          current.idleExpiresAt instanceof Date &&
          current.lastUsedAt instanceof Date
        ) {
          const refreshedAt =
            input.update.updatedAt instanceof Date ? input.update.updatedAt : new Date();
          const idleLifetime = Math.max(
            0,
            current.idleExpiresAt.getTime() - current.lastUsedAt.getTime(),
          );
          const refreshedIdle = new Date(
            Math.min(
              input.update.expiresAt.getTime(),
              current.absoluteExpiresAt.getTime(),
              refreshedAt.getTime() + idleLifetime,
            ),
          );
          protectedUpdate = {
            ...protectedUpdate,
            expiresAt: refreshedIdle,
            idleExpiresAt: refreshedIdle,
            lastUsedAt: refreshedAt,
          };
        }
      }
      const stored = await adapter.update<T>({
        ...input,
        where: protectedWhere,
        update: protectedUpdate,
      });
      return restoreRead(input.model, restoreRawToken(stored, rawToken), protection?.keyring);
    },
    updateMany(input: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Promise<number> {
      return adapter.updateMany({
        ...input,
        where: protectWhere(input.model, input.where),
        update: protectWrite(input.model, input.update, protection?.keyring),
      });
    },
    async findOne<T>(input: {
      model: string;
      where: Where[];
      select?: string[];
      join?: JoinOption;
    }): Promise<T | null> {
      const rawToken = rawTokenFromWhere(input.model, input.where);
      const stored = await adapter.findOne<T>({
        ...input,
        where: protectWhere(input.model, input.where),
      });
      return restoreRead(input.model, restoreRawToken(stored, rawToken), protection?.keyring);
    },
    async findMany<T>(input: {
      model: string;
      where?: Where[];
      limit?: number;
      select?: string[];
      sortBy?: { field: string; direction: "asc" | "desc" };
      offset?: number;
      join?: JoinOption;
    }): Promise<T[]> {
      const stored = await adapter.findMany<T>({
        ...input,
        where: input.where ? protectWhere(input.model, input.where) : undefined,
      });
      return stored.map((value) => restoreRead(input.model, value, protection?.keyring));
    },
    delete(input: { model: string; where: Where[] }): Promise<void> {
      return adapter.delete({ ...input, where: protectWhere(input.model, input.where) });
    },
    deleteMany(input: { model: string; where: Where[] }): Promise<number> {
      return adapter.deleteMany({ ...input, where: protectWhere(input.model, input.where) });
    },
    async consumeOne<T>(input: { model: string; where: Where[] }): Promise<T | null> {
      const rawToken = rawTokenFromWhere(input.model, input.where);
      const stored = await adapter.consumeOne<T>({
        ...input,
        where: protectWhere(input.model, input.where),
      });
      return restoreRead(input.model, restoreRawToken(stored, rawToken), protection?.keyring);
    },
    incrementOne<T>(input: {
      model: string;
      where: Where[];
      increment: Record<string, number>;
      set?: Record<string, unknown>;
    }): Promise<T | null> {
      return adapter.incrementOne<T>({
        ...input,
        where: protectWhere(input.model, input.where),
        set: input.set ? protectWrite(input.model, input.set, protection?.keyring) : undefined,
      });
    },
    count(input: { model: string; where?: Where[] }): Promise<number> {
      return adapter.count({
        ...input,
        where: input.where ? protectWhere(input.model, input.where) : undefined,
      });
    },
  };
}

function wrapAdapter<Options extends BetterAuthOptions>(
  adapter: DBAdapter<Options>,
  protection?: { keyring?: EncryptionKeyring; requireVerifiedSocialUser?: boolean },
): DBAdapter<Options> {
  return {
    ...adapter,
    ...wrapOperations(adapter, protection),
    transaction<R>(callback: (transaction: DBTransactionAdapter<Options>) => Promise<R>): Promise<R> {
      return adapter.transaction((transaction) => callback(wrapOperations(transaction, protection)));
    },
  };
}

type StructurallyCompatibleAdapterFactory = (...args: never[]) => unknown;

export function createPawketAuthAdapter<Factory extends StructurallyCompatibleAdapterFactory>(
  baseFactory: Factory,
  options?: { keyring: EncryptionKeyring; requireVerifiedSocialUser?: boolean },
): Factory {
  const wrappedFactory = (...args: Parameters<Factory>): ReturnType<Factory> => {
    // Better Auth 1.7.1 can install equivalent AdapterFactory declarations in separate
    // peer graphs. Preserve the concrete factory signature and bridge only at this boundary.
    const adapter = baseFactory(...args) as unknown as DBAdapter<BetterAuthOptions>;
    return wrapAdapter(adapter, options) as unknown as ReturnType<Factory>;
  };

  return wrappedFactory as unknown as Factory;
}
