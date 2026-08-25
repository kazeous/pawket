import { and, eq, gte, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import {
  identityEmailHandoffs,
  identityUsers,
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
const PROVIDER_SEND_ATTEMPT_LIMIT = 3;
const UNKNOWN_OUTCOME_RETRY_DELAY_MS = 60_000;

export async function queueUserSecurityNotice(
  tx: PawketTransaction,
  input: {
    id: string;
    userId: string;
    event: string;
    keyring: EncryptionKeyring;
    now: Date;
  },
): Promise<string> {
  const [user] = await tx
    .select({ email: identityUsers.email })
    .from(identityUsers)
    .where(eq(identityUsers.id, input.userId))
    .limit(1);
  if (!user) throw new Error("Security notice destination is unavailable");
  return queueSecurityEmailHandoff(tx, {
    id: input.id,
    userId: input.userId,
    purpose: "security_notice",
    destination: user.email,
    templateData: { event: input.event, returnPath: "/settings/security" },
    keyring: input.keyring,
    now: input.now,
  });
}

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
    sourceOutboxEventId?: string;
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

  const [inserted] = await tx.insert(identityEmailHandoffs).values({
    id: input.id,
    purpose: input.purpose,
    sourceOutboxEventId: input.sourceOutboxEventId,
    userId: input.userId,
    destinationEnvelope,
    secretEnvelope,
    templateData: safeTemplateData(input.templateData ?? {}),
    status: "pending",
    attempts: 0,
    availableAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing().returning({ id: identityEmailHandoffs.id });
  if (!inserted) {
    if (!input.sourceOutboxEventId) throw new Error("Security email handoff already exists");
    const [existing] = await tx
      .select({ id: identityEmailHandoffs.id })
      .from(identityEmailHandoffs)
      .where(eq(identityEmailHandoffs.sourceOutboxEventId, input.sourceOutboxEventId))
      .limit(1);
    if (!existing) throw new Error("Security email handoff conflict");
    return existing.id;
  }
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

export async function recordSecurityEmailAttentionRequired(
  tx: PawketTransaction,
  input: {
    id: string;
    userId: string;
    purpose: SecurityEmailPurpose;
    sourceOutboxEventId: string;
    failureCode: "no_verified_destination";
    templateData?: Record<string, string>;
    now: Date;
  },
): Promise<string> {
  const [inserted] = await tx
    .insert(identityEmailHandoffs)
    .values({
      id: input.id,
      purpose: input.purpose,
      sourceOutboxEventId: input.sourceOutboxEventId,
      userId: input.userId,
      destinationEnvelope: null,
      secretEnvelope: null,
      templateData: safeTemplateData(input.templateData ?? {}),
      status: "attention_required",
      attempts: 0,
      availableAt: input.now,
      failureCode: input.failureCode,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: identityEmailHandoffs.id });
  if (inserted) return inserted.id;

  const [existing] = await tx
    .select({ id: identityEmailHandoffs.id })
    .from(identityEmailHandoffs)
    .where(eq(identityEmailHandoffs.sourceOutboxEventId, input.sourceOutboxEventId))
    .limit(1);
  if (!existing) throw new Error("Security email attention record conflict");
  return existing.id;
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
): Promise<
  | "delivered"
  | "already_delivered"
  | "attention_required"
  | "already_attention_required"
> {
  const recovered = await db
    .update(identityEmailHandoffs)
    .set({
      status: "attention_required",
      destinationEnvelope: null,
      secretEnvelope: null,
      failureCode: "delivery_outcome_unknown_retry_limit",
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(identityEmailHandoffs.id, input.handoffId),
        isNull(identityEmailHandoffs.sentAt),
        ne(identityEmailHandoffs.status, "sent"),
        ne(identityEmailHandoffs.status, "attention_required"),
        gte(identityEmailHandoffs.attempts, PROVIDER_SEND_ATTEMPT_LIMIT),
        isNotNull(identityEmailHandoffs.destinationEnvelope),
        or(
          isNull(identityEmailHandoffs.leaseExpiresAt),
          lte(identityEmailHandoffs.leaseExpiresAt, input.now),
        ),
      ),
    )
    .returning({ id: identityEmailHandoffs.id });
  if (recovered.length > 1) throw new Error("Security email delivery failed");
  if (recovered.length === 1) return "attention_required";

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
        ne(identityEmailHandoffs.status, "attention_required"),
        lt(identityEmailHandoffs.attempts, PROVIDER_SEND_ATTEMPT_LIMIT),
        isNotNull(identityEmailHandoffs.destinationEnvelope),
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
      .select({
        sentAt: identityEmailHandoffs.sentAt,
        status: identityEmailHandoffs.status,
      })
      .from(identityEmailHandoffs)
      .where(eq(identityEmailHandoffs.id, input.handoffId))
      .limit(1);
    if (existing?.sentAt) return "already_delivered";
    if (existing?.status === "attention_required") return "already_attention_required";
    throw new Error("Security email handoff is unavailable");
  }

  const binding = (fieldName: "destination" | "secret") => ({
    recordType: HANDOFF_RECORD_TYPE,
    recordId: claimed.id,
    fieldName,
  });
  if (!claimed.destinationEnvelope) throw new Error("Security email destination is unavailable");
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
    const ownershipGuard = and(
      eq(identityEmailHandoffs.id, input.handoffId),
      isNull(identityEmailHandoffs.sentAt),
      eq(identityEmailHandoffs.status, "processing"),
      eq(identityEmailHandoffs.attempts, claimed.attempts),
      eq(identityEmailHandoffs.lockedAt, input.now),
      eq(identityEmailHandoffs.lockedBy, input.workerId),
    );
    if (claimed.attempts >= PROVIDER_SEND_ATTEMPT_LIMIT) {
      const terminal = await db
        .update(identityEmailHandoffs)
        .set({
          status: "attention_required",
          destinationEnvelope: null,
          secretEnvelope: null,
          failureCode: "delivery_outcome_unknown_retry_limit",
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: input.now,
        })
        .where(ownershipGuard)
        .returning({ id: identityEmailHandoffs.id });
      if (terminal.length !== 1) throw new Error("Security email delivery failed");
      return "attention_required";
    }

    const retryable = await db
      .update(identityEmailHandoffs)
      .set({
        status: "failed",
        failureCode: "delivery_outcome_unknown",
        availableAt: new Date(input.now.getTime() + UNKNOWN_OUTCOME_RETRY_DELAY_MS),
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(ownershipGuard)
      .returning({ id: identityEmailHandoffs.id });
    if (retryable.length !== 1) throw new Error("Security email delivery failed");
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
        isNull(identityEmailHandoffs.sentAt),
        eq(identityEmailHandoffs.status, "processing"),
        eq(identityEmailHandoffs.attempts, claimed.attempts),
        eq(identityEmailHandoffs.lockedAt, input.now),
        eq(identityEmailHandoffs.lockedBy, input.workerId),
      ),
    )
    .returning({ id: identityEmailHandoffs.id });
  if (sent.length !== 1) throw new Error("Security email delivery failed");
  return "delivered";
}
