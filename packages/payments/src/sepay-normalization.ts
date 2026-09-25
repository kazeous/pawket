/** Numbers from provider JSON retain their original decimal spelling (Node 24). */
class ExactJsonNumber {
  constructor(readonly source: string) {}
}

export class SePayFormatError extends Error {
  constructor() { super("invalid_provider_schema"); this.name = "SePayFormatError"; }
}

export function parseSePayJson(text: string): unknown {
  // JSON.parse normally accepts duplicate object keys. Reject that ambiguity,
  // including escaped key aliases, before using its lossless number reviver.
  const levels: Array<Set<string> | null> = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      levels.push(token === "{" ? new Set() : null);
      if (levels.length > 16) throw new SePayFormatError();
    } else if (token === "}" || token === "]") {
      levels.pop();
    } else if (/^\s*:/.test(text.slice(match.index + token.length))) {
      const keys = levels.at(-1);
      if (!keys) throw new SePayFormatError();
      const key: unknown = JSON.parse(token);
      if (typeof key !== "string" || keys.has(key)) throw new SePayFormatError();
      keys.add(key);
    }
  }
  try {
    const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown) => unknown;
    return parse(text, (_key, value, context) => {
      if (typeof value !== "number") return value;
      if (!context?.source) throw new SePayFormatError();
      return new ExactJsonNumber(context.source);
    });
  } catch { throw new SePayFormatError(); }
}

export function sepayRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof ExactJsonNumber) throw new SePayFormatError();
  return value as Record<string, unknown>;
}

export function sepayText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.length) || /[\u0000-\u001f\u007f]/.test(value)) throw new SePayFormatError();
  return value;
}

export function sepayNullableText(value: unknown, maximum: number): string | null {
  if (value === null || value === "") return null;
  return sepayText(value, maximum);
}

/** OAuth numeric IDs must never be coerced through IEEE-754 or API v2 UUIDs. */
export function normalizeSePayId(value: unknown, allowZero = false): string {
  const source = value instanceof ExactJsonNumber ? value.source : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof source !== "string" || !/^(0|[1-9][0-9]{0,31})$/.test(source) || (!allowZero && source === "0")) throw new SePayFormatError();
  return source;
}

/** Accept decimal VND only if its exact decimal value is integral; never round. */
export function normalizeSePayVnd(value: unknown, allowZero = false): number {
  const source = value instanceof ExactJsonNumber ? value.source : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof source !== "string" || !/^(0|[1-9][0-9]{0,15})(?:\.0{1,18})?$/.test(source)) throw new SePayFormatError();
  const integer = BigInt(source.split(".")[0]!);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || (!allowZero && integer === 0n)) throw new SePayFormatError();
  return Number(integer);
}

/** Documented bank timestamp is a wall-clock time at Vietnam's fixed UTC+7. */
export function parseSePayVietnamTime(value: unknown): Date {
  const text = sepayText(value, 19);
  if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(text)) throw new SePayFormatError();
  const timestamp = new Date(`${text.replace(" ", "T")}+07:00`);
  if (!Number.isFinite(timestamp.getTime()) || new Date(timestamp.getTime() + 7 * 3_600_000).toISOString().slice(0, 19).replace("T", " ") !== text) throw new SePayFormatError();
  return timestamp;
}

export type SePayReference = Readonly<{
  reference: string | null;
  referenceStatus: "exact" | "missing" | "ambiguous" | "conflicting";
  isPawket: boolean;
}>;

/** Full tokens only: embedded, truncated, lower-case or repeated codes never match. */
export function normalizeSePayReference(code: unknown, content: unknown): SePayReference {
  const codeText = code === null ? null : sepayText(code, 128, true);
  const contentText = sepayText(content, 4_096, true);
  const references = [...contentText.matchAll(/(?<![A-Za-z0-9])PW[0-9A-F]{20}(?![A-Za-z0-9])/g)].map((match) => match[0]);
  const codeIsPawket = codeText !== null && /^PW[0-9A-F]{20}$/.test(codeText);
  const isPawket = codeIsPawket || references.length > 0 || Boolean(codeText?.startsWith("PW"));
  if (references.length > 1) return { reference: null, referenceStatus: "ambiguous", isPawket };
  const reference = references[0] ?? null;
  if (!reference) return { reference: codeIsPawket ? codeText : null, referenceStatus: "missing", isPawket };
  if (codeText !== null && codeText !== "" && codeText !== reference) return { reference, referenceStatus: "conflicting", isPawket };
  return { reference, referenceStatus: "exact", isPawket };
}
