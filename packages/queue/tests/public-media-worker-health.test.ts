import { describe, expect, test, vi } from "vitest";

import {
  PUBLIC_MEDIA_WORKER_HEALTH_KEY,
  PUBLIC_MEDIA_WORKER_HEALTH_TTL_MS,
  readPublicMediaWorkerHealth,
  writePublicMediaWorkerHealth,
} from "../src/index.js";

const revision = "9f6ac0e1b2d34567890abcdef1234567890abcde";

describe("public media worker health transport", () => {
  test("writes a revision-bound scan heartbeat with the five-minute availability TTL", async () => {
    const set = vi.fn(async () => "OK");

    await writePublicMediaWorkerHealth(
      { set },
      { revision, scanSucceededAtMs: 1_788_321_600_000 },
    );

    expect(PUBLIC_MEDIA_WORKER_HEALTH_KEY).toBe("pawket:health:public-media-cleanup:v1");
    expect(PUBLIC_MEDIA_WORKER_HEALTH_TTL_MS).toBe(300_000);
    expect(set).toHaveBeenCalledWith(
      PUBLIC_MEDIA_WORKER_HEALTH_KEY,
      JSON.stringify({ revision, scanSucceededAtMs: 1_788_321_600_000 }),
      "PX",
      300_000,
    );
  });

  test("reads only the exact bounded heartbeat shape", async () => {
    const valid = JSON.stringify({ revision, scanSucceededAtMs: 1_788_321_600_000 });

    await expect(readPublicMediaWorkerHealth({ get: vi.fn(async () => valid) })).resolves.toEqual({
      revision,
      scanSucceededAtMs: 1_788_321_600_000,
    });
    for (const value of [
      null,
      "not-json",
      JSON.stringify({ revision, scanSucceededAtMs: -1 }),
      JSON.stringify({ revision, scanSucceededAtMs: 1_788_321_600_000, storageKey: "private" }),
    ]) {
      await expect(
        readPublicMediaWorkerHealth({ get: vi.fn(async () => value) }),
      ).resolves.toBeNull();
    }
  });
});
