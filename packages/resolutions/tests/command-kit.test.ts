import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { PawketDatabase } from "@pawket/database";
import { CommissionError } from "@pawket/orders";
import { createEncryptionKeyring } from "@pawket/security";
import { createResolutionCommandKit } from "../src/command-kit.js";

const key = new Uint8Array(32).fill(19);
function failingKit(error: unknown) {
  const db = { transaction: async () => { throw error; } } as unknown as PawketDatabase;
  return createResolutionCommandKit({ db, lookupHmacKey: key, keyring: createEncryptionKeyring({ activeKeyId: "synthetic", keys: { synthetic: key } }),
    session: { getTipSessionAssurance: async () => null } });
}
async function run(error: unknown) {
  return failingKit(error).mutate({ actor: { userId: "synthetic-buyer", sessionId: "synthetic-session" }, idempotencyKey: randomUUID(), requestId: randomUUID() },
    "propose", [randomUUID()], async () => "synthetic-creator", async () => ({ resultReference: randomUUID(), at: new Date() }));
}
describe("resolution dependency error mapping", () => {
  test.each(["expired", "version_conflict", "invalid_transition"] as const)("Orders %s has an explicit resolution code", async (code) => {
    await expect(run(new CommissionError(code))).rejects.toMatchObject({ code: code === "expired" ? "deadline_passed" : code });
  });
  test.each([false, true])("pending proposal unique index maps proposal_pending (wrapped: %s)", async (wrapped) => {
    const cause = Object.assign(new Error("Synthetic constraint failure"), { code: "23505", constraint_name: "commission_proposals_pending_uidx" });
    await expect(run(wrapped ? new Error("Synthetic database failure", { cause }) : cause)).rejects.toMatchObject({ code: "proposal_pending" });
  });
  test("unrelated unique violations remain dependency_unavailable", async () => {
    await expect(run(Object.assign(new Error("Synthetic constraint failure"), { code: "23505", constraint_name: "unrelated_uidx" })))
      .rejects.toMatchObject({ code: "dependency_unavailable" });
  });
});
