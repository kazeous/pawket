import { expect, test, vi } from "vitest";
import type { PawketTransaction } from "@pawket/database";
import { createCaseEvidencePort } from "../src/platform/case-evidence.js";

test.each(["orderSummary", "threadPage", "resolutionRecords", "fileGrant"] as const)("case evidence adapter %s refuses a null order before calling domain ports", async (member) => {
  const read = vi.fn();
  const input = { orders: { readOrderForCase: read, readThreadForCase: read }, refunds: { listForOrder: read, revealForCase: read },
    view: { readForCase: read }, files: { caseDownloadGrant: read } };
  const port = createCaseEvidencePort(input as unknown as Parameters<typeof createCaseEvidencePort>[0]);
  const tx = {} as PawketTransaction; const orderId = null as unknown as string;
  await expect(member === "fileGrant" ? port.fileGrant(tx, { orderId, fileId: "synthetic-file", disposition: "attachment" })
    : port[member](tx, orderId)).rejects.toMatchObject({ code: "not_available" });
  expect(read).not.toHaveBeenCalled();
});
