import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { describe, expect, test } from "vitest";

import {
  createPawketAuthAdapter,
  hashSessionToken,
} from "../../src/auth-candidate/session-token-adapter.js";

const options = {
  session: {
    additionalFields: {
      lastUsedAt: { type: "date", required: false },
      idleExpiresAt: { type: "date", required: false },
      absoluteExpiresAt: { type: "date", required: false },
    },
  },
} as Parameters<ReturnType<typeof memoryAdapter>>[0];

function createAdapter(db: MemoryDB) {
  return createPawketAuthAdapter(memoryAdapter(db))(options);
}

function sessionData(token: string, userId = "user-1") {
  return {
    id: crypto.randomUUID(),
    token,
    userId,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    expiresAt: new Date("2026-09-24T00:00:00.000Z"),
  };
}

describe("hashed session adapter boundary", () => {
  test("returns the opaque token while storing only its hash", async () => {
    const db: MemoryDB = {};
    const adapter = createAdapter(db);
    const rawToken = "raw-session-secret-with-high-entropy-123";

    const created = await adapter.create<Record<string, unknown>>({
      model: "session",
      data: sessionData(rawToken),
    });

    expect(created.token).toBe(rawToken);
    expect(db.session?.[0]?.token).toBe(hashSessionToken(rawToken));
    expect(JSON.stringify(db)).not.toContain(rawToken);
  });

  test("looks up, rotates, lists, revokes, and revokes all without persisting raw secrets", async () => {
    const db: MemoryDB = {};
    const adapter = createAdapter(db);
    const first = "first-opaque-session-secret";
    const second = "second-opaque-session-secret";

    await adapter.create({ model: "session", data: sessionData(first) });
    await adapter.create({ model: "session", data: sessionData(second) });

    const found = await adapter.findOne<Record<string, unknown>>({
      model: "session",
      where: [{ field: "token", value: first }],
    });
    expect(found?.token).toBe(first);

    const rotated = "rotated-opaque-session-secret";
    const updated = await adapter.update<Record<string, unknown>>({
      model: "session",
      where: [{ field: "token", value: first }],
      update: {
        token: rotated,
        updatedAt: new Date("2026-08-24T01:00:00.000Z"),
      },
    });
    expect(updated?.token).toBe(rotated);
    await expect(
      adapter.findOne({ model: "session", where: [{ field: "token", value: first }] }),
    ).resolves.toBeNull();
    await expect(
      adapter.findOne<Record<string, unknown>>({
        model: "session",
        where: [{ field: "token", value: rotated }],
      }),
    ).resolves.toEqual(expect.objectContaining({ token: rotated }));

    const listed = await adapter.findMany<Record<string, unknown>>({
      model: "session",
      where: [{ field: "userId", value: "user-1" }],
      limit: 100,
    });
    expect(listed).toHaveLength(2);
    expect(listed.every((row) => String(row.token).startsWith("sha256:"))).toBe(true);

    await adapter.delete({ model: "session", where: [{ field: "token", value: rotated }] });
    await expect(
      adapter.findOne({ model: "session", where: [{ field: "token", value: rotated }] }),
    ).resolves.toBeNull();

    await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "user-1" }] });
    await expect(
      adapter.findMany({ model: "session", where: [{ field: "userId", value: "user-1" }], limit: 100 }),
    ).resolves.toHaveLength(0);
  });

  test("does not accept a persisted token hash as an opaque session secret", async () => {
    const db: MemoryDB = {};
    const adapter = createAdapter(db);
    const rawToken = "opaque-session-secret";
    await adapter.create({ model: "session", data: sessionData(rawToken) });
    const storedHash = db.session?.[0]?.token as string;

    await expect(
      adapter.findOne({ model: "session", where: [{ field: "token", value: storedHash }] }),
    ).resolves.toBeNull();
  });

  test("refreshes within the original idle window and absolute deadline", async () => {
    const db: MemoryDB = {};
    const adapter = createAdapter(db);
    const token = "owner-session-with-restricted-idle-window";
    const createdAt = new Date("2026-08-24T00:00:00.000Z");
    await adapter.create({
      model: "session",
      data: {
        ...sessionData(token),
        createdAt,
        updatedAt: createdAt,
        lastUsedAt: createdAt,
        expiresAt: new Date("2026-08-24T00:30:00.000Z"),
        idleExpiresAt: new Date("2026-08-24T00:30:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-24T12:00:00.000Z"),
      },
    });

    await adapter.update({
      model: "session",
      where: [{ field: "token", value: token }],
      update: {
        updatedAt: new Date("2026-08-24T00:10:00.000Z"),
        expiresAt: new Date("2026-09-24T00:10:00.000Z"),
      },
    });

    expect(db.session?.[0]).toEqual(
      expect.objectContaining({
        lastUsedAt: new Date("2026-08-24T00:10:00.000Z"),
        idleExpiresAt: new Date("2026-08-24T00:40:00.000Z"),
        expiresAt: new Date("2026-08-24T00:40:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-24T12:00:00.000Z"),
      }),
    );
  });

  test("does not retain sign-in-only OAuth tokens", async () => {
    const db: MemoryDB = {};
    const adapter = createAdapter(db);

    const created = await adapter.create<Record<string, unknown>>({
      model: "account",
      data: {
        id: "account-1",
        accountId: "google-subject",
        providerId: "google",
        issuer: "https://accounts.google.com",
        userId: "user-1",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        idToken: "id-secret",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(created).toEqual(
      expect.objectContaining({ accessToken: null, refreshToken: null, idToken: null }),
    );
    expect(db.account?.[0]).toEqual(
      expect.objectContaining({ accessToken: null, refreshToken: null, idToken: null }),
    );
    expect(JSON.stringify(db)).not.toMatch(/access-secret|refresh-secret|id-secret/);
  });
});
