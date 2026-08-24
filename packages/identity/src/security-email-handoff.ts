import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import {
  identityEmailHandoffs,
  insertOutboxEvent,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import {
  canonicalizeSafeStructuredData,
  decryptSensitiveField,
  encryptSensitiveField,
  type EncryptionEnvelope,
  type EncryptionKeyring,
} from "@pawket/security";

import type {
  SecurityEmailPurpose,
  SecurityEmailSender,
} from "./security-email.js";

const HANDOFF_RECORD_TYPE = "identity_email_handoff";

function safeTemplateData(input: Record<string, string>): Record<string, string> {
  const value = canonicalizeSafeStructuredData(input, "outbox");
  return value as Record<string, string>;
}

export async function queueSecurityEmailHandoff(
  tx: PawketTransaction,
  input: {
    id: string;
    userId: string;
    purpose: SecurityEmailPurpose;
    destination: string;
    secret?: string | null;
    templateData?: Record<string, string>;
    keyring: EncryptionKeyring;
    now: Date;
  },
): Promise<string> {
  const destinationEnvelope = encryptSensitiveField({
    plaintext: input.destination,
    binding: {
      recordType: HANDOFF_RECORD_TYPE,
      recordId: input.id,
      fieldName: "destination",
    },
    keyring: input.keyring,
  });
  const secretEnvelope = input.secret
    ? encryptSensitiveField({
        plaintext: input.secret,
        binding: {
          recordType: HANDOFF_RECORD_TYPE,
          recordId: input.id,
          fieldName: "secret",
        },
        keyring: input.keyring,
      })
    : null;

  await tx.insert(identityEmailHandoffs).values({
    id: input.id,
    purpose: input.purpose,
    userId: input.userId,
    destinationEnvelope,
    secretEnvelope,
    templateData: safeTemplateData(input.templateData ?? {}),
    status: "pending",
    attempts: 0,
    availableAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await insertOutboxEvent(tx, {
    eventType: "identity.security_email.requested.v1",
    eventVersion: 1,
    aggregateType: "security_email_handoff",
    aggregateId: input.id,
    payload: { handoffId: input.id, purpose: input.purpose },
    occurredAt: input.now,
    availableAt: input.now,
  });
  return input.id;
}

export async function deliverSecurityEmailHandoff(
  db: PawketDatabase,
  input: {
    handoffId: string;
    workerId: string;
    keyring: EncryptionKeyring;
    sender: SecurityEmailSender;
    now: Date;
    leaseMs?: number;
  },
): Promise<"delivered" | "already_delivered"> {
  const leaseExpiresAt = new Date(input.now.getTime() + (input.leaseMs ?? 30_000));
  const [claimed] = await db
    .update(identityEmailHandoffs)
    .set({
      status: "processing",
      attempts: sql`${identityEmailHandoffs.attempts} + 1`,
      lockedAt: input.now,
      lockedBy: input.workerId,
      leaseExpiresAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(identityEmailHandoffs.id, input.handoffId),
        isNull(identityEmailHandoffs.sentAt),
        lte(identityEmailHandoffs.availableAt, input.now),
        or(
          isNull(identityEmailHandoffs.leaseExpiresAt),
          lte(identityEmailHandoffs.leaseExpiresAt, input.now),
        ),
      ),
    )
    .returning();

  if (!claimed) {
    const [existing] = await db
      .select({ sentAt: identityEmailHandoffs.sentAt })
      .from(identityEmailHandoffs)
      .where(eq(identityEmailHandoffs.id, input.handoffId))
      .limit(1);
    if (existing?.sentAt) return "already_delivered";
    throw new Error("Security email handoff is unavailable");
  }

  const binding = (fieldName: "destination" | "secret") => ({
    recordType: HANDOFF_RECORD_TYPE,
    recordId: claimed.id,
    fieldName,
  });
  const destination = decryptSensitiveField({
    envelope: claimed.destinationEnvelope as EncryptionEnvelope<
      typeof HANDOFF_RECORD_TYPE,
      "destination"
    >,
    binding: binding("destination"),
    keyring: input.keyring,
  });
  const secret = claimed.secretEnvelope
    ? decryptSensitiveField({
        envelope: claimed.secretEnvelope as EncryptionEnvelope<
          typeof HANDOFF_RECORD_TYPE,
          "secret"
        >,
        binding: binding("secret"),
        keyring: input.keyring,
      })
    : null;

  try {
    await input.sender.send({
      handoffId: claimed.id,
      purpose: claimed.purpose as SecurityEmailPurpose,
      destination,
      secret,
      templateData: claimed.templateData,
    });
  } catch {
    await db
      .update(identityEmailHandoffs)
      .set({
        status: "failed",
        failureCode: "delivery_failed",
        availableAt: new Date(input.now.getTime() + 60_000),
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(identityEmailHandoffs.id, input.handoffId),
          eq(identityEmailHandoffs.lockedBy, input.workerId),
        ),
      );
    throw new Error("Security email delivery failed");
  }

  const sent = await db
    .update(identityEmailHandoffs)
    .set({
      status: "sent",
      sentAt: input.now,
      failureCode: null,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(identityEmailHandoffs.id, input.handoffId),
        eq(identityEmailHandoffs.lockedBy, input.workerId),
      ),
    )
    .returning({ id: identityEmailHandoffs.id });
  if (sent.length !== 1) throw new Error("Security email delivery failed");
  return "delivered";
}
