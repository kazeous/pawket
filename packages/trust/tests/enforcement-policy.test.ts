import { describe, expect, test } from "vitest";
import { normalizeTrustText, TRUST_ENFORCEMENT_POLICY, TRUST_RESTRICTIONS, TRUST_PENALTY_KINDS,
  TRUST_PENALTY_TARGETS, TRUST_PENALTY_REASONS, TRUST_POLICY_KINDS, TrustEnforcementError, trustFail } from "../src/enforcement-policy.js";

describe("trust enforcement policy", () => {
  test("normalizeTrustText trims nothing, applies NFC, rejects control characters except newline in multiline", () => {
    expect(normalizeTrustText("Tiêu", 1, 1_000)).toBe("Tiêu");
    expect(normalizeTrustText("  text  ", 1, 1_000)).toBe("  text  ");
    for (const text of ["a\u0007", "a\nb", "a\tb", "a\rb", "a\u0085b", "a\ud800"]) {
      expect(() => normalizeTrustText(text, 1, 1_000)).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
    expect(normalizeTrustText("a\nb", 1, 1_000, { multiline: true })).toBe("a\nb");
    expect(() => normalizeTrustText("a\r\nb", 1, 1_000, { multiline: true })).toThrow("invalid_request");
  });
  test("limits count code points", () => {
    expect(normalizeTrustText("𝒜".repeat(1_000), 1, 1_000)).toBe("𝒜".repeat(1_000));
    expect(() => normalizeTrustText("𝒜".repeat(1_001), 1, 1_000)).toThrow("invalid_request");
    expect(normalizeTrustText("e\u0301", 1, 1)).toBe("é");
  });
  test("invalid text and bounds fail with a domain error", () => {
    for (const value of [null, undefined, 123, {}, ""]) expect(() => normalizeTrustText(value, 1, 10)).toThrow(TrustEnforcementError);
    for (const [min, max] of [[-1, 10], [2, 1], [0, NaN], [0.5, 10]]) {
      expect(() => normalizeTrustText("a", min!, max!)).toThrow("invalid_request");
    }
    expect(() => trustFail("restricted")).toThrow(expect.objectContaining({ name: "TrustEnforcementError", code: "restricted", message: "restricted" }));
  });
  test("policy values and names are stable and frozen", () => {
    expect(TRUST_ENFORCEMENT_POLICY).toEqual({ appealWindowMs: 1_209_600_000, helpLinkAppealMs: 1_209_600_000,
      helpReadOnlyMs: 7_776_000_000, helpSessionMs: 1_800_000, resumeGraceMs: 172_800_000, messageContext: 20,
      reportDetailMax: 1_000, explanationMax: 2_000, internalNoteMax: 2_000, actionReasonMax: 2_000,
      appealStatementMax: 4_000, decisionReasoningMax: 4_000, policyDocumentMax: 16_000, actorReportLimit: 10,
      guestReportLimit: 5, reportWindowMs: 900_000, linkRequestsPerAddress: 3, linkAddressWindowMs: 86_400_000,
      linkRequestsPerNetwork: 10, linkNetworkWindowMs: 3_600_000 });
    expect(Object.isFrozen(TRUST_ENFORCEMENT_POLICY)).toBe(true);
    expect(TRUST_RESTRICTIONS).toEqual(["commission_intake", "commission_buying", "dispute_opening", "reporting"]);
    expect(TRUST_PENALTY_KINDS).toEqual(["warning", "restriction", "suspension", "removal"]);
    expect(TRUST_PENALTY_TARGETS).toEqual(["creator_capability", "account"]);
    expect(TRUST_PENALTY_REASONS).toEqual(["spam_or_scam", "harassment_or_hate", "prohibited_or_age_restricted_content",
      "intellectual_property", "privacy", "impersonation", "refund_non_compliance", "dispute_or_report_abuse", "other"]);
    expect(TRUST_POLICY_KINDS).toEqual(["community_rules", "enforcement_appeals"]);
  });
});
