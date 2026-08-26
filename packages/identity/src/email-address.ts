import { domainToASCII } from "node:url";

export function canonicalizeEmailAddress(email: string): {
  display: string;
  canonical: string;
} {
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254 || /[\u0000-\u0020\u007f]/u.test(trimmed)) {
    throw new Error("Invalid email address");
  }

  const separator = trimmed.lastIndexOf("@");
  if (separator < 1 || separator !== trimmed.indexOf("@")) {
    throw new Error("Invalid email address");
  }

  const local = trimmed.slice(0, separator);
  const rawDomain = trimmed.slice(separator + 1);
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (
    local.length > 64 ||
    !domain ||
    domain.length > 253 ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new Error("Invalid email address");
  }

  const display = `${local}@${domain}`;
  return { display, canonical: display.toLocaleLowerCase("en-US") };
}
