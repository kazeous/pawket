import type { PawketTransaction } from "@pawket/database";
import type { NotificationCategory, NotificationKind } from "./catalog.js";

/** Queues one notification email inside the materializer's transaction (P7: no source outbox event id). */
export type NotificationEmailPort = {
  queue(tx: PawketTransaction, input: {
    notificationId: string; userId: string; kind: NotificationKind; variant: string | null;
    category: NotificationCategory; linkPath: string; at: Date;
  }): Promise<{ handoffId: string; outcome: "queued" | "attention_required" }>;
};

/** Effective deadlines read through their owning modules; null while a clock is paused (wired in Task 6). */
export type NotificationDeadlinePort = {
  resolution(tx: PawketTransaction, deadline: Date): Promise<Date | null>;
  completion(tx: PawketTransaction, order: { reviewEndsAt: Date; completionFloorAt: Date | null }): Promise<Date | null>;
  enforcement(tx: PawketTransaction, deadline: Date): Promise<Date | null>;
};
