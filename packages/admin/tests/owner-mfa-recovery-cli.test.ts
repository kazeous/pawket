import { describe, expect, test } from "vitest";

import {
  ownerMfaRecoveryConfirmation,
  parseOwnerMfaRecoveryArguments,
} from "../src/index.js";

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
});
