import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres, { type Sql as ConnectionSql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSePayIntegrationFixture, fixtureEnvelope, fixtureHash, schema } from "../../payments/tests/sepay-integration-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for commission threads schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Commission threads schema tests require a dedicated local test database");
}
const fixture = createSePayIntegrationFixture("commission_threads_schema");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const at = new Date("2026-09-26T04:00:00Z");
const confirmedAt = new Date(at.getTime() + 1_000);
const deliveredAt = new Date(at.getTime() + 10 * 86_400_000);
const completedAt = new Date(deliveredAt.getTime() + 1_000);
const envelope = (type: string, id: string, field: string) => JSON.stringify(fixtureEnvelope(type, id, field, "Synthetic private text"));
type Sql = TransactionSql;

async function expectSqlState(operation: PromiseLike<unknown>, code: string, message?: string) {
  try { await operation; } catch (error) {
    expect((error as { code: string }).code).toBe(code);
    if (message) expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function packageFixture(revisionAllowance = 2) {
  const creator = await fixture.creator(); const creatorUserId = creator.actor.userId;
  const buyerUserId = `i7-buyer-${randomUUID()}`;
  const packageId = randomUUID(); const packageRevisionId = randomUUID(); const pageId = randomUUID();
  await fixture.db.insert(schema.identityUsers).values({ id: buyerUserId, name: "Synthetic buyer", email: `${buyerUserId}@example.invalid`, canonicalEmail: `${buyerUserId}@example.invalid`, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorCommissionSettings).values({ creatorUserId, enabled: true, capacityLimit: 1, createdAt: at, updatedAt: at });
  const terms = { amountVnd: 50_000, turnaroundDays: 7, revisionAllowance, reviewWindowDays: 7,
    scope: "Portrait", deliverables: "Artwork", usageRights: "Personal", artistTerms: "Synthetic terms", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
  const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "fixed_immediate" as const, briefInstructions: "Describe the portrait", terms, showcaseId: null };
  await fixture.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1,
    ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId }).where(eq(schema.commissionPackages.id, packageId));
  return { creatorUserId, buyerUserId, packageId, packageRevisionId, revisionAllowance, accountVersionId: creator.accountVersionId };
}
type Package = Awaited<ReturnType<typeof packageFixture>>;
async function pendingOrder(p: Package) {
  const orderId = randomUUID(); const intentId = randomUUID(); const referenceHash = fixtureHash();
  const expiry = new Date(at.getTime() + 86_400_000).toISOString();
  await fixture.client.begin(async (tx) => {
    await tx`insert into commission_orders (id, creator_user_id, buyer_user_id, package_id, package_revision_id, route, state, amount_vnd, accepted_at, expires_at, created_at, updated_at)
      values (${orderId}, ${p.creatorUserId}, ${p.buyerUserId}, ${p.packageId}, ${p.packageRevisionId}, 'fixed_immediate', 'awaiting_payment', 50000, ${at.toISOString()}, ${expiry}, ${at.toISOString()}, ${at.toISOString()})`;
    await tx`insert into commission_briefs (order_id, text_envelope, links_envelope, buyer_session_id, request_id, created_at)
      values (${orderId}, ${envelope("commission_briefs", orderId, "text")}::jsonb, ${envelope("commission_briefs", orderId, "links")}::jsonb, 'synthetic-buyer', ${randomUUID()}, ${at.toISOString()})`;
    for (const role of ["buyer", "creator"] as const) await tx`insert into commission_acceptances (id, order_id, actor_user_id, actor_session_id, role, package_revision_id, policy_revision_id, request_id, accepted_at)
      values (${randomUUID()}, ${orderId}, ${role === "buyer" ? p.buyerUserId : p.creatorUserId}, ${`synthetic-${role}`}, ${role}, ${p.packageRevisionId}, ${schema.COMMISSION_POLICY_BOOTSTRAP_ID}, ${randomUUID()}, ${at.toISOString()})`;
    await tx`insert into commission_terms_snapshots (order_id, package_revision_id, policy_revision_id, amount_vnd, turnaround_days, revision_allowance, review_window_days,
      scope_envelope, deliverables_envelope, usage_rights_envelope, artist_terms_envelope, buyer_accepted_at, creator_accepted_at, created_at)
      values (${orderId}, ${p.packageRevisionId}, ${schema.COMMISSION_POLICY_BOOTSTRAP_ID}, 50000, 7, ${p.revisionAllowance}, 7,
      ${envelope("commission_terms_snapshots", orderId, "scope")}::jsonb, ${envelope("commission_terms_snapshots", orderId, "deliverables")}::jsonb,
      ${envelope("commission_terms_snapshots", orderId, "usage_rights")}::jsonb, ${envelope("commission_terms_snapshots", orderId, "artist_terms")}::jsonb,
      ${at.toISOString()}, ${at.toISOString()}, ${at.toISOString()})`;
    await tx`insert into commission_reservations (order_id, creator_user_id, reserved_at) values (${orderId}, ${p.creatorUserId}, ${at.toISOString()})`;
    await event(tx, orderId, 1, "awaiting_payment", at);
    await tx`insert into payment_intents (id, purpose, commission_order_id, creator_user_id, amount_vnd, reference_hash, reference_envelope, destination_envelope, account_version_id, abuse_key_hash, expires_at, request_id, created_at, updated_at)
      values (${intentId}, 'commission', ${orderId}, ${p.creatorUserId}, 50000, ${referenceHash}, ${envelope("payment_intents", intentId, "transfer_reference")}::jsonb,
      ${envelope("payment_intents", intentId, "destination")}::jsonb, ${p.accountVersionId}, ${fixtureHash()}, ${expiry}, ${randomUUID()}, ${at.toISOString()}, ${at.toISOString()})`;
  });
  return { ...p, orderId, intentId, referenceHash };
}
async function paidOrder(p?: Package) {
  const f = await pendingOrder(p ?? await packageFixture());
  await fixture.client.begin(async (tx) => {
    await tx`insert into payment_confirmations (id, payment_intent_id, creator_user_id, account_version_id, observed_amount_vnd, reference_hash, bank_transaction_fingerprint,
      attested_received, actor_session_id, primary_authenticated_at, confirmed_at, request_id, idempotency_key_hash)
      values (${randomUUID()}, ${f.intentId}, ${f.creatorUserId}, ${f.accountVersionId}, 50000, ${f.referenceHash}, ${fixtureHash()},
      true, 'synthetic-creator', ${confirmedAt.toISOString()}, ${confirmedAt.toISOString()}, ${randomUUID()}, ${fixtureHash()})`;
    await tx`update payment_intents set state = 'confirmed', closed_at = ${confirmedAt.toISOString()}, updated_at = ${confirmedAt.toISOString()} where id = ${f.intentId}`;
    await tx`update commission_orders set state = 'in_progress', version = 2, confirmed_at = ${confirmedAt.toISOString()}, due_at = ${new Date(confirmedAt.getTime() + 7 * 86_400_000).toISOString()}, updated_at = ${confirmedAt.toISOString()} where id = ${f.orderId}`;
    await tx`update commission_reservations set state = 'occupied', occupied_at = ${confirmedAt.toISOString()} where order_id = ${f.orderId}`;
    await event(tx, f.orderId, 2, "in_progress", confirmedAt);
  });
  return f;
}
async function event(tx: Sql, orderId: string, version: number, state: string, time: Date) {
  await tx`insert into commission_events (id, order_id, order_version, type, request_id, occurred_at)
    values (${randomUUID()}, ${orderId}, ${version}, ${state}, ${randomUUID()}, ${time.toISOString()})`;
}

type Order = Awaited<ReturnType<typeof paidOrder>>;
type FileContext = "brief" | "thread" | "submission";
async function newFile(f: Order, context: FileContext = "submission", bytes = 3, ownerUserId = f.creatorUserId, connection: ConnectionSql | Sql = fixture.client) {
  const id = randomUUID();
  // Bind serialized JSON as text: Drizzle and standalone postgres clients use different JSONB serializers.
  await connection`insert into commission_files (id, owner_user_id, context, package_id, upload_order_id, declared_bytes, filename_envelope,
    object_key, upload_expires_at, request_id, created_at, updated_at)
    values (${id}, ${ownerUserId}, ${context}, ${context === "brief" ? f.packageId : null}, ${context === "brief" ? null : f.orderId}, ${bytes},
    ${JSON.stringify(fixtureEnvelope("commission_files", id, "filename", "Synthetic artwork"))}::text::jsonb, ${`commission/${id}`},
    ${new Date(at.getTime() + 900_000).toISOString()}, ${randomUUID()}, ${at.toISOString()}, ${at.toISOString()})`;
  return id;
}
async function cleanFile(id: string, type = "png") {
  await fixture.client`update commission_files set state = 'scanning', uploaded_at = ${at.toISOString()},
    scan_deadline_at = ${new Date(at.getTime() + 86_400_000).toISOString()}, version = version + 1 where id = ${id}`;
  await fixture.client`update commission_files set state = 'clean', detected_type = ${type}, sha256 = ${`sha256:${"a".repeat(64)}`},
    clean_version_id = 'synthetic-clean', clean_at = ${confirmedAt.toISOString()}, version = version + 1, updated_at = ${confirmedAt.toISOString()} where id = ${id}`;
}
async function thread(orderId: string) {
  await fixture.client`insert into commission_threads (order_id, created_at, updated_at) values (${orderId}, ${at.toISOString()}, ${at.toISOString()})`;
}
async function entry(tx: Sql, orderId: string, kind: string, id: string) {
  const [row] = await tx`update commission_threads set next_sequence = next_sequence + 1, updated_at = ${deliveredAt.toISOString()}
    where order_id = ${orderId} returning next_sequence - 1 as sequence`;
  await tx`insert into commission_thread_entries (order_id, sequence, kind, entry_id, created_at)
    values (${orderId}, ${row!.sequence}, ${kind}, ${id}, ${deliveredAt.toISOString()})`;
}
async function message(tx: Sql, f: Order, options: { text?: boolean; authorUserId?: string; omitEntry?: boolean } = {}) {
  const id = randomUUID();
  await tx`insert into commission_messages (id, order_id, author_user_id, author_session_id, text_envelope, request_id, created_at)
    values (${id}, ${f.orderId}, ${options.authorUserId ?? f.buyerUserId}, 'synthetic-session',
    ${options.text === false ? null : envelope("commission_messages", id, "text")}::jsonb, ${randomUUID()}, ${deliveredAt.toISOString()})`;
  if (!options.omitEntry) await entry(tx, f.orderId, "message", id);
  return id;
}
async function submission(tx: Sql, f: Order, kind = "draft") {
  const id = randomUUID();
  await tx`insert into commission_submissions (id, order_id, kind, actor_session_id, request_id, submitted_at)
    values (${id}, ${f.orderId}, ${kind}, 'synthetic-creator', ${randomUUID()}, ${deliveredAt.toISOString()})`;
  await entry(tx, f.orderId, "submission", id);
  return id;
}
async function attach(tx: Sql, fileId: string, orderId: string, kind: string, targetId: string, position = 0) {
  await tx`update commission_files set state = 'attached', order_id = ${orderId}, attached_at = ${deliveredAt.toISOString()},
    updated_at = ${deliveredAt.toISOString()}, version = version + 1 where id = ${fileId}`;
  await tx`insert into commission_file_attachments (file_id, order_id, target_kind, target_id, position, attached_at)
    values (${fileId}, ${orderId}, ${kind}, ${targetId}, ${position}, ${deliveredAt.toISOString()})`;
}
async function bytes(orderId: string) {
  const [row] = await fixture.client`select commission_order_file_bytes(${orderId}::uuid)::bigint as bytes`;
  return Number(row!.bytes);
}

describe("commission threads and file contexts", () => {
  test("a 250 MiB submission file is allowed and a 250 MiB thread file is not", async () => {
    const f = await paidOrder();
    await newFile(f, "submission", 262_144_000);
    await expectSqlState(newFile(f, "thread", 262_144_000), "23514");
    await expectSqlState(newFile(f, "submission", 262_144_001), "23514");
    await newFile(f, "thread", 26_214_400, f.buyerUserId);
  });
  test("a psd type is refused outside the submission context", async () => {
    const f = await paidOrder();
    for (const type of ["psd", "clip", "zip"]) {
      const accepted = await newFile(f); await cleanFile(accepted, type);
      for (const context of ["brief", "thread"] as const) {
        const refused = await newFile(f, context, 3, f.buyerUserId);
        await expectSqlState(cleanFile(refused, type), "23514");
      }
    }
  });
  test("quota trigger refuses the byte past 1 GiB", async () => {
    const f = await paidOrder();
    for (let i = 0; i < 5; i++) await newFile(f, "submission", 209_715_200);
    expect(await bytes(f.orderId)).toBe(1_048_576_000);
    await expectSqlState(newFile(f, "submission", 25_165_825), "23514", "Commission order file quota exceeded");
    await newFile(f, "submission", 25_165_824);
    expect(await bytes(f.orderId)).toBe(1_073_741_824);
  });
  test("two concurrent inserts racing for the last allowance: exactly one commits", async () => {
    const f = await paidOrder();
    for (let i = 0; i < 5; i++) await newFile(f, "submission", 209_715_200);
    const connections = [0, 1].map(() => postgres(databaseUrl!, { max: 1, connection: { search_path: `${fixture.schemaName},public` }, onnotice: () => undefined }));
    let ready = 0; let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    try {
      const results = await Promise.allSettled(connections.map((connection) => connection.begin(async (tx) => {
        await tx`select 1`; // Both separate transactions are live before either insert.
        ready++; if (ready === 2) release();
        await barrier;
        return newFile(f, "submission", 20_000_000, f.creatorUserId, tx);
      })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect((refused.reason as { code: string }).code).toBe("23514");
      expect((refused.reason as Error).message).toBe("Commission order file quota exceeded");
      expect(await bytes(f.orderId)).toBe(1_068_576_000);
    } finally { await Promise.all(connections.map((connection) => connection.end())); }
  });
  test("purged rejected files stop counting", async () => {
    const f = await paidOrder(); const id = await newFile(f, "submission", 262_144_000);
    expect(await bytes(f.orderId)).toBe(262_144_000);
    await fixture.client`update commission_files set state = 'scanning', uploaded_at = ${at.toISOString()},
      scan_deadline_at = ${new Date(at.getTime() + 86_400_000).toISOString()}, version = version + 1 where id = ${id}`;
    await fixture.client`update commission_files set state = 'rejected', rejection_reason = 'type_not_allowed', ended_at = ${confirmedAt.toISOString()}, version = version + 1 where id = ${id}`;
    expect(await bytes(f.orderId)).toBe(262_144_000);
    await fixture.client`update commission_files set quarantine_purged_at = ${confirmedAt.toISOString()}, version = version + 1 where id = ${id}`;
    expect(await bytes(f.orderId)).toBe(262_144_000);
    await fixture.client`update commission_files set clean_purged_at = ${confirmedAt.toISOString()}, version = version + 1 where id = ${id}`;
    expect(await bytes(f.orderId)).toBe(0);
  });
  test("a closed copy-intent row no longer counts toward the order quota", async () => {
    const f = await paidOrder(); const copyBytes = 209_715_200; const quotaBytes = 1_073_741_824;
    const id = await newFile(f, "submission", copyBytes);
    for (let i = 0; i < 4; i++) await newFile(f, "submission", copyBytes);
    await newFile(f, "submission", 25_165_824);
    await fixture.client`update commission_files set state = 'scanning', uploaded_at = ${at.toISOString()},
      scan_deadline_at = ${new Date(at.getTime() + 86_400_000).toISOString()}, clean_copy_intent = true,
      updated_at = ${confirmedAt.toISOString()}, version = version + 1 where id = ${id}`;
    await fixture.client`update commission_files set state = 'discarded', ended_at = ${confirmedAt.toISOString()},
      updated_at = ${confirmedAt.toISOString()}, version = version + 1 where id = ${id}`;
    await fixture.client`update commission_files set quarantine_purged_at = ${confirmedAt.toISOString()}, version = version + 1 where id = ${id}`;
    expect(await bytes(f.orderId)).toBe(quotaBytes);
    await expectSqlState(newFile(f, "submission", copyBytes), "23514", "Commission order file quota exceeded");
    const closedAt = new Date(confirmedAt.getTime() + 86_400_000);
    await fixture.client`update commission_files set clean_purged_at = ${closedAt.toISOString()},
      updated_at = ${closedAt.toISOString()}, version = version + 1 where id = ${id}`;
    expect(await fixture.client`select state, clean_copy_intent,
      quarantine_purged_at is not null as quarantine_purged, clean_purged_at is not null as clean_purged,
      ended_at <= updated_at - interval '24 hours' as aged from commission_files where id = ${id}`)
      .toEqual([{ state: "discarded", clean_copy_intent: true, quarantine_purged: true, clean_purged: true, aged: true }]);
    await newFile(f, "submission", copyBytes);
    expect(await bytes(f.orderId)).toBe(quotaBytes);
    await expectSqlState(newFile(f, "submission", 1), "23514", "Commission order file quota exceeded");
  });
  test("quota counts attached brief files and all upload contexts only once", async () => {
    const f = await paidOrder(); const brief = await newFile(f, "brief", 10, f.buyerUserId); await cleanFile(brief);
    await fixture.client.begin(async (tx) => { await attach(tx, brief, f.orderId, "brief", f.orderId); });
    await newFile(f, "thread", 20, f.buyerUserId);
    const file = await newFile(f, "submission", 30); await cleanFile(file); await thread(f.orderId);
    await fixture.client.begin(async (tx) => { const id = await submission(tx, f); await attach(tx, file, f.orderId, "submission", id, 19); });
    expect(await bytes(f.orderId)).toBe(60);
  });
  test.each(["foreign_order", "buyer_submission", "brief_message", "submission_message"])("attachment graph refuses wrong bindings: %s", async (binding) => {
    const f = await paidOrder(); await thread(f.orderId);
    const source = binding === "foreign_order" ? await paidOrder() : f;
    const context = binding === "brief_message" ? "brief" : binding === "buyer_submission" || binding === "submission_message" ? "submission" : "thread";
    const file = await newFile(source, context, binding === "submission_message" ? 26_214_401 : 3, source.buyerUserId); await cleanFile(file);
    await expectSqlState(fixture.client.begin(async (tx) => {
      const targetKind = binding === "buyer_submission" ? "submission" : "message";
      const id = targetKind === "submission" ? await submission(tx, f) : await message(tx, f);
      if (binding === "foreign_order") {
        // Keep the file's order binding valid; the deferred graph must reject the cross-order link.
        await tx`update commission_files set state = 'attached', order_id = ${source.orderId}, attached_at = ${deliveredAt.toISOString()},
          updated_at = ${deliveredAt.toISOString()}, version = version + 1 where id = ${file}`;
        await tx`insert into commission_file_attachments (file_id, order_id, target_kind, target_id, position, attached_at)
          values (${file}, ${f.orderId}, ${targetKind}, ${id}, 0, ${deliveredAt.toISOString()})`;
      } else await attach(tx, file, f.orderId, targetKind, id);
    }), "23514", "Commission file attachment mismatch");
    expect(await fixture.client`select state from commission_files where id = ${file}`).toEqual([{ state: "clean" }]);
    expect(await fixture.client`select count(*)::int as count from commission_file_attachments where file_id = ${file}`).toEqual([{ count: 0 }]);
    expect(await fixture.client`select count(*)::int as count from commission_thread_entries where order_id = ${f.orderId}`).toEqual([{ count: 0 }]);
  });
  test("upload order binding is immutable and attachment must use that order", async () => {
    const f = await paidOrder(); const other = await paidOrder(); const file = await newFile(f, "thread", 3, f.buyerUserId);
    await expectSqlState(fixture.client`update commission_files set upload_order_id = ${other.orderId}, version = version + 1 where id = ${file}`, "23514");
    await cleanFile(file);
    await expectSqlState(fixture.client`update commission_files set state = 'attached', order_id = ${other.orderId}, attached_at = ${deliveredAt.toISOString()},
      updated_at = ${deliveredAt.toISOString()}, version = version + 1 where id = ${file}`, "23514");
  });
  test("a message needs text or an attachment", async () => {
    const f = await paidOrder(); await thread(f.orderId);
    await expectSqlState(fixture.client.begin(async (tx) => { await message(tx, f, { text: false }); }), "23514");
    await fixture.client.begin(async (tx) => { await message(tx, f); });
    const file = await newFile(f, "thread", 3, f.buyerUserId); await cleanFile(file);
    await fixture.client.begin(async (tx) => { const id = await message(tx, f, { text: false }); await attach(tx, file, f.orderId, "message", id); });
  });
  test("only an order party can send a message", async () => {
    const f = await paidOrder(); const other = await paidOrder(); await thread(f.orderId);
    await expectSqlState(fixture.client.begin(async (tx) => { await message(tx, f, { authorUserId: other.buyerUserId }); }), "23514");
    await fixture.client.begin(async (tx) => { await message(tx, f, { authorUserId: f.creatorUserId }); });
  });
  test("messages are refused on a completed order", async () => {
    const f = await paidOrder(); await thread(f.orderId);
    await fixture.client.begin(async (tx) => {
      await submission(tx, f, "final");
      await tx`update commission_orders set state = 'delivered', delivered_at = ${deliveredAt.toISOString()}, review_ends_at = ${new Date(deliveredAt.getTime() + 7 * 86_400_000).toISOString()},
        updated_at = ${deliveredAt.toISOString()}, version = version + 1 where id = ${f.orderId}`;
      await event(tx, f.orderId, 3, "delivered", deliveredAt);
    });
    await fixture.client.begin(async (tx) => { await message(tx, f); });
    await fixture.client.begin(async (tx) => {
      await tx`update commission_orders set state = 'completed', completed_at = ${completedAt.toISOString()}, completion_kind = 'buyer_accepted',
        updated_at = ${completedAt.toISOString()}, version = version + 1 where id = ${f.orderId}`;
      await tx`update commission_reservations set state = 'completed', released_at = ${completedAt.toISOString()} where order_id = ${f.orderId}`;
      await event(tx, f.orderId, 4, "completed", completedAt);
    });
    await expectSqlState(fixture.client.begin(async (tx) => { await message(tx, f); }), "23514");
  });
  test("entries and messages are immutable", async () => {
    const f = await paidOrder(); await thread(f.orderId);
    const id = await fixture.client.begin(async (tx) => message(tx, f));
    await expectSqlState(fixture.client`update commission_messages set request_id = 'changed' where id = ${id}`, "23514");
    await expectSqlState(fixture.client`delete from commission_messages where id = ${id}`, "23514");
    await expectSqlState(fixture.client`update commission_thread_entries set kind = 'submission' where entry_id = ${id}`, "23514");
    await expectSqlState(fixture.client`delete from commission_thread_entries where entry_id = ${id}`, "23514");
  });
  test("thread sequence only advances by one", async () => {
    const f = await paidOrder(); await thread(f.orderId);
    await expectSqlState(fixture.client`update commission_threads set next_sequence = next_sequence + 2 where order_id = ${f.orderId}`, "23514");
    await expectSqlState(fixture.client`update commission_threads set next_sequence = next_sequence - 1 where order_id = ${f.orderId}`, "23514");
    await expectSqlState(fixture.client`update commission_threads set next_sequence = next_sequence + 1, created_at = ${confirmedAt.toISOString()} where order_id = ${f.orderId}`, "23514");
    await expectSqlState(fixture.client`delete from commission_threads where order_id = ${f.orderId}`, "23514");
    await fixture.client`update commission_threads set next_sequence = next_sequence + 1 where order_id = ${f.orderId}`;
  });
  test("messages need an entry and entries need the same-order record and an allocated sequence", async () => {
    const f = await paidOrder(); const other = await paidOrder(); await thread(f.orderId); await thread(other.orderId);
    await expectSqlState(fixture.client.begin(async (tx) => { await message(tx, f, { omitEntry: true }); }), "23514");
    // Create the wrong-order entry together with its message, avoiding the unique-index rejection of a reused entry.
    await expectSqlState(fixture.client.begin(async (tx) => { const id = await message(tx, f, { omitEntry: true }); await entry(tx, other.orderId, "message", id); }), "23514");
    await expectSqlState(fixture.client.begin(async (tx) => { await entry(tx, f.orderId, "submission", randomUUID()); }), "23514");
    await expectSqlState(fixture.client.begin(async (tx) => {
      const id = await message(tx, f, { omitEntry: true });
      await tx`insert into commission_thread_entries (order_id, sequence, kind, entry_id, created_at)
        select order_id, next_sequence, 'message', ${id}, ${deliveredAt.toISOString()} from commission_threads where order_id = ${f.orderId}`;
    }), "23514");
  });
});
