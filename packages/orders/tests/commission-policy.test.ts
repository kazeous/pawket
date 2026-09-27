import { describe, expect, test } from "vitest";
import {
  COMMISSION_POLICY, CommissionError, commissionDueAt, commissionPaymentExpiry,
  commissionQuoteExpiry, normalizeCommissionBrief, normalizeCommissionTerms,
  requireCommissionBeforeDeadline, requireCommissionTransition,
} from "../src/index.js";

const terms = {
  amountVnd: 500_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
  scope: "One portrait", deliverables: "PNG at 2000px", usageRights: "Personal use",
  artistTerms: "The accepted scope remains fixed.", policyRevisionId: "00000000-0000-4000-8000-000000000006",
};
const at = new Date("2026-09-25T00:00:00Z");

describe("commission commitment policy", () => {
  test.each([49_999, 50_000_001, 500_000.5, NaN, Infinity, "500000", 0])("rejects invalid VND %s without coercion", (amountVnd) => {
    expect(() => normalizeCommissionTerms({ ...terms, amountVnd })).toThrow(new CommissionError("invalid_terms"));
  });
  test("preserves accepted facts independently of later edits", () => {
    const source = { ...terms };
    const snapshot = normalizeCommissionTerms(source);
    source.amountVnd = 600_000;
    expect(snapshot.amountVnd).toBe(500_000);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(normalizeCommissionTerms({ ...terms, amountVnd: 50_000_000 }).amountVnd).toBe(50_000_000);
  });
  test.each([{ turnaroundDays: 0 }, { turnaroundDays: 91 }, { revisionAllowance: 11 }, { reviewWindowDays: 2 }, { reviewWindowDays: 15 }, { scope: "" }, { artistTerms: "<script>" }, { policyRevisionId: "missing" }])("rejects invalid terms %j", (patch) => {
    expect(() => normalizeCommissionTerms({ ...terms, ...patch })).toThrow(new CommissionError("invalid_terms"));
  });
  test("does not evaluate accessors or proxies at a domain boundary", () => {
    let evaluated = false;
    const value = { ...terms, get amountVnd() { evaluated = true; return 50_000; } };
    expect(() => normalizeCommissionTerms(value)).toThrow();
    expect(() => normalizeCommissionTerms(new Proxy(terms, { ownKeys() { evaluated = true; return []; } }))).toThrow();
    expect(evaluated).toBe(false);
  });
});

describe("private brief", () => {
  test("normalizes text and copies only bounded HTTPS references", () => {
    const value = { text: "  Chân dung\r\nMàu xanh  ", referenceLinks: ["https://example.invalid/reference"] };
    const brief = normalizeCommissionBrief(value);
    value.referenceLinks[0] = "https://other.invalid";
    expect(brief).toEqual({ text: "Chân dung\nMàu xanh", referenceLinks: ["https://example.invalid/reference"] });
    expect(Object.isFrozen(brief.referenceLinks)).toBe(true);
  });
  test.each(["javascript:alert(1)", "http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/\n", `https://example.invalid/${"x".repeat(512)}`])("rejects unsafe reference %s", (url) => {
    expect(() => normalizeCommissionBrief({ text: "Portrait", referenceLinks: [url] })).toThrow(new CommissionError("invalid_brief"));
  });
  test("rejects sparse arrays, accessors, duplicates and excess links", () => {
    let evaluated = false;
    const accessor = ["https://example.invalid"];
    Object.defineProperty(accessor, 0, { get() { evaluated = true; return "https://example.invalid"; }, enumerable: true });
    for (const referenceLinks of [Array(1), accessor, ["https://example.invalid", "https://example.invalid/"], Array.from({ length: 6 }, (_, i) => `https://example.invalid/${i}`)]) {
      expect(() => normalizeCommissionBrief({ text: "Portrait", referenceLinks })).toThrow();
    }
    expect(evaluated).toBe(false);
  });
  test("counts Unicode code points and prevents control-character ambiguity", () => {
    expect(normalizeCommissionBrief({ text: "🎨".repeat(3_000), referenceLinks: [] }).text).toHaveLength(6_000);
    for (const text of ["🎨".repeat(3_001), "\u202eportrait", "\ud800", " "]) {
      expect(() => normalizeCommissionBrief({ text, referenceLinks: [] })).toThrow();
    }
  });
});

describe("deadline and lifecycle boundaries", () => {
  test("quote revisions cannot keep requests alive beyond thirty days", () => {
    const late = new Date("2026-10-24T23:00:00Z");
    expect(commissionQuoteExpiry(at, late, COMMISSION_POLICY.defaultQuoteTtlMs)).toEqual(new Date("2026-10-25T00:00:00Z"));
    expect(() => commissionQuoteExpiry(at, new Date(late.getTime() + 1), COMMISSION_POLICY.defaultQuoteTtlMs)).toThrow(new CommissionError("expired"));
    expect(() => commissionQuoteExpiry(at, new Date(at.getTime() - 1), COMMISSION_POLICY.defaultQuoteTtlMs)).toThrow();
  });
  test("accepting shortly before quote expiry still grants a full payment day", () => {
    const quoteExpiry = commissionQuoteExpiry(at, at, 3_600_000);
    const acceptedAt = new Date(quoteExpiry.getTime() - 1);
    requireCommissionBeforeDeadline(acceptedAt, quoteExpiry);
    expect(commissionPaymentExpiry(acceptedAt).getTime() - acceptedAt.getTime()).toBe(86_400_000);
    expect(() => requireCommissionBeforeDeadline(quoteExpiry, quoteExpiry)).toThrow(new CommissionError("expired"));
    expect(commissionDueAt(acceptedAt, 7).getTime() - acceptedAt.getTime()).toBe(7 * 86_400_000);
  });
  test("invalid timestamps cannot evade the expiry comparison", () => {
    expect(() => requireCommissionBeforeDeadline(new Date(NaN), at)).toThrow();
    expect(() => commissionDueAt(new Date(8_640_000_000_000_000), 90)).toThrow();
  });
  test("only payment confirmation opens work; paid and closed orders cannot be cancelled or reopened", () => {
    requireCommissionTransition("awaiting_payment", "in_progress");
    requireCommissionTransition("awaiting_payment", "closed", "buyer_cancelled");
    expect(() => requireCommissionTransition("requested", "in_progress")).toThrow();
    expect(() => requireCommissionTransition("in_progress", "closed", "buyer_cancelled")).toThrow();
    expect(() => requireCommissionTransition("closed", "awaiting_payment")).toThrow();
    expect(() => requireCommissionTransition("quoted", "closed", "payment_expired")).toThrow();
    expect(() => requireCommissionTransition("requested", "quoted", "request_expired")).toThrow();
  });
});
