import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createReportFixture, fixtureKeyring, fixtureLookupKey, reportAt } from "../../../packages/trust/tests/report-fixture.js";
import { penaltyContext } from "../../../packages/trust/tests/penalty-service-fixture.js";
import { createWorkerTrustEnforcementConfiguration } from "../src/trust-enforcement-config.js";

const f = createReportFixture("worker_enforcement"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
test("the real disabled worker configuration expires a suspension without step-up", async () => {
  const c = await penaltyContext(f); const onPenaltyFailure = vi.fn();
  await c.service.apply({ ...await c.command(), kind: "suspension", target: "creator_capability", endsAt: new Date(reportAt.getTime() + 1_000).toISOString() });
  const config = createWorkerTrustEnforcementConfiguration({ APP_REVISION: "synthetic-worker", TRUST_ENFORCEMENT_MODE: "disabled",
    COMMISSION_RESOLUTION_MODE: "disabled", VN_BUSINESS_CALENDAR_VERSION: "vn-2026-v1", PII_LOOKUP_HMAC_KEY: Buffer.from(fixtureLookupKey).toString("base64") }, fixtureKeyring);
  const service = config.createService(f.db, onPenaltyFailure);
  expect(await service.runOnce()).toMatchObject({ expired: 1 }); expect(await service.runOnce()).toMatchObject({ expired: 0 });
  expect(onPenaltyFailure).not.toHaveBeenCalled(); expect(c.consume).toHaveBeenCalledOnce();
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("active");
  expect(await f.db.select().from(schema.trustEnforcementPauses).where(isNull(schema.trustEnforcementPauses.endedAt))).toHaveLength(1);
  const resumed = createWorkerTrustEnforcementConfiguration({ APP_REVISION: "synthetic-worker", TRUST_ENFORCEMENT_MODE: "enabled",
    COMMISSION_RESOLUTION_MODE: "disabled", VN_BUSINESS_CALENDAR_VERSION: "vn-2026-v1", PII_LOOKUP_HMAC_KEY: Buffer.from(fixtureLookupKey).toString("base64") }, fixtureKeyring);
  await resumed.createService(f.db, onPenaltyFailure).runOnce();
  expect(await f.db.select().from(schema.trustEnforcementPauses).where(isNull(schema.trustEnforcementPauses.endedAt))).toHaveLength(0);
});
