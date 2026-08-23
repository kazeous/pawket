import { createDatabase, insertOutboxEvent, type NewOutboxEvent } from "../src/index.js";

declare const databaseUrl: string;

const event: NewOutboxEvent = {
  eventType: "type-test.created",
  eventVersion: 1,
  aggregateType: "type-test",
  aggregateId: "type-test-1",
  payload: {},
};

const { db } = createDatabase(databaseUrl);

void db.transaction(async (tx) => {
  await insertOutboxEvent(tx, event);
});

// @ts-expect-error A root database handle cannot replace a caller-owned transaction.
void insertOutboxEvent(db, event);
