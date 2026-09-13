import { describe, expect, test } from "vitest";
import { normalizeTipGuestContent } from "../src/guest-content.js";

describe("bounded private plain-text tip content", () => {
  test("canonicalizes Vietnamese Unicode and whitespace without stripping message line breaks", () => {
    expect(normalizeTipGuestContent({ name: "  Nguyê\u0303n\t An ", message: "  Cảm ơn\r\n🎨  " })).toEqual({ name: "Nguyễn An", message: "Cảm ơn\n🎨" });
    expect(normalizeTipGuestContent({ name: "\t ", message: null })).toEqual({ name: null, message: null });
    expect(normalizeTipGuestContent({})).toEqual({ name: null, message: null });
  });
  test("bounds Unicode scalars and permits exactly the maximum, including astral characters", () => {
    expect(normalizeTipGuestContent({ name: "🎨".repeat(80), message: "🎨".repeat(280) }).message).toHaveLength(560);
    for (const input of [{ name: "🎨".repeat(81) }, { message: "🎨".repeat(281) }]) expect(() => normalizeTipGuestContent(input)).toThrow("invalid_guest_content");
  });
  test.each(["\ud800", "\udfff", "a\u0000b", "a\u001bb", "a\u0085b", 100, {}, []])("rejects non-text and invalid Unicode without echoing content (%#)", (message) => {
    expect(() => normalizeTipGuestContent({ message })).toThrow("invalid_guest_content");
  });
  test("retains plain text literally; display adapters must escape it and never interpret HTML", () => {
    expect(normalizeTipGuestContent({ message: "<b>Thank you</b>" }).message).toBe("<b>Thank you</b>");
  });
});
