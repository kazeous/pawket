import { describe, expect, test } from "vitest";

import * as identity from "../src/index.js";

type CreatorPolicy = {
  parseCreatorDateOfBirth(value: string, now: Date): { value: string; age: number };
  validateCreatorPortfolioUrls(value: unknown): string[];
  rejectionCooldownUntil(rejectedAt: Date): Date;
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
    expect(validate(["https://portfolio.example/art", "https://social.example/@artist"])).toEqual([
      "https://portfolio.example/art",
      "https://social.example/@artist",
    ]);
    expect(() => validate([])).toThrow();
    expect(() => validate(["http://portfolio.example/art"])).toThrow();
    expect(() => validate(["https://127.0.0.1/private"])).toThrow();
    expect(() => validate(Array.from({ length: 6 }, (_, index) => `https://portfolio.example/${index}`))).toThrow();
  });

  test("sets the rejection cooldown to the exact fourteenth following calendar day", () => {
    // Break caught: using a 14x24-hour duration instead of the legal local-calendar boundary.
    expect(typeof creatorPolicy.rejectionCooldownUntil).toBe("function");
    expect(creatorPolicy.rejectionCooldownUntil!(new Date("2026-03-01T16:30:00.000Z"))).toEqual(
      new Date("2026-03-14T17:00:00.000Z"),
    );
  });
});
