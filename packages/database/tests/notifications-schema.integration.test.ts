import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../src/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for notification schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Notification schema tests require a dedicated local test database");
}
const schemaName = `notifications_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
const db = drizzle(client, { schema });
const at = "2026-10-12T00:00:00.000Z";
beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)), migrationsSchema: journalSchema });
}, 30_000);
afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
}, 30_000);

async function refused(operation: PromiseLike<unknown>, code = "23514") {
  try { await operation; } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function user() {
  const id = `notification-test-${randomUUID()}`;
  await db.insert(schema.identityUsers).values({ id, name: "Synthetic user", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid` });
  return id;
}
async function handoff(userId: string, purpose = "notification") {
  const id = randomUUID();
  await client`insert into identity_email_handoffs (id, user_id, purpose, status, failure_code)
    values (${id}, ${userId}, ${purpose}, 'attention_required', 'synthetic-test')`;
  return id;
}
function item(recipientUserId: string, overrides: Record<string, unknown> = {}) {
  const row = { id: randomUUID(), recipient_user_id: recipientUserId, kind: "order_requested", variant: null, category: "orders",
    action_required: true, subject_type: "commission_order", subject_id: randomUUID(), link_path: "/creator/commissions/synthetic-order",
    collapse_key: null, collapsed_count: 1, last_sequence: null, source_key: randomUUID(), email_state: "none", email_due_at: null,
    email_handoff_id: null, created_at: at, updated_at: at, read_at: null, ...overrides };
  return client`insert into notifications ${client(row)}`;
}

describe("notification database boundaries", () => {
  test("pending email requires email_due_at", async () => {
    const id = await user();
    await refused(item(id, { email_state: "pending" }));
    await item(id, { email_state: "pending", email_due_at: at });
    for (const state of ["none", "suppressed"]) await refused(item(id, { email_state: state, email_due_at: at }));
  });
  test("queued email requires a handoff id", async () => {
    const id = await user();
    const handoffId = await handoff(id, "security_notice");
    for (const state of ["queued", "attention_required"]) {
      await refused(item(id, { email_state: state }));
      await item(id, { email_state: state, email_handoff_id: handoffId });
      await refused(item(id, { email_state: state, email_handoff_id: handoffId, email_due_at: at }));
    }
    for (const state of ["none", "pending", "suppressed"]) {
      await refused(item(id, { email_state: state, email_handoff_id: handoffId, email_due_at: state === "pending" ? at : null }));
    }
    await refused(item(id, { email_state: "queued", email_handoff_id: randomUUID() }), "23503");
  });
  test("only one unread collapsed item per recipient and order", async () => {
    const recipient = await user(); const otherRecipient = await user();
    const collapseKey = `messages:${randomUUID()}`; const firstId = randomUUID();
    const collapsed = { kind: "order_messages", category: "messages", collapse_key: collapseKey, last_sequence: 1 };
    await item(recipient, { ...collapsed, id: firstId });
    await refused(item(recipient, collapsed), "23505");
    await item(otherRecipient, collapsed);
    await client`update notifications set read_at = ${at} where id = ${firstId}`;
    await item(recipient, { ...collapsed, last_sequence: 2 });
  });
  test("source key is unique per recipient", async () => {
    const recipient = await user(); const sourceKey = randomUUID();
    await item(recipient, { source_key: sourceKey });
    await refused(item(recipient, { source_key: sourceKey }), "23505");
    await item(await user(), { source_key: sourceKey });
  });
  test("link_path rejects //evil.example and absolute URLs", async () => {
    const recipient = await user();
    for (const path of ["//evil.example", "https://evil.example", "/creator/tips?next=evil", "/creator/#evil", "/", `/${"a".repeat(201)}`]) {
      await refused(item(recipient, { link_path: path }));
    }
    for (const path of ["/commissions/synthetic-order", "/creator/commissions/synthetic-order", "/admin/cases/synthetic-case", "/help/cases", "/creator/tips", "/creator/apply", "/creator"]) {
      await item(recipient, { link_path: path });
    }
  });
  test("handoff purpose accepts notification", async () => {
    const recipient = await user();
    const handoffId = await handoff(recipient);
    await item(recipient, { email_state: "attention_required", email_handoff_id: handoffId });
    await refused(handoff(recipient, "unknown_purpose"));
  });
  test("collapsed count, sequence and read time retain their boundaries", async () => {
    const recipient = await user();
    await refused(item(recipient, { collapsed_count: 0 }));
    await refused(item(recipient, { collapse_key: `messages:${randomUUID()}` }));
    await refused(item(recipient, { last_sequence: 1 }));
    await refused(item(recipient, { collapse_key: "messages:invalid", last_sequence: 1 }));
    await refused(item(recipient, { read_at: "2026-10-11T00:00:00.000Z" }));
    await item(recipient, { read_at: at });
  });
  test("closed enums reject unrecognized values", async () => {
    const recipient = await user();
    for (const field of ["kind", "category", "subject_type", "email_state"]) await refused(item(recipient, { [field]: "unknown" }));
    for (const variant of ["", "A", "with-dash", "a".repeat(41)]) await refused(item(recipient, { variant }));
    await item(recipient, { variant: "request_response" });
  });
  test("preferences only allow optional email categories and have a composite key", async () => {
    const recipient = await user();
    const preference = (category = "orders", channel = "email") => client`insert into notification_preferences (user_id, category, channel, updated_at)
      values (${recipient}, ${category}, ${channel}, ${at})`;
    await preference(); await refused(preference(), "23505");
    for (const category of ["tips", "account", "unknown"]) await refused(preference(category));
    await refused(preference("messages", "sms"));
    await preference("messages");
  });
  test("reminders deduplicate the effective deadline and validate clock and stage", async () => {
    const subjectId = randomUUID();
    const reminder = (deadline = at, clock = "payment", stage = "due_24h") => client`insert into notification_reminders
      (id, subject_type, subject_id, clock, stage, effective_deadline, created_at)
      values (${randomUUID()}, 'commission_order', ${subjectId}, ${clock}, ${stage}, ${deadline}, ${at})`;
    await reminder(); await refused(reminder(), "23505");
    await reminder("2026-10-13T00:00:00.000Z");
    await reminder(at, "payment", "missed");
    await refused(reminder(at, "unknown")); await refused(reminder(at, "payment", "unknown"));
  });
});
