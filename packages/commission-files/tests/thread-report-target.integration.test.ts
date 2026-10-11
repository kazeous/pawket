import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createThreadReportTargetPort } from "../src/thread-report-target.js";
import { createReportFixture } from "./report-target-fixture.js";

const fixture = createReportFixture("thread_target");
beforeAll(fixture.initialize, 60_000); afterAll(fixture.dispose);
test("messages and attached thread files are reportable only by the other participant", async () => {
  const p = await fixture.paidOrder(); const messageId = await fixture.message(p.orderId, p.creator.userId);
  const fileId = await fixture.threadFile(p.orderId, p.creator.userId, messageId); const unrelated = { userId: await fixture.person() };
  const port = createThreadReportTargetPort();
  for (const target of [{ kind: "commission_message" as const, orderId: p.orderId, messageId }, { kind: "commission_file" as const, orderId: p.orderId, fileId }]) {
    expect(await fixture.db.transaction((tx) => port.resolve(tx, target, p.buyer))).toMatchObject({ kind: target.kind, orderId: p.orderId, contentOwnerUserId: p.creator.userId, packageRevisionId: null });
    for (const reporter of [p.creator, unrelated, null]) expect(await fixture.db.transaction((tx) => port.resolve(tx, target, reporter))).toBeNull();
    expect(await fixture.db.transaction((tx) => port.resolve(tx, { ...target, orderId: randomUUID() }, p.buyer))).toBeNull();
  }
  const own = await fixture.message(p.orderId, p.buyer.userId);
  expect(await fixture.db.transaction((tx) => port.resolve(tx, { kind: "commission_message", orderId: p.orderId, messageId: own }, p.buyer))).toBeNull();
  const briefFile = await fixture.file({ ownerUserId: p.buyer.userId, packageId: p.packageId }); await fixture.attach(briefFile, p.orderId);
  expect(await fixture.db.transaction((tx) => port.resolve(tx, { kind: "commission_file", orderId: p.orderId, fileId: briefFile }, p.creator))).toBeNull();
});
