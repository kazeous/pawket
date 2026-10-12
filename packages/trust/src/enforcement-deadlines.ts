import { randomUUID } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import { trustEnforcementPauses, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { TrustEnforcementError, trustFail, type TrustEnforcementMode } from "./enforcement-policy.js";

function time(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) trustFail("invalid_request");
  return new Date(value);
}
async function available<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { if (error instanceof TrustEnforcementError) throw error; return trustFail("dependency_unavailable"); }
}
/** Only appeal deadlines use this function; penalty expiry and read-only retention keep running. */
export async function effectiveEnforcementDeadline(db: PawketDatabase | PawketTransaction, deadline: Date): Promise<Date | null> {
  const at = time(deadline);
  return available(async () => {
    const [row] = await db.execute<{ deadline: Date | string | null }>(sql`select trust_enforcement_effective_deadline(${at.toISOString()}::timestamptz) as deadline`);
    if (!row) trustFail("dependency_unavailable");
    if (row.deadline === null) return null;
    const effective = new Date(row.deadline);
    if (!Number.isFinite(effective.getTime())) trustFail("dependency_unavailable");
    return effective;
  });
}

export async function recordEnforcementModeTransition(db: PawketDatabase, input: { mode: TrustEnforcementMode; at: Date }): Promise<void> {
  if (input.mode !== "disabled" && input.mode !== "enabled") trustFail("invalid_request");
  const at = time(input.at); const mode = input.mode;
  await available(() => db.transaction(async (tx) => {
    // The advisory lock also serializes observers when no open pause exists yet.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('trust:enforcement-pauses', 0))`);
    const [pause] = await tx.select().from(trustEnforcementPauses).where(isNull(trustEnforcementPauses.endedAt)).limit(1).for("update");
    if (mode === "disabled" && !pause) await tx.insert(trustEnforcementPauses).values({ id: randomUUID(), startedAt: at });
    if (mode === "enabled" && pause) {
      if (at < pause.startedAt) trustFail("invalid_request");
      await tx.update(trustEnforcementPauses).set({ endedAt: at, version: pause.version + 1 }).where(eq(trustEnforcementPauses.id, pause.id));
    }
  }));
}
