import { desc, eq } from "drizzle-orm";
import { trustContentHides, trustPenalties, type PawketDatabase } from "@pawket/database";
import { effectiveEnforcementDeadline, TRUST_ENFORCEMENT_POLICY, type PenaltyService, type AppealService, type PrivateReportService } from "@pawket/trust";
import { penaltyReasonLabels, type MyTrustCasesView } from "../ui/trust/trust-client.js";

type Penalty = Pick<Awaited<ReturnType<PenaltyService["listForSubject"]>>[number], "penaltyId" | "kind" | "restriction" | "target" | "state" | "reasonCategory" | "explanation" | "startsAt" | "endsAt" | "endedAt" | "acknowledgedAt"> & { replaced: boolean };
type Hide = { hideId: string; targetKind: "commission_message" | "commission_file" | "commission_package"; hiddenAt: string; releasedAt: string | null };
type Appeal = Pick<Awaited<ReturnType<AppealService["listForUser"]>>[number], "appealId" | "penaltyId" | "hideId" | "state" | "reasoning" | "createdAt" | "decidedAt">;
type FiledReport = Awaited<ReturnType<PrivateReportService["listFiledBy"]>>[number];
export async function projectTrustCases(input: { penalties: readonly Penalty[]; hides: readonly Hide[]; appeals: readonly Appeal[]; reportsFiled: readonly FiledReport[];
  now: Date; effectiveDeadline(deadline: Date): Promise<Date | null> }): Promise<MyTrustCasesView> {
  const appeal = async (at: string, state: Appeal["state"] | null, eligible: boolean) => {
    const deadline = await input.effectiveDeadline(new Date(Date.parse(at) + TRUST_ENFORCEMENT_POLICY.appealWindowMs));
    return { appealState: state, appealDeadline: deadline?.toISOString() ?? null, canAppeal: eligible && state === null && deadline !== null && input.now >= new Date(at) && input.now < deadline };
  };
  return {
    // Explicit allowlists: never spread service or database rows into a party response.
    reportsFiled: input.reportsFiled.map((row) => ({ reportReference: row.reportReference, targetKind: row.targetKind, state: row.state })),
    penalties: await Promise.all(input.penalties.map(async (row) => ({ penaltyId: row.penaltyId, kind: row.kind, restriction: row.restriction, target: row.target,
      state: row.state, reasonCategoryLabel: penaltyReasonLabels[row.reasonCategory], explanation: row.explanation, startsAt: row.startsAt,
      endsAt: row.endsAt, endedAt: row.endedAt, acknowledgedAt: row.acknowledgedAt,
      ...await appeal(row.startsAt, input.appeals.find((a) => a.penaltyId === row.penaltyId)?.state ?? null,
        row.kind !== "warning" && row.state === "active" && !row.replaced && (row.endsAt === null || input.now < new Date(row.endsAt))) }))),
    hides: await Promise.all(input.hides.map(async (row) => ({ hideId: row.hideId, targetKind: row.targetKind, hiddenAt: row.hiddenAt, releasedAt: row.releasedAt,
      explanation: "Nội dung này đã bị Pawket ẩn vì vi phạm quy định cộng đồng.",
      ...await appeal(row.hiddenAt, input.appeals.find((a) => a.hideId === row.hideId)?.state ?? null, row.releasedAt === null) }))),
    appeals: input.appeals.map((row) => ({ appealId: row.appealId, penaltyId: row.penaltyId, hideId: row.hideId, state: row.state,
      reasoning: row.state === "open" ? null : row.reasoning, createdAt: row.createdAt, decidedAt: row.decidedAt })),
  };
}
export function createTrustPartyView(input: { db: PawketDatabase; penalties: Pick<PenaltyService, "listForSubject">; appeals: Pick<AppealService, "listForUser">; reports: Pick<PrivateReportService, "listFiledBy"> }) {
  return { async listForUser(userId: string) {
    const [penalties, appeals, reportsFiled, hides, replacements] = await Promise.all([
      input.penalties.listForSubject(userId), input.appeals.listForUser(userId), input.reports.listFiledBy(userId),
      input.db.select({ hideId: trustContentHides.id, targetKind: trustContentHides.targetKind, hiddenAt: trustContentHides.hiddenAt, releasedAt: trustContentHides.releasedAt })
        .from(trustContentHides).where(eq(trustContentHides.contentOwnerUserId, userId)).orderBy(desc(trustContentHides.hiddenAt), desc(trustContentHides.id)),
      input.db.select({ penaltyId: trustPenalties.id, replacesPenaltyId: trustPenalties.replacesPenaltyId }).from(trustPenalties).where(eq(trustPenalties.subjectUserId, userId)),
    ]);
    return projectTrustCases({ penalties: penalties.map((row) => ({ ...row, replaced: replacements.some((replacement) => replacement.penaltyId === row.penaltyId && replacement.replacesPenaltyId !== null) })),
      appeals, reportsFiled, hides: hides.map((row) => ({ ...row, hiddenAt: row.hiddenAt.toISOString(), releasedAt: row.releasedAt?.toISOString() ?? null })),
      now: new Date(), effectiveDeadline: (deadline) => effectiveEnforcementDeadline(input.db, deadline) });
  } };
}
