import { createHash } from "node:crypto";

import { decryptSensitiveField } from "@pawket/security";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createSePayInboxService, SEPAY_EVENT_RECEIVED } from "../src/sepay-inbox-service.js";
import { createSePayIntegrationFixture, fixtureKeyring, schema } from "./sepay-integration-fixture.js";

const fixture = createSePayIntegrationFixture("inbox");
beforeAll(fixture.initialize, 30_000);
afterAll(fixture.dispose, 30_000);

describe("SePay durable authenticated inbox", () => {
  test("encrypts original accepted bytes and commits one source, processing row and outbox event under concurrent replay", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect();
    const event = creator.event("PW0123456789ABCDEF0123");
    const request = creator.signed(connected.connection.id, connected.secret, event);
    await Promise.all(Array.from({ length: 6 }, () => creator.inbox.receive(request)));
    const rows = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ providerEventId: event.id, disposition: "accepted", payloadDigest: `sha256:${createHash("sha256").update(request.rawBody).digest("hex")}` });
    expect(JSON.stringify(row)).not.toContain(creator.accountNumber);
    expect(row.normalizedFacts).toEqual({ amountVnd: 50_000, occurredAt: creator.now().toISOString(), referenceHash: expect.stringMatching(/^hmac-sha256:/), referenceStatus: "exact" });
    expect(decryptSensitiveField({ keyring: fixtureKeyring, binding: { recordType: "sepay_inbox", recordId: row.id, fieldName: "raw_body" }, envelope: row.rawEnvelope! })).toBe(request.rawBody.toString("utf8"));
    expect(await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, row.id))).toMatchObject([{ status: "pending", attempts: 0, version: 1 }]);
    expect(await fixture.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.eventType, SEPAY_EVENT_RECEIVED), eq(schema.systemOutbox.aggregateId, row.id)))).toMatchObject([{ payload: { inboxId: row.id } }]);
    expect(creator.provider.readback).not.toHaveBeenCalled();
  });

  test("quarantines contradictory event identity once without overwriting the first accepted payload", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect();
    const event = creator.event("PW0123456789ABCDEF0123");
    const original = creator.signed(connected.connection.id, connected.secret, event);
    await creator.inbox.receive(original);
    for (const amount of [60_000, 70_000, 80_000]) {
      await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, { ...event, transferAmount: amount }));
    }
    const [row] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
    expect(row?.payloadDigest).toBe(`sha256:${createHash("sha256").update(original.rawBody).digest("hex")}`);
    expect(await fixture.db.select().from(schema.paymentsSepayInboxConflicts).where(eq(schema.paymentsSepayInboxConflicts.inboxId, row!.id))).toHaveLength(1);
    expect((await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, row!.id)))[0]).toMatchObject({ status: "review_required", lastErrorCode: "contradictory_replay", leaseOwner: null });
    expect(await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, row!.id))).toHaveLength(1);
  });

  test.each([
    ["outgoing", { transferType: "out" }], ["non_pawket", { code: null, content: "Private unrelated transfer" }], ["mock", { id: "0" }],
  ] as const)("persists only minimal %s metadata and no worker event", async (reason, patch) => {
    const creator = await fixture.creator(); const connected = await creator.connect();
    await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, creator.event("PW0123456789ABCDEF0123", patch)));
    const [row] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
    expect(row).toMatchObject({ disposition: "ignored", rawEnvelope: null, normalizedFacts: { reason } });
    expect(JSON.stringify(row)).not.toContain(creator.accountNumber);
    expect(await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, row!.id))).toHaveLength(0);
    expect((await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, row!.id)))[0]?.status).toBe("ignored");
  });

  test("rejects invalid authentication, disabled ingress, another environment and a disconnected binding before persistence", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect();
    const request = creator.signed(connected.connection.id, connected.secret, creator.event("PW0123456789ABCDEF0123"));
    await expect(creator.inbox.receive({ ...request, signature: `sha256=${"0".repeat(64)}` })).rejects.toMatchObject({ code: "invalid_authentication" });
    await expect(createSePayInboxService({ ...creator.common, enabled: false }).receive(request)).rejects.toMatchObject({ code: "not_available" });
    await expect(createSePayInboxService({ ...creator.common, enabled: true, environment: "live" }).receive(request)).rejects.toMatchObject({ code: "not_available" });
    await creator.change("disconnect");
    await expect(creator.inbox.receive(request)).rejects.toMatchObject({ code: "not_available" });
    expect(await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id))).toHaveLength(0);
  });

  test("an outbox write failure cannot acknowledge or leave a half-written inbox, and a later retry succeeds", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect();
    const request = creator.signed(connected.connection.id, connected.secret, creator.event("PW0123456789ABCDEF0123"));
    // Fault injection belongs only to this disposable schema and the accepted-event topic.
    await fixture.client.unsafe(`create function reject_sepay_test_outbox() returns trigger language plpgsql as $$ begin
      if NEW.event_type = 'payments.sepay_event_received.v1' then raise exception 'synthetic outbox unavailable'; end if;
      return NEW; end $$`);
    await fixture.client.unsafe("create trigger reject_sepay_test_outbox before insert on system_outbox for each row execute function reject_sepay_test_outbox()");
    try {
      await expect(creator.inbox.receive(request)).rejects.toThrow();
      expect(await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id))).toHaveLength(0);
    } finally {
      await fixture.client.unsafe("drop trigger reject_sepay_test_outbox on system_outbox");
      await fixture.client.unsafe("drop function reject_sepay_test_outbox()");
    }
    await creator.inbox.receive(request);
    expect(await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id))).toHaveLength(1);
  });

  test("caps authenticated new-event storage while retaining safe duplicate acknowledgements", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect();
    const original = creator.signed(connected.connection.id, connected.secret, creator.event("PW0123456789ABCDEF0123", { id: "1" }));
    await creator.inbox.receive(original);
    for (let id = 2; id <= 120; id += 1) {
      await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, creator.event("PW0123456789ABCDEF0123", { id: String(id) })));
    }
    await expect(creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, creator.event("PW0123456789ABCDEF0123", { id: "121" })))).rejects.toMatchObject({ code: "rate_limited" });
    await expect(creator.inbox.receive(original)).resolves.toBe("duplicate");
    expect(await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id))).toHaveLength(120);
  }, 20_000);
});
