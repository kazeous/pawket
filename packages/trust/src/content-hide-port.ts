import { and, eq, inArray, isNull } from "drizzle-orm";
import { trustContentHides, type PawketTransaction } from "@pawket/database";

export type ContentHideKind = "commission_message" | "commission_file" | "commission_package";

/** Active hides remain effective during a switch pause; the switch gates new owner commands. */
export function createContentHideReadPort() {
  return {
    async hiddenIds(tx: PawketTransaction, kind: ContentHideKind, ids: readonly string[]): Promise<ReadonlySet<string>> {
      if (ids.length === 0) return new Set();
      const rows = await tx.select({ id: trustContentHides.targetId }).from(trustContentHides)
        .where(and(eq(trustContentHides.targetKind, kind), inArray(trustContentHides.targetId, [...new Set(ids)]), isNull(trustContentHides.releasedAt)));
      return new Set(rows.map((row) => row.id));
    },
    async activeHide(tx: PawketTransaction, kind: ContentHideKind, id: string): Promise<{ hideId: string; hiddenAt: Date } | null> {
      const [row] = await tx.select({ hideId: trustContentHides.id, hiddenAt: trustContentHides.hiddenAt }).from(trustContentHides)
        .where(and(eq(trustContentHides.targetKind, kind), eq(trustContentHides.targetId, id), isNull(trustContentHides.releasedAt))).limit(1);
      return row ?? null;
    },
  };
}
export type ContentHideReadPort = ReturnType<typeof createContentHideReadPort>;
