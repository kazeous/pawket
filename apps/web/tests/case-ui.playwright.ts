import path from "node:path";
import { readdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { buildCaseFixture } from "./case-fixture-build";
import { caseFixture, caseId, fileId } from "./case-fixture-data";
const webRoot = path.resolve(import.meta.dirname, "..");
let bundle: string; let stylesheetLinks: string;
test.beforeAll(async () => {
  bundle = await buildCaseFixture();
  stylesheetLinks = (await readdir(path.join(webRoot, ".next", "static", "css"))).filter((file) => file.endsWith(".css")).map((file) => `<link rel="stylesheet" href="/_next/static/css/${file}">`).join("");
});
async function open(page: Page, surface = "dispute") {
  await page.clock.install({ time: new Date("2026-10-08T00:00:00Z") });
  await page.route(`**/api/v1/admin/cases/${caseId}`, (route) => route.fulfill({ json: { case: caseFixture } }));
  await page.route("**/__tests/case.js", (route) => route.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.route("**/__tests/case?*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vụ việc</title>${stylesheetLinks}</head><body><div id="fixture"></div><script src="/__tests/case.js"></script></body></html>` }));
  await page.goto(`/__tests/case?surface=${surface}`); await expect(page.getByRole("heading", { name: "Khiếu nại & hoàn tiền", exact: true })).toBeVisible();
}
for (const width of [375, 1440]) test(`owner detail is accessible without overflow at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await open(page);
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((row) => ["serious", "critical"].includes(row.impact ?? ""))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Nhật ký truy cập", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Nhật ký truy cập", exact: true })).toBeVisible();
});
test("evidence and file grant are explicit POSTs and the grant never enters markup or storage", async ({ page }) => {
  let reads = 0; let downloads = 0;
  await page.route(`**/api/v1/admin/cases/${caseId}/evidence`, (route) => { reads++;
    expect(route.request().method()).toBe("POST"); expect(route.request().postDataJSON()).toEqual({ section: "order_summary" });
    expect(route.request().headers()["x-pawket-actor"]).toBe("synthetic-owner");
    return route.fulfill({ json: { evidence: { brief: { text: "Synthetic private evidence" }, referenceFiles: [{ fileId, name: "Synthetic attachment", availability: "available" }] } } });
  });
  await page.route(`**/api/v1/admin/cases/${caseId}/files/${fileId}`, (route) => { downloads++;
    expect(route.request().postDataJSON()).toEqual({ disposition: "attachment" }); return route.fulfill({ json: { url: "https://example.invalid/synthetic-file" } });
  });
  await page.addInitScript(() => { window.open = () => null; });
  await open(page); expect(reads).toBe(0); expect(downloads).toBe(0);
  await page.getByRole("button", { name: "Xem bằng chứng", exact: true }).click(); await expect(page.getByText("Synthetic private evidence", { exact: true })).toBeVisible();
  expect(reads).toBe(1); expect(downloads).toBe(0); await page.getByRole("button", { name: "Tải tệp", exact: true }).click();
  await expect.poll(() => downloads).toBe(1);
  expect(await page.evaluate(() => document.body.innerHTML.includes("https://example.invalid/synthetic-file") || Object.values(localStorage).some((value) => value.includes("synthetic-file")) || Object.values(sessionStorage).some((value) => value.includes("synthetic-file")))).toBe(false);
});
test("ruling complete choices are disabled before delivery and partial amount is bounded after delivery", async ({ page }) => {
  await open(page); const outcome = page.locator('select[name="outcome"]');
  await expect(outcome.locator('option[value="complete_none"]')).toBeDisabled(); await expect(outcome.locator('option[value="complete_partial"]')).toBeDisabled();
  await page.goto("/__tests/case?surface=delivered"); await outcome.selectOption("complete_partial"); const amount = page.getByLabel("Số tiền hoàn (VND) bắt buộc", { exact: true });
  await expect(amount).toHaveAttribute("min", "1"); await expect(amount).toHaveAttribute("max", "499999");
});
test("freeze requires acknowledgement and uses the creator-scoped endpoint", async ({ page }) => {
  let frozen = false;
  await page.route("**/api/v1/admin/creators/synthetic-creator/freeze", (route) => { frozen = true; expect(route.request().postDataJSON().reason === "Synthetic reason").toBe(true); return route.fulfill({ json: { closedOrders: 1 } }); });
  await open(page); const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Đóng băng thực hiện đơn" }) });
  await form.getByLabel("Lý do bắt buộc", { exact: true }).fill("Synthetic reason"); await form.getByRole("button", { name: "Đóng băng thực hiện đơn" }).click(); expect(frozen).toBe(false);
  await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Đóng băng thực hiện đơn" }).click(); await expect.poll(() => frozen).toBe(true);
});
test("aging tab fetches only on demand and exposes the three approved fields", async ({ page }) => {
  let reads = 0; await page.route("**/api/v1/admin/refunds/aging", (route) => { reads++; return route.fulfill({ json: { refunds: [{ orderId: caseId, amountVnd: 100_000, ageDays: 31, buyerUserId: "hidden-synthetic-buyer" }] } }); });
  await open(page, "queue"); expect(reads).toBe(0); await page.getByRole("button", { name: "Hoàn tiền chờ tài khoản", exact: true }).click(); await page.clock.runFor(10);
  await expect(page.getByText("100.000 ₫ · 31 ngày", { exact: true })).toBeVisible(); expect((await page.textContent("body"))?.includes("hidden-synthetic-buyer")).toBe(false);
});
