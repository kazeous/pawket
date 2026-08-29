import {
  CatalogPolicyError,
  normalizeExternalDestination,
  normalizeHandle,
  normalizeProfileText,
} from "../src/index.js";

import { expect, test } from "vitest";

test.each(["abc", "artist-9", "a1b"])("accepts canonical handle %s", (value) => {
  expect(normalizeHandle(value)).toBe(value);
});

test.each(["ab", "-artist", "artist-", "artist--one", "_next", "Admin", "ảnh"])(
  "rejects handle %s",
  (value) => {
    expect(() => normalizeHandle(value)).toThrow(CatalogPolicyError);
  },
);

test("normalizes Unicode public text without changing internal whitespace", () => {
  // Break caught: storing non-canonical Unicode or collapsing the creator's intended spacing.
  expect(normalizeProfileText("Cafe\u0301  atelier", { minCodePoints: 1, maxCodePoints: 80 })).toBe(
    "Café  atelier",
  );
});

test.each(["safe\u0000text", "safe\u202Etext", "<strong>text</strong>", "", "abcde"])(
  "rejects unsafe or out-of-bounds public text %j",
  (value) => {
    // Break caught: a public profile accepting control, bidi, markup, or over-bound text.
    expect(() => normalizeProfileText(value, { minCodePoints: 1, maxCodePoints: 4 })).toThrow(
      CatalogPolicyError,
    );
  },
);

test("normalizes a credential-free HTTPS external destination", () => {
  // Break caught: persisting a non-canonical external URL.
  expect(normalizeExternalDestination("HTTPS://EXAMPLE.COM:443/portfolio?tag=art")).toBe(
    "https://example.com/portfolio?tag=art",
  );
});

test.each([
  "http://example.com/portfolio",
  "https://artist:secret@example.com/portfolio",
  "#portfolio",
])("rejects non-external destination %s", (value) => {
  // Break caught: accepting insecure, credential-bearing, or fragment-only destinations.
  expect(() => normalizeExternalDestination(value)).toThrow(CatalogPolicyError);
});
