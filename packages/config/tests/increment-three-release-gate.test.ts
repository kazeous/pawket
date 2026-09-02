import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  INCREMENT_THREE_FAILURE_CODES,
  validate,
} from "../../../scripts/validate-increment-three-release.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const validatorPath = "scripts/validate-increment-three-release.mjs";
const revision = "9f6ac0e1b2d34567890abcdef1234567890abcde";

const accepted = (reference: string) => ({ accepted: true, reference });

function completePacket() {
  return {
    sourceRevision: revision,
    buildRevision: revision,
    incrementTwo: accepted("increment-two-acceptance-2026-08-20"),
    creatorOnboarding: accepted("owner-onboarding-authorization-2026-08-28"),
    objectStorage: {
      leastPrivilegeIam: accepted("storage-iam-review-2026-08-30"),
      bucketsPrivate: accepted("bucket-privacy-review-2026-08-30"),
      versioningEnabled: accepted("bucket-versioning-review-2026-08-30"),
      exactOriginCors: accepted("bucket-cors-review-2026-08-30"),
    },
    ingress: {
      realIpOverwritten: accepted("ingress-real-ip-review-2026-08-31"),
      directPortIsolated: accepted("ingress-port-isolation-review-2026-08-31"),
    },
    backupRestore: accepted("object-storage-restore-rehearsal-2026-09-01"),
    policies: {
      contentPolicy: accepted("content-policy-2026-09-01"),
      privacyNotice: accepted("privacy-notice-2026-09-01"),
      terms: accepted("terms-2026-09-01"),
      retentionDisclosure: accepted("retention-disclosure-2026-09-01"),
      intellectualProperty: accepted("intellectual-property-policy-2026-09-01"),
    },
    reportOperator: accepted("report-operator-assignment-2026-09-01"),
    reportTriageRehearsal: accepted("report-triage-rehearsal-2026-09-01"),
    syntheticJourney: accepted("synthetic-no-money-journey-2026-09-02"),
    mediaRetentionActivation: { accepted: false, reference: "" },
  };
}

async function run(args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((complete) => {
    const child = spawn(process.execPath, [...args], { cwd: repositoryRoot, env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => complete({ code, stdout, stderr }));
  });
}

describe("Increment 3 release gate", () => {
  let directory: string;
  let acceptanceFile: string;
  let missingAcceptance: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pawket-increment-three-gate-"));
    acceptanceFile = join(directory, "activation-packet.json");
    missingAcceptance = join(directory, "absent-activation-packet.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writePacket(packet: unknown): Promise<string> {
    await writeFile(acceptanceFile, JSON.stringify(packet, null, 2), "utf8");
    return acceptanceFile;
  }

  test("release validator rejects enabled publishing without accepted external rows", async () => {
    const result = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile: missingAcceptance,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("increment_two_not_accepted");
    expect(result.failures).toContain("object_storage_restore_not_accepted");
    expect(result.failures).toContain("report_operator_not_accepted");
    expect(result.failures).toContain("acceptance_packet_missing");
    expect(result.failures).toContain("creator_onboarding_not_authorized");
    expect(result.failures).toContain("synthetic_journey_not_recorded");
  });

  test("passes while publishing is disabled and no activation packet exists", async () => {
    // Catches a gate that blocks Task 17 evidence collection before any owner activation.
    const result = await validate({
      CREATOR_PUBLISHING_MODE: "disabled",
      acceptanceFile: missingAcceptance,
    });

    expect(result).toMatchObject({ ok: true, mode: "disabled", failures: [] });
  });

  test("accepts enabled publishing only with a complete activation packet", async () => {
    const result = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile: await writePacket(completePacket()),
    });

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("lists every unaccepted row of an incomplete packet", async () => {
    // Catches a validator that stops at the first missing acceptance row.
    const packet = completePacket();
    packet.buildRevision = "1111111111111111111111111111111111111111";
    packet.objectStorage.exactOriginCors = { accepted: false, reference: "" };
    packet.objectStorage.versioningEnabled = { accepted: true, reference: "   " };
    packet.ingress.directPortIsolated = { accepted: false, reference: "" };
    packet.policies.privacyNotice = { accepted: false, reference: "" };
    packet.reportTriageRehearsal = { accepted: false, reference: "" };

    const result = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile: await writePacket(packet),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "source_revision_mismatch",
        "object_storage_cors_not_exact_origin",
        "object_storage_versioning_not_enabled",
        "ingress_direct_port_not_isolated",
        "privacy_notice_not_accepted",
        "report_triage_rehearsal_not_accepted",
      ]),
    );
    expect(result.failures).not.toContain("increment_two_not_accepted");
    expect(result.failures).not.toContain("object_storage_restore_not_accepted");
    expect(result.failures).not.toContain("ingress_real_ip_not_overwritten");
    expect(result.failures).not.toContain("acceptance_packet_missing");
  });

  test("reports only failure codes from the exported closed set", async () => {
    // Catches prose failures that a release gate cannot assert on exactly.
    const enabled = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile: missingAcceptance,
    });
    const invalidMode = await validate({
      CREATOR_PUBLISHING_MODE: "beta_audience",
      acceptanceFile: missingAcceptance,
    });

    expect(INCREMENT_THREE_FAILURE_CODES).toContain("media_retention_not_report_only");
    expect(new Set(INCREMENT_THREE_FAILURE_CODES).size).toBe(INCREMENT_THREE_FAILURE_CODES.length);
    for (const failure of [...enabled.failures, ...invalidMode.failures]) {
      expect(INCREMENT_THREE_FAILURE_CODES).toContain(failure);
    }
    expect(invalidMode.failures).toContain("publishing_mode_invalid");
  });

  test("keeps media retention report-only unless its activation rows are accepted", async () => {
    const withoutRetentionAcceptance = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      PUBLIC_MEDIA_RETENTION_MODE: "enforce",
      RETENTION_MODE: "enforce",
      RETENTION_ENFORCEMENT_PAUSED: "false",
      acceptanceFile: await writePacket(completePacket()),
    });

    const activated = completePacket();
    activated.mediaRetentionActivation = accepted("media-retention-activation-2026-09-02");
    const withRetentionAcceptance = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      PUBLIC_MEDIA_RETENTION_MODE: "enforce",
      RETENTION_MODE: "enforce",
      RETENTION_ENFORCEMENT_PAUSED: "false",
      acceptanceFile: await writePacket(activated),
    });

    expect(withoutRetentionAcceptance.failures).toContain("media_retention_not_report_only");
    expect(withRetentionAcceptance.failures).not.toContain("media_retention_not_report_only");
    expect(withRetentionAcceptance.ok).toBe(true);
  });

  test("never lets accepted retention rows bypass the global enforcement pause", async () => {
    const activated = completePacket();
    activated.mediaRetentionActivation = accepted("media-retention-activation-2026-09-02");

    const paused = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      PUBLIC_MEDIA_RETENTION_MODE: "enforce",
      RETENTION_MODE: "enforce",
      RETENTION_ENFORCEMENT_PAUSED: "true",
      acceptanceFile: await writePacket(activated),
    });

    expect(paused.ok).toBe(false);
    expect(paused.failures).toContain("retention_global_pause_bypassed");
  });

  test("runs the alert-runbook and disabled-mode invariants in both modes", async () => {
    // Catches static repository checks that only run once publishing is enabled, and
    // static checks that are declared but never executed: absent failure codes alone
    // pass vacuously, so each mode must also report what it positively verified.
    const staticCodes = [
      "alert_runbook_missing",
      "runbook_structure_incomplete",
      "compose_publishing_not_disabled",
      "compose_media_retention_not_report_only",
      "config_publishing_default_not_disabled",
      "config_media_retention_default_not_report_only",
    ];
    const disabled = await validate({
      CREATOR_PUBLISHING_MODE: "disabled",
      acceptanceFile: missingAcceptance,
    });
    const enabled = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile: await writePacket(completePacket()),
    });

    for (const code of staticCodes) {
      expect(INCREMENT_THREE_FAILURE_CODES).toContain(code);
      expect(disabled.failures, code).not.toContain(code);
      expect(enabled.failures, code).not.toContain(code);
    }

    for (const result of [disabled, enabled]) {
      expect(result.evidence.runbooksVerified).toEqual(
        expect.arrayContaining([
          "ops/runbooks/creator-publication.md",
          "ops/runbooks/public-content-report-triage.md",
          "ops/runbooks/public-media-backup-restore.md",
          "ops/runbooks/public-media-processing.md",
        ]),
      );
      expect(result.evidence.incrementThreeRunbooksStructured).toEqual([
        "ops/runbooks/creator-publication.md",
        "ops/runbooks/public-content-report-triage.md",
        "ops/runbooks/public-media-backup-restore.md",
        "ops/runbooks/public-media-processing.md",
      ]);
      expect(result.evidence.composePublishingModes).toEqual(["disabled", "disabled"]);
      expect(result.evidence.composeMediaRetentionModes).toEqual(["report_only", "report_only"]);
      expect(result.evidence.configPublishingDefault).toBe("disabled");
      expect(result.evidence.configMediaRetentionDefault).toBe("report_only");
    }
  });

  test("requires the least-privilege storage grant and every policy row", async () => {
    // Catches a gate that skips the HeadBucket ListBucket review or the policy acceptances.
    const packet = completePacket();
    packet.objectStorage.leastPrivilegeIam = { accepted: false, reference: "" };
    packet.objectStorage.bucketsPrivate = { accepted: false, reference: "" };
    packet.policies.contentPolicy = { accepted: false, reference: "" };
    packet.policies.terms = { accepted: false, reference: "" };
    packet.policies.retentionDisclosure = { accepted: false, reference: "" };
    packet.policies.intellectualProperty = { accepted: false, reference: "" };

    const result = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile: await writePacket(packet),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "object_storage_iam_not_least_privilege",
        "object_storage_buckets_not_private",
        "content_policy_not_accepted",
        "terms_not_accepted",
        "retention_disclosure_not_accepted",
        "intellectual_property_policy_not_accepted",
      ]),
    );
  });

  test("treats an unreadable acceptance packet as malformed instead of accepted", async () => {
    // Catches a gate that swallows a truncated packet and reports a clean release.
    await writeFile(acceptanceFile, '{ "sourceRevision": ', "utf8");

    const result = await validate({
      CREATOR_PUBLISHING_MODE: "general_audience",
      acceptanceFile,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("acceptance_packet_malformed");
    expect(result.failures).not.toContain("acceptance_packet_missing");
  });

  test("exposes the gate as a command that reads only documented acceptance paths", async () => {
    // Catches a validator that hides its verdict from CI or accepts arbitrary caller paths.
    const disabled = await run([validatorPath], {
      ...process.env,
      CREATOR_PUBLISHING_MODE: "disabled",
      INCREMENT_THREE_ACCEPTANCE_FILE: missingAcceptance,
    });
    const enabled = await run([validatorPath], {
      ...process.env,
      CREATOR_PUBLISHING_MODE: "general_audience",
      INCREMENT_THREE_ACCEPTANCE_FILE: missingAcceptance,
    });
    const flagged = await run([validatorPath, "--acceptance", await writePacket(completePacket())], {
      ...process.env,
      CREATOR_PUBLISHING_MODE: "general_audience",
      INCREMENT_THREE_ACCEPTANCE_FILE: "",
    });
    const unknownArgument = await run([validatorPath, "compose.prod.yaml"], {
      ...process.env,
      CREATOR_PUBLISHING_MODE: "disabled",
    });

    expect(disabled.code, disabled.stderr).toBe(0);
    expect(enabled.code).toBe(1);
    expect(enabled.stderr).toContain("increment_two_not_accepted");
    expect(enabled.stderr).not.toContain(missingAcceptance);
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(unknownArgument.code).toBe(2);
  });
});
