import { describe, expect, test, vi } from "vitest";

import type { PawketDatabase } from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";

import {
  OwnerMfaRecoveryError,
  ownerMfaRecoveryConfirmation,
  parseOwnerMfaRecoveryArguments,
  runOwnerMfaRecoveryCli,
} from "../src/index.js";

function recoveryArguments(): string[] {
  return [
    "--user-id=owner-user",
    "--incident-id=incident-42",
    "--repo-proof=repo-ticket-9",
    "--host-proof=host-ticket-8",
    "--authorized-at=2026-08-24T00:00:00.000Z",
    "--revision=af05d661ef806fa7f2e3f63af12ad211e3d8b178",
    `--confirm=${ownerMfaRecoveryConfirmation("owner-user", "incident-42")}`,
  ];
}

function cliEnvironment(
  mode: "disabled" | "external_manual",
  rehearsedAt = "2026-08-25T09:30:00+07:00",
  acceptanceReference = "owner-acceptance-2026-08",
) {
  return {
    OWNER_MFA_RECOVERY_MODE: mode,
    OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE: acceptanceReference,
    OWNER_MFA_RECOVERY_REHEARSED_AT: rehearsedAt,
    APP_REVISION: "af05d661ef806fa7f2e3f63af12ad211e3d8b178",
    DATABASE_URL: "postgresql://must-not-be-printed@localhost/pawket",
    BOOTSTRAP_OWNER_EMAIL: "private-owner@example.test",
    PII_ACTIVE_KEY_ID: "pii-test",
    PII_KEYRING_JSON: { "pii-test": "private-encryption-key" },
  } as const;
}

describe("owner MFA recovery CLI contract", () => {
  test("requires two evidence references, authorization time, revision, and exact confirmation", () => {
    const confirmation = ownerMfaRecoveryConfirmation("owner-user", "incident-42");
    expect(
      parseOwnerMfaRecoveryArguments([
        "--user-id=owner-user",
        "--incident-id=incident-42",
        "--repo-proof=repo-ticket-9",
        "--host-proof=host-ticket-8",
        "--authorized-at=2026-08-24T00:00:00.000Z",
        "--revision=af05d661ef806fa7f2e3f63af12ad211e3d8b178",
        `--confirm=${confirmation}`,
      ]),
    ).toEqual({
      help: false,
      userId: "owner-user",
      incidentId: "incident-42",
      repositoryEvidenceId: "repo-ticket-9",
      hostEvidenceId: "host-ticket-8",
      authorizedAt: "2026-08-24T00:00:00.000Z",
      emergencyReason: undefined,
      applicationRevision: "af05d661ef806fa7f2e3f63af12ad211e3d8b178",
      confirmation,
    });
  });

  test("rejects missing, duplicate, unknown, and free-form emergency inputs", () => {
    expect(() => parseOwnerMfaRecoveryArguments(["--user-id=owner-user"])).toThrow(
      "INVALID_OWNER_MFA_RECOVERY_ARGUMENTS",
    );
    expect(() =>
      parseOwnerMfaRecoveryArguments(["--user-id=one", "--user-id=two"]),
    ).toThrow("INVALID_OWNER_MFA_RECOVERY_ARGUMENTS");
    expect(() => parseOwnerMfaRecoveryArguments(["--unknown=value"])).toThrow(
      "INVALID_OWNER_MFA_RECOVERY_ARGUMENTS",
    );
    expect(() =>
      parseOwnerMfaRecoveryArguments([
        "--user-id=owner-user",
        "--incident-id=incident-42",
        "--repo-proof=repo-ticket-9",
        "--host-proof=host-ticket-8",
        "--authorized-at=2026-08-24T00:00:00.000Z",
        "--revision=revision",
        "--confirm=confirmation",
        "--emergency-reason=free-form",
      ]),
    ).toThrow("INVALID_OWNER_MFA_RECOVERY_ARGUMENTS");
  });

  test("refuses a disabled recovery gate before creating a database handle", async () => {
    // Break caught: the command reaching PostgreSQL when the externally
    // accepted and rehearsed control gate has not been enabled.
    const createDatabase = vi.fn(() => {
      throw new Error("DATABASE_MUST_NOT_OPEN");
    });
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() => cliEnvironment("disabled")),
      createDatabase,
      createEncryptionKeyring: vi.fn(() => ({}) as EncryptionKeyring),
      recoverOwnerMfa: vi.fn(async () => {
        throw new Error("RECOVERY_MUST_NOT_RUN");
      }),
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_DISABLED\n",
    });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  test("refuses a future rehearsal timestamp before creating a database handle", async () => {
    // Break caught: treating a scheduled future rehearsal as a completed
    // external control and reaching PostgreSQL before that rehearsal occurs.
    const createDatabase = vi.fn(() => {
      throw new Error("DATABASE_MUST_NOT_OPEN");
    });
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() =>
        cliEnvironment("external_manual", "2026-08-27T09:30:00+07:00"),
      ),
      createDatabase,
      createEncryptionKeyring: vi.fn(() => ({}) as EncryptionKeyring),
      recoverOwnerMfa: vi.fn(async () => {
        throw new Error("RECOVERY_MUST_NOT_RUN");
      }),
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_DISABLED\n",
    });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  test.each([
    ["spaces", "owner acceptance"],
    ["leading punctuation", "-owner-acceptance"],
    ["control characters", "owner\nacceptance"],
    ["other punctuation", "owner/acceptance"],
    ["non-ASCII characters", "owner-é"],
    ["more than 200 characters", `a${"b".repeat(200)}`],
  ])(
    "refuses an acceptance reference containing %s before any database or keyring side effect",
    async (_case, rejectedReference) => {
      // Break caught: injected or stale configuration bypassing parser parity
      // and allocating privileged dependencies before service validation.
      const close = vi.fn(async () => undefined);
      const createDatabase = vi.fn(() => ({ db: {} as PawketDatabase, close }));
      const createEncryptionKeyring = vi.fn(() => ({}) as EncryptionKeyring);
      const recoverOwnerMfa = vi.fn(async () => ({
        userId: "owner-user",
        authorizationVersion: 9,
        revokedSessionCount: 2,
        invalidatedAuthenticatorCount: 1,
      }));
      const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
        loadServerEnv: vi.fn(() =>
          cliEnvironment(
            "external_manual",
            "2026-08-25T09:30:00+07:00",
            rejectedReference,
          ),
        ),
        createDatabase,
        createEncryptionKeyring,
        recoverOwnerMfa,
        now: () => new Date("2026-08-26T06:00:00.000Z"),
      });

      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_DISABLED\n",
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(rejectedReference);
      expect(createDatabase).not.toHaveBeenCalled();
      expect(createEncryptionKeyring).not.toHaveBeenCalled();
      expect(recoverOwnerMfa).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["one alphanumeric character", "A"],
    ["every permitted punctuation character", "a._:-Z"],
    ["the 200-character boundary", `a${"b".repeat(199)}`],
  ])("accepts an acceptance reference with %s", async (_case, acceptedReference) => {
    // Characterizes exact parity with the server configuration allowlist.
    const close = vi.fn(async () => undefined);
    const recoverOwnerMfa = vi.fn(async () => ({
      userId: "owner-user",
      authorizationVersion: 9,
      revokedSessionCount: 2,
      invalidatedAuthenticatorCount: 1,
    }));
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() =>
        cliEnvironment(
          "external_manual",
          "2026-08-25T09:30:00+07:00",
          acceptedReference,
        ),
      ),
      createDatabase: vi.fn(() => ({ db: {} as PawketDatabase, close })),
      createEncryptionKeyring: vi.fn(() => ({}) as EncryptionKeyring),
      recoverOwnerMfa,
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(recoverOwnerMfa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acceptanceReference: acceptedReference }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test("passes accepted controls into recovery without exposing private evidence", async () => {
    // Break caught: a successful command omitting accepted controls from the
    // service call or printing owner/evidence/security material to its caller.
    const close = vi.fn(async () => undefined);
    const database = {} as PawketDatabase;
    const createDatabase = vi.fn(() => ({ db: database, close }));
    const recoverOwnerMfa = vi.fn(async () => ({
      userId: "owner-user",
      authorizationVersion: 9,
      revokedSessionCount: 2,
      invalidatedAuthenticatorCount: 1,
    }));
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() => cliEnvironment("external_manual")),
      createDatabase,
      createEncryptionKeyring: vi.fn(() => ({}) as EncryptionKeyring),
      recoverOwnerMfa,
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "Owner MFA recovery completed; 2 session(s) revoked; MFA re-enrollment required.\n",
      stderr: "",
    });
    expect(recoverOwnerMfa).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        acceptanceReference: "owner-acceptance-2026-08",
        rehearsedAt: new Date("2026-08-25T02:30:00.000Z"),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    const output = `${result.stdout}${result.stderr}`;
    for (const privateValue of [
      "owner-user",
      "role",
      "repo-ticket-9",
      "host-ticket-8",
      "owner-acceptance-2026-08",
      "private-owner@example.test",
      "private-encryption-key",
      "seed",
      "recovery code",
    ]) {
      expect(output.toLowerCase()).not.toContain(privateValue.toLowerCase());
    }
  });

  test("reports committed recovery with a fixed warning when database cleanup fails", async () => {
    // Break caught: a close rejection escaping the runner and causing the script
    // catch to print a false recovery refusal after the transaction committed.
    const close = vi.fn(async () => {
      throw new Error("private-close-failure");
    });
    const recoverOwnerMfa = vi.fn(async () => ({
      userId: "owner-user",
      authorizationVersion: 9,
      revokedSessionCount: 2,
      invalidatedAuthenticatorCount: 1,
    }));
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() => cliEnvironment("external_manual")),
      createDatabase: vi.fn(() => ({ db: {} as PawketDatabase, close })),
      createEncryptionKeyring: vi.fn(() => ({}) as EncryptionKeyring),
      recoverOwnerMfa,
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result).toEqual({
      exitCode: 3,
      stdout:
        "Owner MFA recovery completed; 2 session(s) revoked; MFA re-enrollment required.\n",
      stderr: "Owner MFA recovery cleanup warning: DATABASE_CLOSE_FAILED\n",
    });
    expect(result.stderr).not.toContain("refused");
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-close-failure");
    expect(recoverOwnerMfa).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("preserves a known recovery refusal when database cleanup also fails", async () => {
    // Break caught: cleanup rejection replacing a known refusal code or adding
    // exception/private detail to command output.
    const close = vi.fn(async () => {
      throw new Error("private-close-failure");
    });
    const recoverOwnerMfa = vi.fn(async () => {
      throw new OwnerMfaRecoveryError("WAIT_PERIOD_REQUIRED");
    });
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() => cliEnvironment("external_manual")),
      createDatabase: vi.fn(() => ({ db: {} as PawketDatabase, close })),
      createEncryptionKeyring: vi.fn(() => ({}) as EncryptionKeyring),
      recoverOwnerMfa,
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "Owner MFA recovery refused: WAIT_PERIOD_REQUIRED\nOwner MFA recovery cleanup warning: DATABASE_CLOSE_FAILED\n",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-close-failure");
    expect(recoverOwnerMfa).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("keeps a keyring failure refused and closes the database exactly once", async () => {
    // Characterizes pre-commit failure handling across the cleanup refactor.
    const close = vi.fn(async () => undefined);
    const recoverOwnerMfa = vi.fn();
    const result = await runOwnerMfaRecoveryCli(recoveryArguments(), {
      loadServerEnv: vi.fn(() => cliEnvironment("external_manual")),
      createDatabase: vi.fn(() => ({ db: {} as PawketDatabase, close })),
      createEncryptionKeyring: vi.fn(() => {
        throw new Error("private-keyring-failure");
      }),
      recoverOwnerMfa,
      now: () => new Date("2026-08-26T06:00:00.000Z"),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_FAILED\n",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-keyring-failure");
    expect(recoverOwnerMfa).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
