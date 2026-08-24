import { describe, expect, test } from "vitest";

import {
  ownerBootstrapUsage,
  parseOwnerBootstrapArguments,
} from "../src/index.js";

describe("owner bootstrap CLI arguments", () => {
  test("requires exact user-bound confirmation flags", () => {
    expect(
      parseOwnerBootstrapArguments([
        "--user-id=owner-user",
        "--revision=task3-revision",
        "--confirm=BOOTSTRAP_OWNER:owner-user",
      ]),
    ).toEqual({
      help: false,
      userId: "owner-user",
      applicationRevision: "task3-revision",
      confirmation: "BOOTSTRAP_OWNER:owner-user",
    });
    expect(() => parseOwnerBootstrapArguments(["owner-user"])).toThrow(
      "INVALID_BOOTSTRAP_ARGUMENTS",
    );
    expect(() => parseOwnerBootstrapArguments(["--user-id=owner-user", "--revision=task3-revision"])).toThrow(
      "INVALID_BOOTSTRAP_ARGUMENTS",
    );
    expect(() =>
      parseOwnerBootstrapArguments([
        "--user-id=owner-user",
        "--revision=task3-revision",
        "--confirm=BOOTSTRAP_OWNER:owner-user",
        "--email=owner@example.com",
      ]),
    ).toThrow("INVALID_BOOTSTRAP_ARGUMENTS");
  });

  test("documents the non-secret confirmation contract", () => {
    expect(parseOwnerBootstrapArguments(["--help"])).toEqual({ help: true });
    expect(ownerBootstrapUsage).toContain("BOOTSTRAP_OWNER:<exact-user-id>");
    expect(ownerBootstrapUsage).not.toContain("BOOTSTRAP_OWNER_EMAIL");
  });
});
