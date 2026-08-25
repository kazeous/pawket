import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { PawketDatabase, PawketTransaction } from "./client.js";
import {
  identityEmailHandoffs,
  identityUsers,
  paymentsVerificationDepositRefundObligations,
  systemOutbox,
} from "./schema.js";

function ageSeconds(now: Date, oldest: Date | null): number {
  return oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1_000) : 0;
}

export async function readOperationalBacklogMetrics(
  db: PawketDatabase,
  now: Date,
): Promise<{
  outbox: { pending: number; oldestAgeSeconds: number };
  email: { pending: number; oldestAgeSeconds: number; attention: number };
}> {
  const [outbox] = await db
    .select({
      pending: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${systemOutbox.occurredAt})`,
    })
    .from(systemOutbox)
    .where(isNull(systemOutbox.publishedAt));
  const [email] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${identityEmailHandoffs.sentAt} is null and ${identityEmailHandoffs.status} <> 'attention_required')::int`,
      oldest: sql<Date | null>`min(${identityEmailHandoffs.createdAt}) filter (where ${identityEmailHandoffs.sentAt} is null and ${identityEmailHandoffs.status} <> 'attention_required')`,
      attention: sql<number>`count(*) filter (where ${identityEmailHandoffs.status} = 'attention_required')::int`,
    })
    .from(identityEmailHandoffs)
    .where(
      and(
        isNull(identityEmailHandoffs.sentAt),
        ne(identityEmailHandoffs.status, "sent"),
      ),
    );

  return {
    outbox: {
      pending: outbox?.pending ?? 0,
      oldestAgeSeconds: ageSeconds(now, outbox?.oldest ?? null),
    },
    email: {
      pending: email?.pending ?? 0,
      oldestAgeSeconds: ageSeconds(now, email?.oldest ?? null),
      attention: email?.attention ?? 0,
    },
  };
}

export async function findEmailHandoffBySourceEvent(
  tx: PawketTransaction,
  sourceOutboxEventId: string,
): Promise<
  | {
      id: string;
      purpose: string;
      userId: string;
      status: string;
      destinationEnvelope: unknown;
      failureCode: string | null;
    }
  | undefined
> {
  const [handoff] = await tx
    .select({
      id: identityEmailHandoffs.id,
      purpose: identityEmailHandoffs.purpose,
      userId: identityEmailHandoffs.userId,
      status: identityEmailHandoffs.status,
      destinationEnvelope: identityEmailHandoffs.destinationEnvelope,
      failureCode: identityEmailHandoffs.failureCode,
    })
    .from(identityEmailHandoffs)
    .where(eq(identityEmailHandoffs.sourceOutboxEventId, sourceOutboxEventId))
    .limit(1);
  return handoff;
}

export async function findOperationalEmailUser(
  tx: PawketTransaction,
  userId: string,
): Promise<{ email: string; emailVerified: boolean } | undefined> {
  const [user] = await tx
    .select({ email: identityUsers.email, emailVerified: identityUsers.emailVerified })
    .from(identityUsers)
    .where(eq(identityUsers.id, userId))
    .limit(1);
  return user;
}

export async function findRefundEmailContext(
  tx: PawketTransaction,
  obligationId: string,
): Promise<
  | { applicantUserId: string; refundNotBefore: string; refundDue: string }
  | undefined
> {
  const [obligation] = await tx
    .select({
      applicantUserId: paymentsVerificationDepositRefundObligations.applicantUserId,
      refundNotBefore: paymentsVerificationDepositRefundObligations.refundNotBefore,
      refundDue: paymentsVerificationDepositRefundObligations.refundDue,
    })
    .from(paymentsVerificationDepositRefundObligations)
    .where(eq(paymentsVerificationDepositRefundObligations.id, obligationId))
    .limit(1);
  return obligation;
}
