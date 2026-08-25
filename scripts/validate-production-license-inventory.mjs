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

  for (const [groupLicense, entries] of Object.entries(licenseGroups)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
      const versions = Array.isArray(entry.versions) ? entry.versions : ["unknown"];
      for (const version of versions) {
        records.push({
          name: entry.name,
          version: typeof version === "string" ? version : "unknown",
          license: entry.license ?? groupLicense,
        });
      }
    }
  }
  return records.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

export function validateProductionLicenseInventory(licenseGroups) {
  const records = collectProductionLicenseMetadata(licenseGroups);
  return { records, failures: validateProductionLicenseMetadata(records) };
}

function main() {
  let listedProjects;
  try {
    listedProjects = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error("Production license inventory validation requires pnpm list JSON on stdin.");
    return 1;
  }

  if (!listedProjects || typeof listedProjects !== "object" || Array.isArray(listedProjects)) {
    console.error("Production license inventory validation expected pnpm license-group JSON.");
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
