import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { build } from "tsup";
import { actorId, fixtureRefund, fixtureResolution, obligationId, orderId, resolutionFormLabels } from "./resolution-fixture-data";

const webRoot = path.resolve(import.meta.dirname, ".."); const outDir = path.join(webRoot, ".playwright-artifacts", "resolution-bundle");
let bundle: string; let stylesheetLinks: string;
test.beforeAll(async () => {
  await build({ entry: [path.join(import.meta.dirname, "resolution-fixture.tsx").replaceAll("\\", "/")], outDir, format: ["iife"], platform: "browser", noExternal: [/.*/],
    tsconfig: path.join(webRoot, "tsconfig.json"), config: false, splitting: false, silent: true, define: { "process.env.NODE_ENV": '"production"' }, esbuildOptions(options) { options.jsx = "automatic"; } });
  bundle = await readFile(path.join(outDir, "resolution-fixture.global.js"), "utf8");
  stylesheetLinks = (await readdir(path.join(webRoot, ".next", "static", "css"))).filter((file) => file.endsWith(".css")).map((file) => `<link rel="stylesheet" href="/_next/static/css/${file}">`).join("");
});
async function open(page: Page, surface = "buyer", view = fixtureResolution(surface)) {
  await page.clock.install({ time: new Date("2026-10-08T12:00:00.000Z") });
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: { user: { id: actorId } } }));
  await page.route("**/resolution", (route) => route.fulfill({ json: view }));
  await page.route("**/__tests/resolution.js", (route) => route.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.route("**/__tests/resolution?*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commission</title>${stylesheetLinks}</head><body><div id="fixture"></div><script src="/__tests/resolution.js"></script></body></html>` }));
  await page.goto(`/__tests/resolution?surface=${surface}`);
  await expect(page.getByRole("heading", { name: "Gặp vấn đề với đơn?" })).toBeVisible();
  await expect(page.getByText("Đang kiểm tra phiên đăng nhập…")).toHaveCount(0);
}
for (const width of [375, 1440]) {
  test(`new resolution panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await expect(page.getByRole("button", { name: "Mở khiếu nại", exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    // Capture only the new panel; retain every existing baseline unchanged.
    await expect(page.locator("[data-resolution-panel]")).toHaveScreenshot(`resolution-panel-${width}.png`, { animations: "disabled", caret: "hide" });
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations.filter((row) => ["serious", "critical"].includes(row.impact ?? ""))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
test("dispute submit requires staff-review acknowledgement and uses the exact API", async ({ page }) => {
  let submitted = false;
  await page.route(`**/commissions/${orderId}/disputes`, async (route) => { submitted = true;
    const body = route.request().postDataJSON(); expect(body.acknowledgeStaffReview).toBe(true); expect(body.expectedVersion).toBe(1);
    expect(route.request().headers()["idempotency-key"]).toBeTruthy(); await route.fulfill({ json: { disputeId: obligationId, caseId: obligationId } });
  });
  await open(page); await page.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
  const form = page.locator("form"); const submit = form.getByRole("button", { name: "Mở khiếu nại", exact: true });
  await form.getByLabel(resolutionFormLabels.statement, { exact: true }).fill("Synthetic"); await expect(submit).toBeDisabled(); expect(submitted).toBe(false);
  await form.getByRole("checkbox", { name: resolutionFormLabels.staffReview, exact: true }).check(); await expect(submit).toBeEnabled(); await submit.click(); await expect.poll(() => submitted).toBe(true);
});
test("creator must reveal again after a send version conflict", async ({ page }) => {
  let sends = 0; let reveals = 0; const next = fixtureResolution("creator");
  await page.route(`**/refunds/${obligationId}/reveal`, async (route) => { reveals += 1; await route.fulfill({ json: { bankName: "Synthetic bank", accountNumber: "000000004321", accountHolder: "SYNTHETIC",
    amountVnd: fixtureRefund.amountVnd, reference: fixtureRefund.reference, qrPayload: "0".repeat(100), dueAt: fixtureRefund.dueAt } }); });
  await page.route(`**/refunds/${obligationId}/send`, async (route) => { sends += 1;
    expect(route.request().postDataJSON().expectedVersion).toBe(sends === 1 ? 1 : 2);
    next.resolution.refunds[0]!.version = 2;
    await route.fulfill(sends === 1 ? { status: 409, json: { code: "version_conflict" } } : { json: { version: 3 } });
  });
  await open(page, "creator", next);
  const details = page.getByRole("region", { name: "Thông tin chuyển hoàn tiền" }); await expect(details).toHaveCount(0);
  await page.getByRole("button", { name: "Xem thông tin chuyển hoàn tiền" }).click(); await expect(details).toBeVisible();
  await details.getByLabel(resolutionFormLabels.transferDate, { exact: true }).fill("2026-10-08"); await details.getByLabel(resolutionFormLabels.bankReference, { exact: true }).fill("SYNTHETIC");
  await page.getByRole("button", { name: "Ghi nhận đã chuyển" }).click(); await expect(details).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ghi nhận đã chuyển" })).toHaveCount(0); expect(reveals).toBe(1);
  await page.getByRole("button", { name: "Xem thông tin chuyển hoàn tiền" }).click(); await expect(details).toBeVisible(); expect(reveals).toBe(2);
  await details.getByLabel(resolutionFormLabels.transferDate, { exact: true }).fill("2026-10-08"); await details.getByLabel(resolutionFormLabels.bankReference, { exact: true }).fill("SYNTHETIC");
  await page.getByRole("button", { name: "Ghi nhận đã chuyển" }).click(); await expect.poll(() => sends).toBe(2);
});
test("paid closed order retains its thread read-only and displays the D7 notice", async ({ page }) => {
  await page.route(`**/commissions/${orderId}/thread?*`, (route) => route.fulfill({ json: { thread: { items: [], nextBeforeSequence: null, writable: true } } }));
  await page.route(`**/commissions/${orderId}/timeline`, (route) => route.fulfill({ json: { history: { items: [{ version: 2, type: "closed", reason: "cancelled_by_agreement", occurredAt: "2026-10-08T00:00:00.000Z" }], nextBeforeVersion: null } } }));
  await open(page, "closed"); await expect(page.getByText("Đơn đã đóng. Cuộc trò chuyện chỉ còn để xem.", { exact: false })).toBeVisible();
  await expect(page.getByText("Đơn đã hủy nên bạn không còn tải được tệp của nghệ sĩ. Pawket không thể thu hồi các bản bạn đã tải về.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi tin nhắn", exact: true })).toHaveCount(0); await expect(page.getByRole("heading", { name: "Lịch sử", exact: true })).toBeVisible();
});
