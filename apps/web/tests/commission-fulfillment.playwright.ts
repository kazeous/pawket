import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createClamdClient, createS3CommissionFileStorage, processCommissionFileScan } from "@pawket/commission-files";
import { commissionFiles, createDatabase } from "@pawket/database";
import { browserDatabaseUrl } from "./increment-three-database";
import { commissionBuyerToken } from "./increment-six-global-setup";
import { tipBrowserHandle, tipBrowserSessionToken } from "./increment-four-global-setup";
import { refreshBrowserSession } from "./oidc-browser-fixture";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const artifacts = path.resolve(import.meta.dirname, "../.playwright-artifacts/increment-six");
const storage = createS3CommissionFileStorage({ endpoint: process.env.COMMISSION_FILES_S3_ENDPOINT ?? "http://127.0.0.1:9090", region: "us-east-1",
  accessKeyId: process.env.COMMISSION_FILES_S3_ACCESS_KEY_ID ?? "local-commission-files-key", secretAccessKey: process.env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY ?? "local-commission-files-secret",
  quarantineBucket: process.env.COMMISSION_FILES_QUARANTINE_BUCKET ?? "pawket-commission-quarantine", cleanBucket: process.env.COMMISSION_FILES_CLEAN_BUCKET ?? "pawket-commission-clean", forcePathStyle: true });
const scanner = createClamdClient({ host: process.env.COMMISSION_FILES_CLAMD_HOST ?? "127.0.0.1", port: Number(process.env.COMMISSION_FILES_CLAMD_PORT ?? "3310"), timeoutMs: 60_000 });
const freshScanner = { scan: scanner.scan, version: async () => ({ ...(await scanner.version()), signatureDate: new Date() }) };

async function signIn(page: Page, token: string) {
  await refreshBrowserSession(token);
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function paidOrder(page: Page, buyer: number) {
  await signIn(page, commissionBuyerToken(buyer));
  const data = await (await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`)).json();
  const offering = data.packages.find((entry: { route: string }) => entry.route === "fixed_immediate");
  await page.goto(`/creators/${tipBrowserHandle}/commissions/${offering.id}`);
  await page.getByLabel("Mô tả yêu cầu của bạn", { exact: true }).fill("Commission tổng hợp để kiểm thử giao bài.");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  await page.getByRole("button", { name: "Đặt commission và xem thanh toán", exact: true }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u);
  const orderId = new URL(page.url()).pathname.split("/").at(-1)!;
  const { order } = await (await page.request.get(`/api/v1/commissions/${orderId}`)).json();
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await page.getByLabel("Số tiền thực nhận (VND)", { exact: true }).fill(String(order.payment.amountVnd));
  await page.getByLabel("Nội dung trên giao dịch ngân hàng", { exact: true }).fill(order.payment.reference);
  await page.getByLabel("Mã giao dịch ngân hàng", { exact: true }).fill(`SYNTH-${randomUUID()}`);
  await page.getByRole("checkbox", { name: "Tôi đã kiểm tra đúng số tiền", exact: false }).check();
  await page.getByRole("button", { name: "Xác nhận đã nhận tiền commission", exact: true }).click();
  await expect(page.getByText("Đã xác nhận thanh toán · đang thực hiện", { exact: true })).toBeVisible();
  return orderId;
}
async function scanPending() {
  const database = createDatabase(browserDatabaseUrl);
  try {
    for (let round = 0; round < 20; round++) {
      const files = await database.db.select({ id: commissionFiles.id }).from(commissionFiles).where(eq(commissionFiles.state, "scanning"));
      if (files.length) { for (const file of files) await processCommissionFileScan({ db: database.db, storage, scanner: freshScanner, fileId: file.id }); return; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("No submission file reached scanning");
  } finally { await database.close(); }
}
async function sendSubmission(page: Page, kind: "draft" | "final") {
  const label = kind === "draft" ? "Bản nháp" : "Bản giao cuối";
  const form = page.getByRole("form", { name: label, exact: true });
  await form.getByLabel(label, { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: PNG });
  const live = form.locator('[aria-live="polite"]');
  await expect(live).toContainText("Đang kiểm tra");
  await expect(form.getByRole("button", { name: "Gửi", exact: true })).toBeDisabled();
  await scanPending();
  await expect(live).toContainText("Đã kiểm tra, không phát hiện mã độc đã biết", { timeout: 15_000 });
  await form.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.locator('[data-submission-card]')).toHaveCount(kind === "draft" ? 1 : 2);
}
async function capture(page: Page, state: string) {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect((await new AxeBuilder({ page }).analyze()).violations.length).toBe(0);
    await page.screenshot({ path: path.join(artifacts, `fulfillment-${state}-${width}.png`), fullPage: true });
  }
}

test("full journey", async ({ page }) => {
  const orderId = await paidOrder(page, 12);
  const usedBefore = (await (await page.request.get("/api/v1/creator/commissions/packages")).json()).workspace.settings.used;
  await sendSubmission(page, "draft");
  await signIn(page, commissionBuyerToken(12)); await page.goto(`/commissions/${orderId}`);
  await expect(page.getByRole("button", { name: "Duyệt và tiếp tục", exact: true })).toBeVisible();
  await capture(page, "draft");
  await page.getByRole("button", { name: "Yêu cầu chỉnh sửa (còn 2 lượt)", exact: true }).click();
  const changes = page.getByRole("form", { name: "Yêu cầu chỉnh sửa (còn 2 lượt)", exact: true });
  await expect(changes.getByRole("button", { name: "Gửi", exact: true })).toBeDisabled();
  await changes.getByRole("textbox").fill("Điều chỉnh bố cục theo brief.");
  await changes.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.getByRole("button", { name: "Duyệt và tiếp tục", exact: true })).toHaveCount(0);
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await sendSubmission(page, "final");
  await signIn(page, commissionBuyerToken(12)); await page.goto(`/commissions/${orderId}`);
  await expect(page.getByText(/^Hạn duyệt:/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Yêu cầu chỉnh sửa (còn 1 lượt)", exact: true })).toBeVisible();
  await expect(page.locator('[data-order-state][aria-live="polite"]')).toHaveText("Đã giao, chờ duyệt");
  await expect(page.locator('[data-submission-card]').last().getByRole("img")).toBeVisible();
  const hash = page.locator('[data-submission-card]').last().locator("details");
  await expect(hash).not.toHaveAttribute("open"); await hash.getByText("Mã SHA-256", { exact: true }).click(); await expect(hash).toHaveAttribute("open", "");
  await capture(page, "delivered");
  await page.getByRole("button", { name: "Chấp nhận", exact: true }).click();
  await expect(page.getByText(/^Hoàn tất lúc .*Tệp sẽ bị xóa vào/u)).toBeVisible();
  await expect(page.locator('[data-order-state][aria-live="polite"]')).toHaveText("Hoàn tất");
  await expect(page.getByText("Đơn đã hoàn tất. Cuộc trò chuyện chỉ còn để xem.", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Nhắn cho nghệ sĩ…", { exact: true })).toHaveCount(0);
  await capture(page, "completed");
  let reads = 0; page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith(`/commissions/${orderId}/thread`)) reads++; });
  await page.clock.install(); await page.clock.fastForward(31_000); expect(reads).toBe(0);
  await signIn(page, tipBrowserSessionToken); await page.goto("/creator/commissions/packages");
  const usedAfter = (await (await page.request.get("/api/v1/creator/commissions/packages")).json()).workspace.settings.used;
  expect(usedAfter).toBe(usedBefore - 1);
  await expect(page.getByText(`Đang giữ hoặc sử dụng ${usedAfter}/20 suất. Suất được giữ khi cấp hướng dẫn thanh toán.`, { exact: true })).toBeVisible();
});

test("messages render plain text and poll only while visible", async ({ page }) => {
  await page.clock.install();
  const orderId = await paidOrder(page, 13);
  await signIn(page, commissionBuyerToken(13)); await page.goto(`/commissions/${orderId}`);
  const literal = "<b>bold</b> <3";
  await page.getByPlaceholder("Nhắn cho nghệ sĩ…", { exact: true }).fill(literal);
  await page.getByRole("form", { name: "Nhắn cho nghệ sĩ…", exact: true }).getByRole("button", { name: "Gửi", exact: true }).click();
  await expect.poll(() => page.locator('[data-message-text]').evaluateAll((nodes, text) => nodes.some((node) => node.textContent === text), literal)).toBe(true);
  await expect(page.locator('[data-message-text] b')).toHaveCount(0);
  expect(await page.locator('[data-message-text]').first().evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("pre-wrap");
  let reads = 0; page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith(`/commissions/${orderId}/thread`)) reads++; });
  await page.clock.fastForward(15_000); await expect.poll(() => reads).toBeGreaterThan(0);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  const stopped = reads; await page.clock.fastForward(31_000); expect(reads).toBe(stopped);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.fastForward(15_000);
  await expect.poll(() => reads).toBeGreaterThan(stopped);
  await page.goto("/commissions"); const unmounted = reads; await page.clock.fastForward(31_000); expect(reads).toBe(unmounted);
});

test("disabled port 4182 preserves the thread without commands", async ({ page }) => {
  const orderId = await paidOrder(page, 10);
  await sendSubmission(page, "draft");
  await signIn(page, commissionBuyerToken(10)); await page.goto(`http://127.0.0.1:4182/commissions/${orderId}`);
  await expect(page.locator('[data-submission-card]')).toHaveCount(1);
  await expect(page.getByText("Tạm dừng trao đổi và giao bài. Thời hạn duyệt sẽ được cộng thêm 48 giờ sau khi mở lại.", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Nhắn cho nghệ sĩ…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Duyệt và tiếp tục", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Yêu cầu chỉnh sửa/u })).toHaveCount(0);
  await capture(page, "paused");
});

test("keyboard only acceptance announces completion", async ({ page }) => {
  const orderId = await paidOrder(page, 6);
  // This journey needs a final as its first submission.
  const form = page.getByRole("form", { name: "Bản giao cuối", exact: true });
  await form.getByLabel("Bản giao cuối", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: PNG });
  await scanPending(); await expect(form.getByRole("button", { name: "Gửi", exact: true })).toBeEnabled({ timeout: 15_000 });
  await form.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.locator('[data-order-state]')).toHaveText("Đã giao, chờ duyệt");
  await signIn(page, commissionBuyerToken(6)); await page.goto(`/commissions/${orderId}`);
  const accept = page.getByRole("button", { name: "Chấp nhận", exact: true }); await expect(accept).toBeVisible();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  for (let step = 0; step < 100 && !(await accept.evaluate((node) => node === document.activeElement)); step++) await page.keyboard.press("Tab");
  expect(await accept.evaluate((node) => node === document.activeElement)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-order-state][aria-live="polite"]')).toHaveText("Hoàn tất");
  await expect(page.getByText("Đơn đã hoàn tất. Cuộc trò chuyện chỉ còn để xem.", { exact: true })).toBeVisible();
});
