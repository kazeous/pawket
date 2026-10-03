import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCommissionFileAttachmentPort } from "../src/index.js";
import { createCommissionFileFixture, fixtureAt, fixtureKeyring } from "./file-fixture.js";

const fixture = createCommissionFileFixture("attach");
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);
const port = createCommissionFileAttachmentPort({ keyring: fixtureKeyring, mode: "enabled" });

describe("commission file attachment port", () => {
  test("attaches clean files in order and describes them per viewer", async () => {
    const o = await fixture.order();
    const first = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, name: "a.png" });
    const second = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, name: "b.pdf", detectedType: "pdf" });
    await expect(fixture.db.transaction((tx) => port.attachBriefFiles(tx, { orderId: o.orderId, buyerUserId: o.buyerUserId, packageId: o.packageId, fileIds: [second, first], at: fixtureAt }))).resolves.toBe("attached");
    const buyerView = await fixture.db.transaction((tx) => port.describeBriefFiles(tx, { orderId: o.orderId, viewer: "buyer", withdrawn: false }));
    expect(buyerView.map((file) => [file.fileId, file.name, file.availability, file.previewable])).toEqual([[second, "b.pdf", "available", false], [first, "a.png", "available", true]]);
    const withdrawn = await fixture.db.transaction((tx) => port.describeBriefFiles(tx, { orderId: o.orderId, viewer: "creator", withdrawn: true }));
    expect(withdrawn.every((file) => file.name === null && file.availability === "withdrawn" && !file.previewable)).toBe(true);
  });
  test.each(["scanning", "foreign", "other_package", "duplicate", "already_attached"] as const)("refuses a %s file without partial writes", async (kind) => {
    const o = await fixture.order(); const other = await fixture.order();
    const ok = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
    const bad = kind === "scanning" ? await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "scanning" })
      : kind === "foreign" ? await fixture.file({ ownerUserId: other.buyerUserId, packageId: o.packageId })
      : kind === "other_package" ? await fixture.file({ ownerUserId: o.buyerUserId, packageId: other.packageId })
      : kind === "duplicate" ? ok
      : await (async () => { const id = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId }); await fixture.attach(id, o.orderId, 5); return id; })();
    const result = await fixture.db.transaction(async (tx) => {
      const outcome = await port.attachBriefFiles(tx, { orderId: o.orderId, buyerUserId: o.buyerUserId, packageId: o.packageId, fileIds: [ok, bad], at: fixtureAt });
      if (outcome !== "attached") tx.rollback();
      return outcome;
    }).catch(() => "rolled_back");
    expect(result).toBe("rolled_back");
    expect((await fixture.read(ok)).state).toBe("clean");
  });
  test("reports disabled mode only when files are named", async () => {
    const disabled = createCommissionFileAttachmentPort({ keyring: fixtureKeyring, mode: "disabled" }); const o = await fixture.order();
    await expect(fixture.db.transaction((tx) => disabled.attachBriefFiles(tx, { orderId: o.orderId, buyerUserId: o.buyerUserId, packageId: o.packageId, fileIds: [], at: fixtureAt }))).resolves.toBe("attached");
    const id = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
    await expect(fixture.db.transaction((tx) => disabled.attachBriefFiles(tx, { orderId: o.orderId, buyerUserId: o.buyerUserId, packageId: o.packageId, fileIds: [id], at: fixtureAt }))).resolves.toBe("disabled");
  });
});
