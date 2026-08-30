import { types as nodeTypes } from "node:util";

export function readExactOwnRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor | undefined>;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function readExactNativeArray(value: unknown): readonly unknown[] | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || !Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor | undefined>;
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable !== false ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      ownKeys.length !== length + 1 ||
      ownKeys.some((key) => typeof key !== "string") ||
      !ownKeys.includes("length")
    ) return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function readPlainDataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}
