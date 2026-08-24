import { describe, expect, test } from "vitest";

import * as identity from "../src/index.js";

type CreatorPolicy = {
  parseCreatorDateOfBirth(value: string, now: Date): { value: string; age: number };
  validateCreatorPortfolioUrls(value: unknown): string[];
  rejectionCooldownUntil(rejectedAt: Date): Date;
  createCanonicalCreatorReceivingAccountReferenceValidator(): {
    isValidForApplicant(input: { applicantUserId: string; reference: string }): Promise<boolean>;
  };
};

const creatorPolicy = identity as unknown as Partial<CreatorPolicy>;

describe("creator application policy", () => {
  test("rejects invalid and future dates while accepting the leap-day eighteenth birthday in Ho Chi Minh time", () => {
    // Break caught: replacing real calendar validation with Date parsing or UTC age arithmetic.
    expect(typeof creatorPolicy.parseCreatorDateOfBirth).toBe("function");
    const parse = creatorPolicy.parseCreatorDateOfBirth!;
    expect(parse("2008-02-29", new Date("2026-02-28T17:00:00.000Z"))).toEqual({
      value: "2008-02-29",
      age: 18,
    });
    expect(parse("2008-02-29", new Date("2026-02-28T16:59:59.999Z"))).toEqual({
      value: "2008-02-29",
      age: 17,
    });
    expect(() => parse("2026-02-30", new Date("2026-08-24T00:00:00.000Z"))).toThrow();
    expect(() => parse("2026-08-25", new Date("2026-08-24T00:00:00.000Z"))).toThrow();
  });

  test("accepts one through five public HTTPS portfolio URLs and rejects private or malformed sets", () => {
    // Break caught: accepting non-HTTPS/private URLs or an unbounded portfolio list.
    expect(typeof creatorPolicy.validateCreatorPortfolioUrls).toBe("function");
    const validate = creatorPolicy.validateCreatorPortfolioUrls!;
    expect(validate(["https://portfolio.example.com/art"])).toEqual([
      "https://portfolio.example.com/art",
    ]);
    expect(
      validate(Array.from({ length: 5 }, (_, index) => `https://portfolio.example.com/${index}`)),
    ).toHaveLength(5);
    expect(() => validate([])).toThrow();
    expect(() => validate(["http://portfolio.example.com/art"])).toThrow();
    expect(() => validate(["https://artist:secret@portfolio.example.com/art"])).toThrow();
    expect(() => validate(["https://127.0.0.1/private"])).toThrow();
    expect(() =>
      validate(Array.from({ length: 6 }, (_, index) => `https://portfolio.example.com/${index}`)),
    ).toThrow();
  });

  test("rejects local, single-label, reserved, and special-use DNS names lexically", () => {
    // Break caught: a non-public hostname bypassing lexical policy through a trailing dot or reserved suffix.
    const validate = creatorPolicy.validateCreatorPortfolioUrls!;
    for (const hostname of [
      "localhost.",
      "intranet",
      "artist.localhost",
      "artist.local",
      "artist.test",
      "artist.invalid",
      "artist.example",
      "printer.home.arpa",
      "service.internal",
      "hidden.onion",
      "resolver.alt",
    ]) {
      expect(() => validate([`https://${hostname}/portfolio`]), hostname).toThrow();
    }
    expect(validate(["https://PORTFOLIO.Example.COM./Art"])).toEqual([
      "https://portfolio.example.com/Art",
    ]);
  });

  test("rejects non-public IPv6 literals while allowing a global public IPv6 literal", () => {
    // Break caught: treating a bracketed IPv6 literal as an ordinary DNS hostname and allowing a private network target.
    expect(typeof creatorPolicy.validateCreatorPortfolioUrls).toBe("function");
    const validate = creatorPolicy.validateCreatorPortfolioUrls!;
    for (const host of [
      "fd12:3456:789a::1",
      "fe80::1",
      "::1",
      "ff02::1",
      "::",
      "2001:db8::1",
      "::ffff:192.168.1.20",
    ]) {
      expect(() => validate([`https://[${host}]/portfolio`])).toThrow();
    }
    expect(validate(["https://[2606:4700:4700::1111]/portfolio"])).toEqual([
      "https://[2606:4700:4700::1111]/portfolio",
    ]);
  });

  test("sets the rejection cooldown to the exact fourteenth following calendar day", () => {
    // Break caught: using a 14x24-hour duration instead of the legal local-calendar boundary.
    expect(typeof creatorPolicy.rejectionCooldownUntil).toBe("function");
    expect(creatorPolicy.rejectionCooldownUntil!(new Date("2026-03-01T16:30:00.000Z"))).toEqual(
      new Date("2026-03-14T17:00:00.000Z"),
    );
  });

  test("temporary receiving-account adapter accepts only canonical UUID-shaped opaque references", async () => {
    // Break caught: treating a raw VND account number or account-like free text as a Payments-owned ID.
    expect(typeof creatorPolicy.createCanonicalCreatorReceivingAccountReferenceValidator).toBe(
      "function",
    );
    const adapter =
      creatorPolicy.createCanonicalCreatorReceivingAccountReferenceValidator!();
    for (const reference of [
      "0123456789",
      "bank-account-0123456789",
      "2F485FA2-63D7-4F45-945D-E7E268B25B65",
      "2f485fa2-63d7-4f45-045d-e7e268b25b65",
    ]) {
      await expect(
        adapter.isValidForApplicant({ applicantUserId: "artist-1", reference }),
      ).resolves.toBe(false);
    }
    await expect(
      adapter.isValidForApplicant({
        applicantUserId: "artist-1",
        reference: "2f485fa2-63d7-4f45-945d-e7e268b25b65",
      }),
    ).resolves.toBe(true);
  });
});
