import { and, eq, gt } from "drizzle-orm";
import { assertSafeStructuredData } from "@pawket/security/structured-data";

import type { PawketTransaction } from "./client.js";
import { systemCommandIdempotency } from "./schema.js";

const digestPattern = /^(?:sha256|hmac-sha256):v1:[A-Za-z0-9_-]{43}$/;
const resultReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const commandIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type BeginIdempotentCommandResult =
  | { kind: "acquired"; recordId: string }
  | { kind: "in_progress"; recordId: string }
  | { kind: "replay"; recordId: string; resultReference: string }
  | { kind: "conflict"; recordId: string }
  | { kind: "expired"; recordId: string };

function assertDigest(value: string): void {
  if (!digestPattern.test(value)) throw new Error("Invalid idempotency digest");
}

export async function beginIdempotentCommand(
  tx: PawketTransaction,
  input: {
    actorUserId: string;
    commandScope: string;
    keyHash: string;
    requestFingerprint: string;
    expiresAt: Date;
    now?: Date;
  },
): Promise<BeginIdempotentCommandResult> {
  assertDigest(input.keyHash);
  assertDigest(input.requestFingerprint);
  if (
    !commandIdentifierPattern.test(input.actorUserId) ||
    !commandIdentifierPattern.test(input.commandScope)
  ) {
    throw new Error("Invalid idempotency command");
  }
  const now = input.now ?? new Date();
  if (input.expiresAt <= now) throw new Error("Invalid idempotency expiry");

  const [inserted] = await tx
    .insert(systemCommandIdempotency)
    .values({
      actorUserId: input.actorUserId,
      commandScope: input.commandScope,
      keyHash: input.keyHash,
      requestFingerprint: input.requestFingerprint,
      createdAt: now,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: systemCommandIdempotency.id });

  if (inserted) return { kind: "acquired", recordId: inserted.id };

  const [existing] = await tx
    .select()
    .from(systemCommandIdempotency)
    .where(
      and(
        eq(systemCommandIdempotency.actorUserId, input.actorUserId),
        eq(systemCommandIdempotency.commandScope, input.commandScope),
        eq(systemCommandIdempotency.keyHash, input.keyHash),
      ),
    )
    .limit(1)
    .for("update");

  if (!existing) throw new Error("Idempotency record disappeared");
  if (existing.expiresAt <= now) return { kind: "expired", recordId: existing.id };
  if (existing.requestFingerprint !== input.requestFingerprint) {
    return { kind: "conflict", recordId: existing.id };
  }
  if (existing.status === "completed" && existing.resultReference) {
    return {
      kind: "replay",
      recordId: existing.id,
      resultReference: existing.resultReference,
    };
  }
  return { kind: "in_progress", recordId: existing.id };
}

export async function completeIdempotentCommand(
  tx: PawketTransaction,
  input: { recordId: string; resultReference: string; completedAt?: Date },
): Promise<boolean> {
  if (!resultReferencePattern.test(input.resultReference)) {
    throw new Error("Invalid idempotency result reference");
  }
  assertSafeStructuredData({ resultReference: input.resultReference }, "command");
  const completedAt = input.completedAt ?? new Date();
  const updated = await tx
    .update(systemCommandIdempotency)
    .set({ status: "completed", resultReference: input.resultReference, completedAt })
    .where(
      and(
        eq(systemCommandIdempotency.id, input.recordId),
        eq(systemCommandIdempotency.status, "in_progress"),
        gt(systemCommandIdempotency.expiresAt, completedAt),
      ),
    )
    .returning({ id: systemCommandIdempotency.id });

  if (updated.length === 1) return true;
  const [existing] = await tx
    .select({ resultReference: systemCommandIdempotency.resultReference })
    .from(systemCommandIdempotency)
    .where(eq(systemCommandIdempotency.id, input.recordId))
    .limit(1);
  return existing?.resultReference === input.resultReference;
}
