import type { PawketTransaction } from "@pawket/database";

export type EnforcementNoticePort = Readonly<{
  queue(tx: PawketTransaction, command: { userId: string; penaltyId: string; token: string; kind: "suspension" | "removal"; endsAt: Date | null; at: Date }): Promise<void>;
}>;
