import { describe, expect, it } from "vitest";

import * as composeValidator from "../../../scripts/validate-coolify-compose.mjs";

const { projectCoolifyCompose } = composeValidator;
const redaction = composeValidator as typeof composeValidator & {
  redactSensitiveValues(message: string, environment: Record<string, string>): string;
};

const validCompose = [
  "services:",
  "  postgres:",
  "    image: postgres:18-bookworm",
  "  migrate:",
  "    image: pawket-migrate:test",
  "    exclude_from_hc: true",
  "    environment:",
  "      DATABASE_URL: required",
  "  web:",
  "    image: pawket-web:test",
  "",
].join("\r\n");

describe("projectCoolifyCompose", () => {
  it("removes only the migrate service marker while preserving all other bytes", () => {
    // Catches projection that removes another key or rewrites unrelated line endings.
    expect(projectCoolifyCompose(validCompose)).toBe(
      [
        "services:",
        "  postgres:",
        "    image: postgres:18-bookworm",
        "  migrate:",
        "    image: pawket-migrate:test",
        "    environment:",
        "      DATABASE_URL: required",
        "  web:",
        "    image: pawket-web:test",
        "",
      ].join("\r\n"),
    );
  });

  it("redacts SMTP credentials from Compose validation failures", () => {
    // Catches newly introduced SMTP secrets being printed by deployment diagnostics.
    expect(typeof redaction.redactSensitiveValues).toBe("function");
    const output = redaction.redactSensitiveValues(
      "authentication failed for smtp-user with smtp-password",
      { SMTP_USERNAME: "smtp-user", SMTP_PASSWORD: "smtp-password" },
    );
    expect(output).toBe(
      "authentication failed for [REDACTED SMTP_USERNAME] with [REDACTED SMTP_PASSWORD]",
    );
  });

  it("projects migrate and clamd markers without changing other bytes", () => {
    const source = validCompose.replace("  web:", "  clamd:\r\n    image: clamav/clamav:test\r\n    exclude_from_hc: true\r\n  web:");
    expect(projectCoolifyCompose(source)).toBe(source.replaceAll("    exclude_from_hc: true\r\n", ""));
  });

  it("rejects duplicate and nested clamd markers and a clamd-only exclusion", () => {
    const source = validCompose.replace("  web:", "  clamd:\r\n    image: clamav/clamav:test\r\n    exclude_from_hc: true\r\n  web:");
    expect(() => projectCoolifyCompose(source.replace("    image: clamav/clamav:test", "    exclude_from_hc: true\r\n    image: clamav/clamav:test"))).toThrow("at most one clamd");
    expect(() => projectCoolifyCompose(source.replace("    image: clamav/clamav:test\r\n    exclude_from_hc: true", "    image: clamav/clamav:test\r\n    environment:\r\n      exclude_from_hc: true"))).toThrow("service-level key");
    expect(() => projectCoolifyCompose(source.replace("    image: pawket-migrate:test\r\n    exclude_from_hc: true", "    image: pawket-migrate:test"))).toThrow("found 0 on migrate");
  });

  it("redacts separate web and worker private storage credentials", () => {
    const names = ["COMMISSION_FILES_WEB_SECRET_ACCESS_KEY", "COMMISSION_FILES_WORKER_SECRET_ACCESS_KEY", "COMMISSION_FILES_WEB_ACCESS_KEY_ID", "COMMISSION_FILES_WORKER_ACCESS_KEY_ID"];
    const environment = Object.fromEntries(names.map((name, index) => [name, `synthetic-storage-credential-${index}`]));
    expect(redaction.redactSensitiveValues(Object.values(environment).join(" "), environment)).toBe(names.map((name) => `[REDACTED ${name}]`).join(" "));
  });

  it("rejects a missing Coolify health-check exclusion marker", () => {
    // Catches silently validating a migration that Coolify would include in health checks.
    expect(() =>
      projectCoolifyCompose(validCompose.replace("    exclude_from_hc: true\r\n", "")),
    ).toThrow("exactly one exclude_from_hc: true marker; found 0");
  });

  it("rejects duplicate Coolify health-check exclusion markers", () => {
    // Catches removing one marker while leaving another non-standard key for strict Compose.
    expect(() =>
      projectCoolifyCompose(
        validCompose.replace(
          "    exclude_from_hc: true\r\n",
          "    exclude_from_hc: true\r\n    exclude_from_hc: true\r\n",
        ),
      ),
    ).toThrow("exactly one exclude_from_hc: true marker; found 2");
  });

  it("rejects a service-level marker on a service other than migrate", () => {
    // Catches excluding a long-lived service from Coolify health checks.
    expect(() =>
      projectCoolifyCompose(
        validCompose
          .replace("    exclude_from_hc: true\r\n", "")
          .replace("    image: pawket-web:test\r\n", "    image: pawket-web:test\r\n    exclude_from_hc: true\r\n"),
      ),
    ).toThrow("marker must belong to the migrate service");
  });

  it("rejects a nested marker within the migrate service", () => {
    // Catches treating a nested environment value as the service-level Coolify extension.
    expect(() =>
      projectCoolifyCompose(
        validCompose.replace("    exclude_from_hc: true", "      exclude_from_hc: true"),
      ),
    ).toThrow("marker must be a service-level key");
  });
});
