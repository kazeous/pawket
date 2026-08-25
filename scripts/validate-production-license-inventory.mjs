import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const unknownLicenseValues = new Set(["unknown", "noassertion"]);

function normalizeLicense(license) {
  if (typeof license === "string" && license.trim()) return license.trim();
  if (
    license &&
    typeof license === "object" &&
    "type" in license &&
    typeof license.type === "string" &&
    license.type.trim()
  ) {
    return license.type.trim();
  }
  return undefined;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateProductionLicenseMetadata(records) {
  return records.flatMap((record) => {
    const identifier = `${record.name}@${record.version}`;
    const license = normalizeLicense(record.license);
    if (!license) return `${identifier}: missing license metadata`;

    const normalized = license.toLowerCase();
    if (normalized === "unlicensed") return `${identifier}: explicitly unlicensed`;
    if (unknownLicenseValues.has(normalized)) return `${identifier}: unknown license metadata`;
    return [];
  });
}

function collectProductionLicenseMetadata(licenseGroups) {
  const records = [];
  const failures = [];

  if (!licenseGroups || typeof licenseGroups !== "object" || Array.isArray(licenseGroups)) {
    return { records, failures: ["license inventory: expected an object"] };
  }

  for (const [groupLicense, entries] of Object.entries(licenseGroups)) {
    if (!Array.isArray(entries)) {
      failures.push(`${groupLicense}: expected an array of package entries`);
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      const entryLabel = `${groupLicense}[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !isNonEmptyString(entry.name)) {
        failures.push(`${entryLabel}: expected an object with a non-empty name`);
        continue;
      }
      if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
        failures.push(`${entryLabel}: versions must be a non-empty array`);
        continue;
      }
      if (!isNonEmptyString(entry.license)) {
        failures.push(`${entryLabel}: expected a non-empty license`);
        continue;
      }
      const invalidVersionIndex = entry.versions.findIndex((version) => !isNonEmptyString(version));
      if (invalidVersionIndex >= 0) {
        failures.push(`${entryLabel}.versions[${invalidVersionIndex}]: expected a non-empty string`);
        continue;
      }
      for (const version of entry.versions) {
        records.push({
          name: entry.name,
          version,
          license: entry.license,
        });
      }
    }
  }
  return {
    records: records.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)),
    failures,
  };
}

export function validateProductionLicenseInventory(licenseGroups) {
  const collected = collectProductionLicenseMetadata(licenseGroups);
  const failures = [...collected.failures, ...validateProductionLicenseMetadata(collected.records)];
  if (collected.records.length === 0 && failures.length === 0) {
    failures.push("license inventory: contains no package records");
  }
  return { records: collected.records, failures };
}

function main() {
  let listedProjects;
  try {
    listedProjects = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error("Production license inventory validation requires pnpm licenses list JSON on stdin.");
    return 1;
  }

  const { records, failures } = validateProductionLicenseInventory(listedProjects);
  if (failures.length > 0) {
    console.error("Production license inventory validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }

  console.log("Production license inventory:");
  for (const record of records) console.log(`- ${record.name}@${record.version}: ${normalizeLicense(record.license)}`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
