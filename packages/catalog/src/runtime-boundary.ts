import { types as nodeTypes } from "node:util";

const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const mapKeys = Map.prototype.keys;
const mapGet = Map.prototype.get;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const setValues = Set.prototype.values;

export function readExactOwnRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function readExactNativeMap(value: unknown, expectedKeys: readonly string[]): Map<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || !mapSize) return null;
  try {
    if (Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length !== 0) return null;
    const expected = new Set(expectedKeys);
    const size = Reflect.apply(mapSize, value, []) as number;
    if (size !== expected.size) return null;
    const keys = [...(Reflect.apply(mapKeys, value, []) as IterableIterator<unknown>)];
    if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) return null;
    const result = new Map<string, unknown>();
    for (const key of expected) result.set(key, Reflect.apply(mapGet, value, [key]));
    return result;
  } catch {
    return null;
  }
}

export function readExactNativeStringSet(value: unknown): Set<string> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || !setSize) return null;
  try {
    if (Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) return null;
    const size = Reflect.apply(setSize, value, []) as number;
    const values = [...(Reflect.apply(setValues, value, []) as IterableIterator<unknown>)];
    if (values.length !== size || values.some((item) => typeof item !== "string")) return null;
    return new Set(values as string[]);
  } catch {
    return null;
  }
}
