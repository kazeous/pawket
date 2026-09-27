import { sql } from "drizzle-orm";
import type { PawketDatabase } from "@pawket/database";
import { commissionTime } from "./policy.js";

export type CommissionOperationalReport = {
  requested: number; quoted: number; awaitingPayment: number; inProgress: number;
  expiredRequests: number; expiredQuotes: number; expiredPayments: number;
  oldestExpiryLagSeconds: number; overdue: number;
  retentionUnacceptedClosed: number; retentionAccepted: number;
};

/** Aggregate inventory only. No decrypt, row identifiers, retention eligibility or writes. */
export async function readCommissionOperationalReport(db: PawketDatabase, at: Date): Promise<CommissionOperationalReport> {
  commissionTime(at);
  const instant = at.toISOString();
  const cutoff = new Date(at.getTime() - 90 * 86_400_000).toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    const [row] = await tx.execute<Record<keyof CommissionOperationalReport, string | number>>(sql`
      select
        count(*) filter (where state = 'requested') as "requested",
        count(*) filter (where state = 'quoted') as "quoted",
        count(*) filter (where state = 'awaiting_payment') as "awaitingPayment",
        count(*) filter (where state = 'in_progress') as "inProgress",
        count(*) filter (where state = 'requested' and expires_at <= ${instant}::timestamptz) as "expiredRequests",
        count(*) filter (where state = 'quoted' and expires_at <= ${instant}::timestamptz) as "expiredQuotes",
        count(*) filter (where state = 'awaiting_payment' and expires_at <= ${instant}::timestamptz) as "expiredPayments",
        coalesce(max(extract(epoch from (${instant}::timestamptz - expires_at))) filter
          (where state in ('requested', 'quoted', 'awaiting_payment') and expires_at <= ${instant}::timestamptz), 0) as "oldestExpiryLagSeconds",
        count(*) filter (where state = 'in_progress' and due_at <= ${instant}::timestamptz) as "overdue",
        count(*) filter (where state = 'closed' and accepted_at is null and closed_at <= ${cutoff}::timestamptz) as "retentionUnacceptedClosed",
        count(*) filter (where accepted_at is not null) as "retentionAccepted"
      from commission_orders
    `);
    if (!row) throw new Error("Commission operational report unavailable");
    const report = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as CommissionOperationalReport;
    if (!Object.entries(report).every(([key, value]) => Number.isFinite(value) && value >= 0 && (key === "oldestExpiryLagSeconds" || Number.isSafeInteger(value)))) {
      throw new Error("Invalid commission operational report");
    }
    return report;
  });
}
