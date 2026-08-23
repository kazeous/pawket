import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "exclude_from_hc: true";
const SENSITIVE_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "VALKEY_URL",
  "METRICS_TOKEN",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
];

function splitLinesPreservingEndings(source) {
  const lines = [];
  const matcher = /[^\r\n]*(?:\r\n|\n|\r|$)/g;

  for (const match of source.matchAll(matcher)) {
    if (match[0] === "") {
      break;
    }

    lines.push({
      content: match[0].replace(/(?:\r\n|\n|\r)$/, ""),
      raw: match[0],
    });
  }

  return lines;
}

function indentationWidth(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function serviceKeyIndent(lines, serviceStart, serviceIndent) {
  let minimum;

  for (let index = serviceStart + 1; index < lines.length; index += 1) {
    const content = lines[index].content;
    if (content.trim() === "" || content.trimStart().startsWith("#")) {
      continue;
    }

    const indent = indentationWidth(content);
    if (indent <= serviceIndent) {
      break;
    }

    minimum = minimum === undefined ? indent : Math.min(minimum, indent);
  }

  return minimum;
}

export function projectCoolifyCompose(source) {
  const lines = splitLinesPreservingEndings(source);
  const markers = [];
  let inServices = false;
  let serviceIndent;
  let currentService;
  let currentServiceStart;

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].content;
    const trimmed = content.trim();
    const indent = indentationWidth(content);

    if (trimmed !== "" && !content.trimStart().startsWith("#")) {
      if (indent === 0) {
        inServices = trimmed === "services:";
        serviceIndent = undefined;
        currentService = undefined;
        currentServiceStart = undefined;
      } else if (inServices) {
        const serviceMatch = content.match(/^ +(\w[\w.-]*):\s*$/);
        if (serviceMatch && (serviceIndent === undefined || indent === serviceIndent)) {
          serviceIndent ??= indent;
          if (indent === serviceIndent) {
            currentService = serviceMatch[1];
            currentServiceStart = index;
          }
        }
      }
    }

    if (trimmed === MARKER) {
      markers.push({
        index,
        indent,
        service: inServices ? currentService : undefined,
        serviceIndent,
        serviceStart: currentServiceStart,
      });
    }
  }

  if (markers.length !== 1) {
    throw new Error(
      `Coolify Compose validation requires exactly one ${MARKER} marker; found ${markers.length}`,
    );
  }

  const marker = markers[0];
  if (marker.service !== "migrate") {
    throw new Error(`Coolify Compose ${MARKER} marker must belong to the migrate service`);
  }

  const expectedIndent = serviceKeyIndent(lines, marker.serviceStart, marker.serviceIndent);
  if (marker.indent !== expectedIndent) {
    throw new Error(`Coolify Compose ${MARKER} marker must be a service-level key`);
  }

  return lines
    .filter((_, index) => index !== marker.index)
    .map((line) => line.raw)
    .join("");
}

function redactSensitiveValues(message, environment) {
  let redacted = message;

  for (const name of SENSITIVE_ENVIRONMENT_VARIABLES) {
    const value = environment[name];
    if (value) {
      redacted = redacted.replaceAll(value, `[REDACTED ${name}]`);
    }
  }

  return redacted;
}

export function validateCoolifyCompose({ environment = process.env } = {}) {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const composePath = path.join(repositoryRoot, "compose.prod.yaml");
  let source;

  try {
    source = readFileSync(composePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown file error";
    console.error(`Coolify Compose validation could not read compose.prod.yaml: ${reason}`);
    return 1;
  }

  let projected;
  try {
    projected = projectCoolifyCompose(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown marker error";
    console.error(reason);
    return 1;
  }

  const result = spawnSync("docker", ["compose", "-f", "-", "config", "--quiet"], {
    encoding: "utf8",
    env: environment,
    input: projected,
    windowsHide: true,
  });

  if (result.error) {
    console.error(`Coolify Compose validation could not run Docker Compose: ${result.error.message}`);
    return 1;
  }

  if (result.status !== 0) {
    console.error(`Coolify Compose validation failed with exit code ${result.status ?? 1}.`);
    const details = redactSensitiveValues(result.stderr, environment).trim();
    if (details) {
      console.error(details);
    }
    return result.status ?? 1;
  }

  console.log("Coolify Compose validation passed.");
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = validateCoolifyCompose();
}
