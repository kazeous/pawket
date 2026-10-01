const CONTROL = /[\u0000-\u001f\u007f]/u;

export function isValidS3Endpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function isValidS3Bucket(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 63 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value);
}

export function isBoundedS3Text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
}
