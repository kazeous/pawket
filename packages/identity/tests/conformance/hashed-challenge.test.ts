import { describe, expect, test } from "vitest";

import {
  InMemoryAuthChallengeStore,
  issueAuthChallenge,
} from "../../src/auth-candidate/hashed-challenge.js";

describe("purpose-bound auth challenges", () => {
  test.each(["email_verification", "password_reset"] as const)(
    "%s is hashed at rest, purpose-bound, expiring, and single-use",
    async (purpose) => {
      const store = new InMemoryAuthChallengeStore();
      const challenge = issueAuthChallenge({
        userId: "user-1",
        purpose,
        expiresAt: new Date("2026-08-24T00:30:00.000Z"),
        store,
      });
      const snapshot = store.snapshot();

      expect(snapshot).toEqual([
        expect.objectContaining({ purpose, tokenHash: expect.stringMatching(/^sha256:/) }),
      ]);
      expect(JSON.stringify(snapshot)).not.toContain(challenge.token);
      const otherPurpose = purpose === "email_verification" ? "password_reset" : "email_verification";
      await expect(
        store.consume({
          purpose: otherPurpose,
          token: challenge.token,
          now: new Date("2026-08-24T00:01:00.000Z"),
        }),
      ).resolves.toBeNull();
      await expect(
        store.consume({
          purpose,
          token: challenge.token,
          now: new Date("2026-08-24T00:01:00.000Z"),
        }),
      ).resolves.toEqual(expect.objectContaining({ userId: "user-1", consumedAt: expect.any(Date) }));
      await expect(
        store.consume({
          purpose,
          token: challenge.token,
          now: new Date("2026-08-24T00:02:00.000Z"),
        }),
      ).resolves.toBeNull();
    },
  );

  test("rejects an expired challenge", async () => {
    const store = new InMemoryAuthChallengeStore();
    const challenge = issueAuthChallenge({
      userId: "user-1",
      purpose: "password_reset",
      expiresAt: new Date("2026-08-24T00:30:00.000Z"),
      store,
    });

    await expect(
      store.consume({
        purpose: "password_reset",
        token: challenge.token,
        now: new Date("2026-08-24T00:30:00.000Z"),
      }),
    ).resolves.toBeNull();
  });
});
