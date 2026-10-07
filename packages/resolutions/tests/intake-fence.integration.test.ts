import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createResolutionIntegrationFixture } from "./integration-fixture.js";
import { createCommissionIntakeFencePort } from "../src/intake-fence.js";

const fixture = createResolutionIntegrationFixture("intake");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const obligationId = randomUUID(); const dueAt = new Date("2026-10-10T04:00:00Z");
const refunds = { awaitingSendDeadlines: vi.fn(async () => [{ obligationId, dueAt }]) };
describe("resolution intake fence", () => {
  test("an overdue awaiting_send obligation pauses intake", async () => {
    const fence = createCommissionIntakeFencePort({ mode: "enabled", refunds });
    const at = new Date(dueAt.getTime() + 1);
    expect(await fixture.db.transaction((tx) => fence.isIntakePaused(tx, "synthetic-creator", at))).toBe(true);
    expect(await fixture.db.transaction((tx) => fence.describe(tx, "synthetic-creator", at))).toEqual({ paused: true, overdue: [{ obligationId, dueAt: dueAt.toISOString() }] });
  });
  test("mode disabled never pauses", async () => {
    refunds.awaitingSendDeadlines.mockClear();
    const fence = createCommissionIntakeFencePort({ mode: "disabled", refunds });
    expect(await fixture.db.transaction((tx) => fence.describe(tx, "synthetic-creator", new Date("2026-11-01T04:00:00Z")))).toEqual({ paused: false, overdue: [] });
    expect(refunds.awaitingSendDeadlines).not.toHaveBeenCalled();
  });
  test("a deadline moved by a pause does not pause intake until it passes", async () => {
    const id = randomUUID();
    await fixture.client`insert into commission_resolution_pauses (id, started_at) values (${id}, '2026-10-09T04:00:00Z')`;
    await fixture.client`update commission_resolution_pauses set ended_at = '2026-10-11T04:00:00Z', version = version + 1 where id = ${id}`;
    const fence = createCommissionIntakeFencePort({ mode: "enabled", refunds });
    expect(await fixture.db.transaction((tx) => fence.isIntakePaused(tx, "synthetic-creator", new Date("2026-10-13T03:59:59.999Z")))).toBe(false);
    expect(await fixture.db.transaction((tx) => fence.describe(tx, "synthetic-creator", new Date("2026-10-13T04:00:00.001Z")))).toEqual({ paused: true, overdue: [{ obligationId, dueAt: "2026-10-13T04:00:00.000Z" }] });
  });
});
