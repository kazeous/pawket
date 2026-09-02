import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactRevision = /^[0-9a-f]{40}$/u;
const requiredRunbookHeadings = [
  "Detection",
  "Safe evidence to collect",
  "Disabled-mode behavior",
  "Retry and recovery",
  "Rollback",
  "Escalation",
  "Forbidden actions",
];
const incrementThreeRunbooks = [
  "ops/runbooks/creator-publication.md",
  "ops/runbooks/public-content-report-triage.md",
  "ops/runbooks/public-media-backup-restore.md",
  "ops/runbooks/public-media-processing.md",
];

export const INCREMENT_THREE_FAILURE_CODES = Object.freeze([
  "acceptance_packet_malformed",
  "acceptance_packet_missing",
  "alert_runbook_missing",
  "compose_media_retention_not_report_only",
  "compose_publishing_not_disabled",
  "config_media_retention_default_not_report_only",
  "config_publishing_default_not_disabled",
  "content_policy_not_accepted",
  "creator_onboarding_not_authorized",
  "increment_two_not_accepted",
  "ingress_direct_port_not_isolated",
  "ingress_real_ip_not_overwritten",
  "intellectual_property_policy_not_accepted",
  "media_retention_not_report_only",
  "object_storage_buckets_not_private",
  "object_storage_cors_not_exact_origin",
  "object_storage_iam_not_least_privilege",
  "object_storage_restore_not_accepted",
  "object_storage_versioning_not_enabled",
  "privacy_notice_not_accepted",
  "publishing_mode_invalid",
  "report_operator_not_accepted",
  "report_triage_rehearsal_not_accepted",
  "retention_disclosure_not_accepted",
  "retention_global_pause_bypassed",
  "runbook_structure_incomplete",
  "source_revision_mismatch",
  "synthetic_journey_not_recorded",
  "terms_not_accepted",
]);

const failureCodeSet = new Set(INCREMENT_THREE_FAILURE_CODES);

function addFailure(failures, code) {
  if (!failureCodeSet.has(code)) throw new Error("Unknown Increment 3 failure code");
  failures.add(code);
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function accepted(value) {
  if (!isPlainRecord(value) || value.accepted !== true) return false;
  if (typeof value.reference !== "string") return false;
  const reference = value.reference.trim();
  return reference.length > 0 && reference.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(reference);
}

function nested(record, ...path) {
  let value = record;
  for (const key of path) {
    if (!isPlainRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

async function readText(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch {
    return null;
  }
}

async function readAcceptancePacket(path) {
  if (typeof path !== "string" || path.trim() === "") {
    return { status: "missing", packet: {} };
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isPlainRecord(value)
      ? { status: "loaded", packet: value }
      : { status: "malformed", packet: {} };
  } catch (error) {
    return error && typeof error === "object" && error.code === "ENOENT"
      ? { status: "missing", packet: {} }
      : { status: "malformed", packet: {} };
  }
}

function extractValues(source, name) {
  if (source === null) return [];
  const expression = new RegExp("^\\s+" + name + ":\\s*([^#\\s]+)\\s*$", "gmu");
  return [...source.matchAll(expression)].map((match) => match[1].replace(/^["']|["']$/gu, ""));
}

async function verifyStaticRepositoryContracts(failures) {
  const [alerts, compose, config] = await Promise.all([
    readText("ops/alerts/pawket.rules.yml"),
    readText("compose.prod.yaml"),
    readText("packages/config/src/increment-three.ts"),
  ]);

  const referencedRunbooks =
    alerts === null
      ? []
      : [...alerts.matchAll(/^\s+runbook:\s+(ops\/runbooks\/[a-z0-9-]+[.]md)\s*$/gmu)].map(
          (match) => match[1],
        );
  const uniqueRunbooks = [...new Set(referencedRunbooks)].sort();
  const runbookSources = new Map(
    await Promise.all(
      uniqueRunbooks.map(async (path) => [path, await readText(path)]),
    ),
  );
  const runbooksVerified = uniqueRunbooks.filter((path) => runbookSources.get(path) !== null);
  if (
    alerts === null ||
    runbooksVerified.length !== uniqueRunbooks.length ||
    !incrementThreeRunbooks.every((path) => referencedRunbooks.includes(path))
  ) {
    addFailure(failures, "alert_runbook_missing");
  }

  const incrementThreeRunbooksStructured = [];
  for (const path of incrementThreeRunbooks) {
    const source = runbookSources.has(path) ? runbookSources.get(path) : await readText(path);
    const complete =
      source !== null &&
      requiredRunbookHeadings.every((heading) =>
        new RegExp("^## " + heading + "$", "mu").test(source),
      );
    if (complete) incrementThreeRunbooksStructured.push(path);
  }
  if (incrementThreeRunbooksStructured.length !== incrementThreeRunbooks.length) {
    addFailure(failures, "runbook_structure_incomplete");
  }

  const composePublishingModes = extractValues(compose, "CREATOR_PUBLISHING_MODE");
  const composeMediaRetentionModes = extractValues(compose, "PUBLIC_MEDIA_RETENTION_MODE");
  if (
    composePublishingModes.length !== 2 ||
    composePublishingModes.some((value) => value !== "disabled")
  ) {
    addFailure(failures, "compose_publishing_not_disabled");
  }
  if (
    composeMediaRetentionModes.length !== 2 ||
    composeMediaRetentionModes.some((value) => value !== "report_only")
  ) {
    addFailure(failures, "compose_media_retention_not_report_only");
  }

  const configPublishingDefault =
    config?.match(
      /CREATOR_PUBLISHING_MODE:\s*z[.]enum\([^\r\n]+\)[.]default[(]"([^"]+)"[)]/u,
    )?.[1] ?? null;
  const configMediaRetentionDefault =
    config?.match(
      /PUBLIC_MEDIA_RETENTION_MODE:\s*z[.]enum\([^\r\n]+\)[.]default[(]"([^"]+)"[)]/u,
    )?.[1] ?? null;
  if (configPublishingDefault !== "disabled") {
    addFailure(failures, "config_publishing_default_not_disabled");
  }
  if (configMediaRetentionDefault !== "report_only") {
    addFailure(failures, "config_media_retention_default_not_report_only");
  }

  return {
    runbooksVerified,
    incrementThreeRunbooksStructured,
    composePublishingModes,
    composeMediaRetentionModes,
    configPublishingDefault,
    configMediaRetentionDefault,
  };
}

function requireAcceptance(packet, failures, path, code) {
  if (!accepted(nested(packet, ...path))) addFailure(failures, code);
}

function verifyActivationPacket(packet, failures) {
  if (
    !exactRevision.test(packet.sourceRevision ?? "") ||
    !exactRevision.test(packet.buildRevision ?? "") ||
    packet.sourceRevision !== packet.buildRevision
  ) {
    addFailure(failures, "source_revision_mismatch");
  }

  const rows = [
    [["incrementTwo"], "increment_two_not_accepted"],
    [["creatorOnboarding"], "creator_onboarding_not_authorized"],
    [["objectStorage", "leastPrivilegeIam"], "object_storage_iam_not_least_privilege"],
    [["objectStorage", "bucketsPrivate"], "object_storage_buckets_not_private"],
    [["objectStorage", "versioningEnabled"], "object_storage_versioning_not_enabled"],
    [["objectStorage", "exactOriginCors"], "object_storage_cors_not_exact_origin"],
    [["ingress", "realIpOverwritten"], "ingress_real_ip_not_overwritten"],
    [["ingress", "directPortIsolated"], "ingress_direct_port_not_isolated"],
    [["backupRestore"], "object_storage_restore_not_accepted"],
    [["policies", "contentPolicy"], "content_policy_not_accepted"],
    [["policies", "privacyNotice"], "privacy_notice_not_accepted"],
    [["policies", "terms"], "terms_not_accepted"],
    [["policies", "retentionDisclosure"], "retention_disclosure_not_accepted"],
    [["policies", "intellectualProperty"], "intellectual_property_policy_not_accepted"],
    [["reportOperator"], "report_operator_not_accepted"],
    [["reportTriageRehearsal"], "report_triage_rehearsal_not_accepted"],
    [["syntheticJourney"], "synthetic_journey_not_recorded"],
  ];
  for (const [path, code] of rows) requireAcceptance(packet, failures, path, code);
}

export async function validate(input = {}) {
  const failures = new Set();
  const evidence = await verifyStaticRepositoryContracts(failures);
  const mode = input.CREATOR_PUBLISHING_MODE ?? "disabled";
  const publicMediaRetentionMode = input.PUBLIC_MEDIA_RETENTION_MODE ?? "report_only";
  let acceptance = { status: "missing", packet: {} };

  if (mode !== "disabled" && mode !== "general_audience") {
    addFailure(failures, "publishing_mode_invalid");
  } else if (mode === "general_audience") {
    acceptance = await readAcceptancePacket(input.acceptanceFile);
    if (acceptance.status === "missing") addFailure(failures, "acceptance_packet_missing");
    if (acceptance.status === "malformed") addFailure(failures, "acceptance_packet_malformed");
    verifyActivationPacket(acceptance.packet, failures);
  }

  if (publicMediaRetentionMode !== "report_only") {
    if (acceptance.status === "missing" && typeof input.acceptanceFile === "string") {
      acceptance = await readAcceptancePacket(input.acceptanceFile);
    }
    const retentionAccepted = accepted(
      nested(acceptance.packet, "mediaRetentionActivation"),
    );
    if (publicMediaRetentionMode !== "enforce" || !retentionAccepted) {
      addFailure(failures, "media_retention_not_report_only");
    }
    const globalRetentionEnabled =
      input.RETENTION_MODE === "enforce" &&
      (input.RETENTION_ENFORCEMENT_PAUSED === false ||
        input.RETENTION_ENFORCEMENT_PAUSED === "false");
    if (retentionAccepted && !globalRetentionEnabled) {
      addFailure(failures, "retention_global_pause_bypassed");
    }
  }

  const orderedFailures = INCREMENT_THREE_FAILURE_CODES.filter((code) => failures.has(code));
  return {
    ok: orderedFailures.length === 0,
    mode,
    failures: orderedFailures,
    evidence,
  };
}

function parseArguments(argv) {
  if (argv.length === 0) return { ok: true, acceptanceFile: process.env.INCREMENT_THREE_ACCEPTANCE_FILE };
  if (argv.length === 2 && argv[0] === "--acceptance" && argv[1].trim() !== "") {
    return { ok: true, acceptanceFile: argv[1] };
  }
  return { ok: false };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error("Usage: validate-increment-three-release.mjs [--acceptance <path>]");
    process.exitCode = 2;
    return;
  }
  const result = await validate({ ...process.env, acceptanceFile: parsed.acceptanceFile });
  if (result.ok) console.log(JSON.stringify(result));
  else console.error("Increment 3 release gate failed: " + result.failures.join(","));
  process.exitCode = result.ok ? 0 : 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
