import { COMMISSION_FULFILLMENT_POLICY, COMMISSION_POLICY, commissionInteger, commissionTime } from "./policy.js";

const DAY_MS = 86_400_000;
export type CommissionFulfillmentPause = Readonly<{ startedAt: Date; endedAt: Date | null }>;

function plus(value: Date, delta: number): Date {
  const result = new Date(commissionTime(value) + delta);
  commissionTime(result);
  return result;
}
export function commissionReviewEndsAt(deliveredAt: Date, reviewWindowDays: number): Date {
  return plus(deliveredAt, commissionInteger(reviewWindowDays, COMMISSION_POLICY.minimumReviewWindowDays, COMMISSION_POLICY.maximumReviewWindowDays) * DAY_MS);
}
export function commissionCompletionDueAt(reviewEndsAt: Date, pauses: readonly CommissionFulfillmentPause[], pauseGraceMs = COMMISSION_FULFILLMENT_POLICY.pauseGraceMs): Date | null {
  commissionTime(reviewEndsAt);
  commissionInteger(pauseGraceMs, 0, Number.MAX_SAFE_INTEGER);
  const sorted = [...pauses].sort((a, b) => commissionTime(a.startedAt) - commissionTime(b.startedAt));
  let due = reviewEndsAt;
  for (const pause of sorted) {
    if (pause.startedAt > due) break;
    if (pause.endedAt !== null && pause.endedAt <= due) continue;
    if (pause.endedAt === null) return null;
    due = plus(pause.endedAt, pauseGraceMs);
  }
  return due;
}
export const commissionFileDeletionAt = (completedAt: Date): Date => plus(completedAt, COMMISSION_FULFILLMENT_POLICY.completedFileRetentionMs);
