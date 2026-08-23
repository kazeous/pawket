import { hash, Algorithm } from "@node-rs/argon2";
import { describe, expect, test } from "vitest";

import {
  hashPassword,
  passwordHashNeedsUpgrade,
  validatePasswordLength,
  verifyPassword,
} from "../../src/auth-candidate/password.js";

describe("candidate password conformance", () => {
  test("accepts 15 through 128 Unicode code points without composition rules", () => {
    expect(validatePasswordLength("a".repeat(14))).toBe(false);
    expect(validatePasswordLength("correct horse 🐴".padEnd(15, " "))).toBe(true);
    expect(validatePasswordLength("x".repeat(128))).toBe(true);
    expect(validatePasswordLength("x".repeat(129))).toBe(false);
  });

  test("stores a versioned Argon2id PHC string and verifies it", async () => {
    const password = "a long password-manager value 🔐";
    const passwordHash = await hashPassword(password);

    expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    await expect(verifyPassword({ hash: passwordHash, password })).resolves.toBe(true);
    await expect(verifyPassword({ hash: passwordHash, password: `${password}!` })).resolves.toBe(false);
    expect(passwordHashNeedsUpgrade(passwordHash)).toBe(false);
  });

  test("detects an older work factor for upgrade after sign-in", async () => {
    const legacyHash = await hash("legacy password value", {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });

    expect(passwordHashNeedsUpgrade(legacyHash)).toBe(true);
  });
});
