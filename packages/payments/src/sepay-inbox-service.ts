import { randomUUID } from "node:crypto";
import {
  insertOutboxEvent, paymentsSepayConnections, paymentsSepayConnectionRevisions,
  paymentsSepayInbox, paymentsSepayInboxConflicts, paymentsSepayProcessing,
  type PawketDatabase,
} from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { authenticateAndParseSePayWebhook } from "./sepay-webhook.js";
import { createSePayCryptography, sepayFail, sepayUuid, sepayValidDate } from "./sepay-service-support.js";

export const SEPAY_EVENT_RECEIVED = "payments.sepay_event_received.v1";
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  enabled: boolean; environment: "test" | "live"; now?: () => Date;
}>;
export type SePayIngressRequest = Readonly<{
  connectionId: string; rawBody: Uint8Array; contentType: string | null;
  contentEncoding?: string | null; timestamp: string | null; signature: string | null;
}>;

/** Accepted evidence and its delivery event commit together before acknowledgement. */
export function createSePayInboxService(input: Input) {
  const crypt = createSePayCryptography(input);
  const clock = input.now ?? (() => new Date());
  return {
    async receive(command: SePayIngressRequest): Promise<"accepted" | "ignored" | "duplicate" | "conflict"> {
      if (!input.enabled) sepayFail("not_available");
      if (!sepayUuid(command.connectionId)) sepayFail("not_available");
      const at = clock(); if (!sepayValidDate(at)) sepayFail("dependency_unavailable");
      const [source] = await input.db.select({ connection: paymentsSepayConnections, revision: paymentsSepayConnectionRevisions })
        .from(paymentsSepayConnections).innerJoin(paymentsSepayConnectionRevisions, and(
          eq(paymentsSepayConnections.currentRevisionId, paymentsSepayConnectionRevisions.id),
          eq(paymentsSepayConnections.id, paymentsSepayConnectionRevisions.connectionId),
        )).where(and(eq(paymentsSepayConnections.id, command.connectionId), eq(paymentsSepayConnections.providerEnvironment, input.environment))).limit(1);
      if (!source || source.connection.status === "disconnected") sepayFail("not_available");
      const secret = crypt.decrypt("sepay_connection_revision", source.revision.id, "webhook_secret", source.revision.webhookSecretEnvelope);
      const parsed = authenticateAndParseSePayWebhook({ ...command, secret, now: at });
      const providerEventId = parsed.kind === "accepted" ? parsed.event.id : parsed.providerEventId;
      const payloadDigest = `sha256:${parsed.digest}`;
      return input.db.transaction(async (tx) => {
        // Per-connection serialization also bounds valid flood storage under concurrency.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sepay-ingress:${source.connection.id}`}, 0))`);
        const [current] = await tx.select().from(paymentsSepayConnections).where(eq(paymentsSepayConnections.id, source.connection.id)).limit(1).for("share");
        if (!current || current.currentRevisionId !== source.revision.id || current.version !== source.connection.version || current.status === "disconnected") sepayFail("version_conflict");
        const [prior] = await tx.select().from(paymentsSepayInbox).where(and(eq(paymentsSepayInbox.connectionId, current.id), eq(paymentsSepayInbox.providerEventId, providerEventId))).limit(1);
        if (prior) {
          if (prior.payloadDigest === payloadDigest) return "duplicate" as const;
          // A hostile retry cannot overwrite evidence or create unbounded conflict rows.
          await tx.insert(paymentsSepayInboxConflicts).values({ inboxId: prior.id, payloadDigest, receivedAt: at }).onConflictDoNothing();
          await tx.update(paymentsSepayProcessing).set({ status: "review_required", lastErrorCode: "contradictory_replay", version: sql`${paymentsSepayProcessing.version} + 1`, leaseOwner: null, leaseExpiresAt: null, updatedAt: at })
            .where(and(eq(paymentsSepayProcessing.inboxId, prior.id), sql`${paymentsSepayProcessing.status} not in ('confirmed','dismissed')`));
          return "conflict" as const;
        }
        const [minute] = await tx.select({ value: count() }).from(paymentsSepayInbox).where(and(eq(paymentsSepayInbox.connectionId, current.id), gte(paymentsSepayInbox.receivedAt, new Date(at.getTime() - 60_000))));
        const [total] = await tx.select({ value: count() }).from(paymentsSepayInbox).where(eq(paymentsSepayInbox.connectionId, current.id));
        if ((minute?.value ?? 0) >= 120 || (total?.value ?? 0) >= 100_000) sepayFail("rate_limited");
        const inboxId = randomUUID();
        const facts: Record<string, unknown> = parsed.kind === "accepted" ? {
          amountVnd: parsed.event.amountVnd, occurredAt: parsed.event.occurredAt.toISOString(),
          referenceHash: parsed.event.reference ? crypt.hash("reference", parsed.event.reference) : null,
          referenceStatus: parsed.event.referenceStatus,
        } : { reason: parsed.reason };
        await tx.insert(paymentsSepayInbox).values({
          id: inboxId, connectionId: current.id, connectionRevisionId: source.revision.id, providerEventId,
          payloadDigest, disposition: parsed.kind, normalizedFacts: facts, receivedAt: at,
          rawEnvelope: parsed.kind === "accepted" ? crypt.encrypt("sepay_inbox", inboxId, "raw_body", new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(command.rawBody)) : null,
        });
        await tx.insert(paymentsSepayProcessing).values({ inboxId, status: parsed.kind === "accepted" ? "pending" : "ignored", availableAt: at, updatedAt: at });
        if (parsed.kind === "accepted") await insertOutboxEvent(tx, { eventType: SEPAY_EVENT_RECEIVED, eventVersion: 1, aggregateType: "sepay_inbox", aggregateId: inboxId, payload: { inboxId }, occurredAt: at });
        return parsed.kind;
      });
    },
  };
}
