import { createHash } from "node:crypto";

import type { BetterAuthOptions } from "better-auth";
import type {
  DBAdapter,
  DBTransactionAdapter,
  JoinOption,
  Where,
} from "better-auth/adapters";

const SESSION_HASH_PREFIX = "sha256:";

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

function protectWrite<T extends Record<string, unknown>>(model: string, value: T): T {
  if (model === "session" && typeof value.token === "string") {
    return { ...value, token: hashSessionToken(value.token) } as T;
  }

  if (model === "account") {
    return {
      ...value,
      ...(Object.hasOwn(value, "accessToken") ? { accessToken: null } : {}),
      ...(Object.hasOwn(value, "refreshToken") ? { refreshToken: null } : {}),
      ...(Object.hasOwn(value, "idToken") ? { idToken: null } : {}),
    } as T;
  }

  return value;
}

function wrapOperations<Options extends BetterAuthOptions>(
  adapter: DBTransactionAdapter<Options>,
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
      const stored = await adapter.create<T, R>({
        ...input,
        data: protectWrite(input.model, input.data),
      });
      return restoreRawToken(stored, rawToken);
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
      let protectedUpdate = protectWrite(input.model, input.update);
      if (input.model === "session" && input.update.expiresAt instanceof Date) {
        const current = await adapter.findOne<Record<string, unknown>>({
          model: input.model,
          where: protectedWhere,
        });
        if (
          current?.absoluteExpiresAt instanceof Date &&
          current.idleExpiresAt instanceof Date
        ) {
          const refreshedIdle = new Date(
            Math.min(input.update.expiresAt.getTime(), current.absoluteExpiresAt.getTime()),
          );
          protectedUpdate = {
            ...protectedUpdate,
            expiresAt: refreshedIdle,
            idleExpiresAt: refreshedIdle,
            lastUsedAt:
              input.update.updatedAt instanceof Date ? input.update.updatedAt : new Date(),
          };
        }
      }
      const stored = await adapter.update<T>({
        ...input,
        where: protectedWhere,
        update: protectedUpdate,
      });
      return restoreRawToken(stored, rawToken);
    },
    updateMany(input: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Promise<number> {
      return adapter.updateMany({
        ...input,
        where: protectWhere(input.model, input.where),
        update: protectWrite(input.model, input.update),
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
      return restoreRawToken(stored, rawToken);
    },
    findMany<T>(input: {
      model: string;
      where?: Where[];
      limit?: number;
      select?: string[];
      sortBy?: { field: string; direction: "asc" | "desc" };
      offset?: number;
      join?: JoinOption;
    }): Promise<T[]> {
      return adapter.findMany<T>({
        ...input,
        where: input.where ? protectWhere(input.model, input.where) : undefined,
      });
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
      return restoreRawToken(stored, rawToken);
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
        set: input.set ? protectWrite(input.model, input.set) : undefined,
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

function wrapAdapter<Options extends BetterAuthOptions>(adapter: DBAdapter<Options>): DBAdapter<Options> {
  return {
    ...adapter,
    ...wrapOperations(adapter),
    transaction<R>(callback: (transaction: DBTransactionAdapter<Options>) => Promise<R>): Promise<R> {
      return adapter.transaction((transaction) => callback(wrapOperations(transaction)));
    },
  };
}

type StructurallyCompatibleAdapterFactory = (...args: never[]) => unknown;

export function createPawketAuthAdapter<Factory extends StructurallyCompatibleAdapterFactory>(
  baseFactory: Factory,
): Factory {
  const wrappedFactory = (...args: Parameters<Factory>): ReturnType<Factory> => {
    // Better Auth 1.7.1 can install equivalent AdapterFactory declarations in separate
    // peer graphs. Preserve the concrete factory signature and bridge only at this boundary.
    const adapter = baseFactory(...args) as unknown as DBAdapter<BetterAuthOptions>;
    return wrapAdapter(adapter) as unknown as ReturnType<Factory>;
  };

  return wrappedFactory as unknown as Factory;
}
