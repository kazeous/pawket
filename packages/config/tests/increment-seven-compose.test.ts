import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const compose = readFileSync(new URL("../../../compose.prod.yaml", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const service = (name: string) => { const start = compose.indexOf(`\n  ${name}:\n`); const next = compose.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u); return compose.slice(start, next < 0 ? undefined : start + 1 + next); };

describe("production compose for commission files", () => {
  test("runs a digest-pinned clamd on the internal network only", () => {
    const clamd = service("clamd");
    expect(clamd).toMatch(/image: clamav\/clamav:[0-9.]+(?:-debian)?@sha256:[a-f0-9]{64}/u);
    expect(clamd).toContain("image: clamav/clamav:1.5.4-debian@sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578");
    expect(clamd).not.toMatch(/\n    ports:/u);
    expect(clamd).toContain("./ops/clamav/clamd.conf:/etc/clamav/clamd.conf:ro");
    expect(clamd).toContain("exclude_from_hc: true");
  });
  test("uses the same verified image in dev and CI and splits storage credentials", () => {
    const image = "clamav/clamav:1.5.4-debian@sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578";
    for (const path of ["../../../compose.dev.yaml", "../../../.github/workflows/verify.yml"]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).toContain(image);
    }
    for (const name of ["web", "worker"]) {
      const own = name.toUpperCase();
      const other = name === "web" ? "WORKER" : "WEB";
      expect(service(name)).toContain(`COMMISSION_FILES_S3_ACCESS_KEY_ID: $\{COMMISSION_FILES_${own}_ACCESS_KEY_ID:-}`);
      expect(service(name)).toContain(`COMMISSION_FILES_S3_SECRET_ACCESS_KEY: $\{COMMISSION_FILES_${own}_SECRET_ACCESS_KEY:-}`);
      expect(service(name)).not.toContain(`COMMISSION_FILES_${other}_SECRET_ACCESS_KEY`);
    }
  });
  test("never makes web or worker wait for the scanner", () => {
    expect(service("web")).not.toContain("clamd");
    expect(service("worker").match(/depends_on:[\s\S]*$/u)?.[0] ?? "").not.toContain("clamd:");
  });
  test("gives web no scanner settings and keeps every switch off", () => {
    expect(service("web")).not.toContain("COMMISSION_FILES_CLAMD_HOST");
    expect(service("worker")).toContain("COMMISSION_FILES_CLAMD_HOST: clamd");
    for (const name of ["web", "worker"]) {
      expect(service(name)).toContain("COMMISSION_FILES_MODE: disabled");
      expect(service(name)).toContain("COMMISSION_FILE_RETENTION_MODE: report_only");
    }
  });
});
