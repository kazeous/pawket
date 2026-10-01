import { types as nodeTypes } from "node:util";

import { readPlainDataRecord } from "./runtime-boundary.js";

/** True only for a structurally plain provider error that names a missing key, version or bucket. */
export function isProviderNotFound(error: unknown): boolean {
  const visited = new Set<object>();
  let candidate: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!candidate || typeof candidate !== "object" || nodeTypes.isProxy(candidate) || visited.has(candidate)) return false;
    visited.add(candidate);
    if (!hasSafeProviderErrorShape(candidate)) return false;

    const name = readOwnDataValue(candidate, "name");
    if (name.kind === "accessor") return false;
    const metadata = readOwnDataValue(candidate, "$metadata");
    if (metadata.kind === "accessor") return false;
    if (
      name.kind === "data" &&
      (name.value === "NotFound" || name.value === "NoSuchKey" || name.value === "NoSuchVersion")
    ) return true;
    if (metadata.kind === "data" && hasSafeNotFoundStatus(metadata.value)) return true;

    const cause = readOwnDataValue(candidate, "cause");
    if (cause.kind === "accessor" || cause.kind === "missing") return false;
    candidate = cause.value;
  }
  return false;
}

/** True only for a structurally plain provider error that reports a failed create-only precondition. */
export function isProviderCreateOnlyConflict(error: unknown): boolean {
  const visited = new Set<object>();
  let candidate: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!candidate || typeof candidate !== "object" || nodeTypes.isProxy(candidate) || visited.has(candidate)) return false;
    visited.add(candidate);
    if (!hasSafeProviderErrorShape(candidate)) return false;

    const name = readOwnDataValue(candidate, "name");
    if (name.kind === "accessor") return false;
    const metadata = readOwnDataValue(candidate, "$metadata");
    if (metadata.kind === "accessor") return false;
    if (
      name.kind === "data" &&
      (name.value === "PreconditionFailed" || name.value === "ConditionalRequestConflict")
    ) return true;
    if (metadata.kind === "data") {
      const safeMetadata = readPlainDataRecord(metadata.value);
      if (safeMetadata?.httpStatusCode === 412 || safeMetadata?.httpStatusCode === 409) return true;
    }

    const cause = readOwnDataValue(candidate, "cause");
    if (cause.kind === "accessor" || cause.kind === "missing") return false;
    candidate = cause.value;
  }
  return false;
}

function hasSafeProviderErrorShape(value: object): boolean {
  let current: object | null = value;
  let allowsNativeStackAccessor = false;
  let recognizedPrototype = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (nodeTypes.isProxy(current)) return false;
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(current);
    } catch {
      return false;
    }
    if (prototype === Object.prototype) {
      recognizedPrototype = true;
      break;
    }
    if (prototype === Error.prototype) {
      allowsNativeStackAccessor = true;
      recognizedPrototype = true;
      break;
    }
    if (prototype === null || nodeTypes.isProxy(prototype)) return false;
    current = prototype;
  }
  if (!recognizedPrototype) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor) return false;
      if (!("value" in descriptor) && !(allowsNativeStackAccessor && key === "stack" && descriptor.enumerable === false)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

type OwnDataValue =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "accessor" }>
  | Readonly<{ kind: "data"; value: unknown }>;

function readOwnDataValue(value: object, key: string): OwnDataValue {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { kind: "missing" };
    if (!("value" in descriptor)) return { kind: "accessor" };
    return { kind: "data", value: descriptor.value };
  } catch {
    return { kind: "accessor" };
  }
}

function hasSafeNotFoundStatus(value: unknown): boolean {
  const metadata = readPlainDataRecord(value);
  return metadata?.httpStatusCode === 404;
}
