import { tips, type PawketTransaction } from "@pawket/database";
import { eq } from "drizzle-orm";

// Payment authorization needs ownership only; unpaid guest content never leaves
// Tips through this port. The aggregate binding is immutable in PostgreSQL.
export function createTipAccessPort() {
  return {
    async getTipOwnership(tx: PawketTransaction, tipId: string): Promise<Readonly<{ buyerUserId: string | null }> | null> {
      const [tip] = await tx.select({ buyerUserId: tips.buyerUserId }).from(tips).where(eq(tips.id, tipId)).limit(1);
      return tip ? Object.freeze({ buyerUserId: tip.buyerUserId }) : null;
    },
  };
}
