import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createResolutionIntegrationFixture } from "./integration-fixture.js";
import { effectiveResolutionDeadline } from "../src/deadlines.js";

const fixture = createResolutionIntegrationFixture("deadlines");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const deadline = new Date("2026-10-10T04:00:00Z");
async function paused(endedAt: string | null, run: () => Promise<void>) {
  const id = randomUUID();
  await fixture.client`insert into commission_resolution_pauses (id, started_at) values (${id}, '2026-10-09T04:00:00Z')`;
  if (endedAt !== null) await fixture.client`update commission_resolution_pauses set ended_at = ${endedAt}, version = version + 1 where id = ${id}`;
  try { await run(); } finally {
    if (endedAt === null) await fixture.client`update commission_resolution_pauses set ended_at = '2026-10-11T04:00:00Z', version = version + 1 where id = ${id}`;
  }
}
describe("effective resolution deadlines", () => {
  test("a deadline inside a closed pause moves to resume + 48 h", async () => {
    await paused("2026-10-11T04:00:00Z", async () => {
      expect(await fixture.db.transaction((tx) => effectiveResolutionDeadline(tx, deadline))).toEqual(new Date("2026-10-13T04:00:00Z"));
    });
  });
  test("an open pause returns null", async () => {
    await paused(null, async () => { expect(await fixture.db.transaction((tx) => effectiveResolutionDeadline(tx, deadline))).toBeNull(); });
  });
  test("a deadline before the pause is unchanged", async () => {
    const earlier = new Date("2026-10-08T04:00:00Z");
    await paused("2026-10-11T04:00:00Z", async () => {
      expect(await fixture.db.transaction((tx) => effectiveResolutionDeadline(tx, earlier))).toEqual(earlier);
    });
  });
});
