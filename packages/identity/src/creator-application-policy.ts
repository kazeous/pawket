import * as ipaddr from "ipaddr.js";

const vietnamDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function creatorApplicationVietnamDate(now: Date): string {
  const values = Object.fromEntries(
    vietnamDateFormatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year!}-${values.month!}-${values.day!}`;
}

function dateParts(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new CreatorApplicationPolicyError("invalid_date_of_birth");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new CreatorApplicationPolicyError("invalid_date_of_birth");
  }
  return { year, month, day };
}

function vietnamMidnight(value: string): Date {
  const { year, month, day } = dateParts(value);
  return new Date(Date.UTC(year, month - 1, day, -7));
}

export class CreatorApplicationPolicyError extends Error {
  constructor(readonly reason: string) {
    super("Creator application does not meet policy");
  }
}

export function parseCreatorDateOfBirth(value: string, now: Date): { value: string; age: number } {
  const birth = dateParts(value);
  const today = creatorApplicationVietnamDate(now);
  if (value > today) throw new CreatorApplicationPolicyError("future_date_of_birth");
  const todayParts = dateParts(today);
  let age = todayParts.year - birth.year;
  if (
    todayParts.month < birth.month ||
    (todayParts.month === birth.month && todayParts.day < birth.day)
  ) {
    age -= 1;
  }
  return { value, age };
}

const specialUseDnsSuffixes = new Set([
  "alt",
  "arpa",
  "example",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
  "test",
]);

function canonicalPublicHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();
  const literal = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  if (ipaddr.isValid(literal)) {
    if (ipaddr.IPv4.isIPv4(literal)) {
      return ipaddr.IPv4.parse(literal).range() === "unicast" ? lower : null;
    }
    const parsed = ipaddr.IPv6.parse(literal);
    const address = parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
    return address.range() === "unicast" ? lower : null;
  }

  const canonical = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (!canonical || canonical.length > 253) return null;
  const labels = canonical.split(".");
  if (labels.length < 2 || specialUseDnsSuffixes.has(labels.at(-1)!)) return null;
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[a-z0-9-]+$/u.test(label),
    )
  ) {
    return null;
  }
  return canonical;
}

export function validateCreatorPortfolioUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new CreatorApplicationPolicyError("invalid_portfolio_urls");
  }
  return value.map((candidate) => {
    if (typeof candidate !== "string" || candidate.length > 2_048) {
      throw new CreatorApplicationPolicyError("invalid_portfolio_urls");
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new CreatorApplicationPolicyError("invalid_portfolio_urls");
    }
    const hostname = canonicalPublicHostname(parsed.hostname);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !hostname) {
      throw new CreatorApplicationPolicyError("invalid_portfolio_urls");
    }
    parsed.hostname = hostname;
    return parsed.toString();
  });
}

export function rejectionCooldownUntil(rejectedAt: Date): Date {
  const date = creatorApplicationVietnamDate(rejectedAt);
  const { year, month, day } = dateParts(date);
  const afterFourteenCalendarDays = new Date(Date.UTC(year, month - 1, day + 14));
  const target = `${afterFourteenCalendarDays.getUTCFullYear()}-${String(afterFourteenCalendarDays.getUTCMonth() + 1).padStart(2, "0")}-${String(afterFourteenCalendarDays.getUTCDate()).padStart(2, "0")}`;
  return vietnamMidnight(target);
}
