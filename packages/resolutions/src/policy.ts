import { commissionPlainText } from "@pawket/orders";
import { resolutionFail } from "./contracts.js";

export const RESOLUTION_POLICY = Object.freeze({
  proposalResponseMs: 259_200_000, maxProposalsPerParty: 3, disputeResponseMs: 432_000_000,
  maxDisputeExtensionMs: 1_209_600_000, overdueTriggerMs: 604_800_000, proposalTriggerWindowMs: 604_800_000,
  maxStatementsPerParty: 10, statementMaxCodePoints: 4_000, noteMaxCodePoints: 2_000,
  restoreFloorMs: 172_800_000, correctionWindowMs: 2_592_000_000, claimWindowMs: 2_592_000_000,
  claimResponseMs: 432_000_000, pauseGraceMs: 172_800_000, maxClaimAmountVnd: 50_000_000,
});
export function normalizeResolutionText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum < minimum) resolutionFail("invalid_request");
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n");
  // Reject controls before trimming, including tabs and the C1 control range.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(normalized)) resolutionFail("invalid_request");
  try { return commissionPlainText(normalized, minimum, maximum); } catch { return resolutionFail("invalid_request"); }
}
