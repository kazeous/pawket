import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createClamdClient, createS3CommissionFileStorage, processCommissionFileScan } from "@pawket/commission-files";
import { commissionFiles, createDatabase } from "@pawket/database";
import { browserDatabaseUrl } from "./increment-three-database";
import { commissionBuyerToken } from "./increment-six-global-setup";
import { tipBrowserHandle, tipBrowserSessionToken } from "./increment-four-global-setup";
import { refreshBrowserSession } from "./oidc-browser-fixture";
import path from "node:path";

async function signIn(page: import("@playwright/test").Page, token: string) {
  await refreshBrowserSession(token);
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function openPackage(page: import("@playwright/test").Page) {
  const data = await (await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`)).json();
  const offering = data.packages.find((entry: { route: string }) => entry.route === "fixed_approval");
  await page.goto(`/creators/${tipBrowserHandle}/commissions/${offering.id}`);
}
async function checkFile(page: import("@playwright/test").Page) {
  const preview = page.getByRole("img", { name: "Xem trước tham-khao.png" });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const response = await page.request.get(await page.getByRole("link", { name: "Tải xuống" }).getAttribute("href") ?? "", { maxRedirects: 0 });
  expect(response.status()).toBe(302); expect(response.headers()["cache-control"]).toContain("no-store");
  const bytes = await page.request.get(response.headers().location!);
  expect(bytes.ok()).toBe(true); expect(await bytes.body()).toEqual(PNG);
}

const storage = createS3CommissionFileStorage({ endpoint: process.env.COMMISSION_FILES_S3_ENDPOINT ?? "http://127.0.0.1:9090", region: "us-east-1",
  accessKeyId: process.env.COMMISSION_FILES_S3_ACCESS_KEY_ID ?? "local-commission-files-key", secretAccessKey: process.env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY ?? "local-commission-files-secret",
  quarantineBucket: process.env.COMMISSION_FILES_QUARANTINE_BUCKET ?? "pawket-commission-quarantine", cleanBucket: process.env.COMMISSION_FILES_CLEAN_BUCKET ?? "pawket-commission-clean", forcePathStyle: true });
const scanner = createClamdClient({ host: process.env.COMMISSION_FILES_CLAMD_HOST ?? "127.0.0.1", port: Number(process.env.COMMISSION_FILES_CLAMD_PORT ?? "3310"), timeoutMs: 60_000 });
const freshScanner = { scan: scanner.scan, version: async () => ({ ...(await scanner.version()), signatureDate: new Date() }) };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const EICAR = Buffer.from(String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`);

async function scanPending() {
  const database = createDatabase(browserDatabaseUrl);
  try {
    for (let round = 0; round < 20; round += 1) {
      const pending = await database.db.select({ id: commissionFiles.id }).from(commissionFiles).where(eq(commissionFiles.state, "scanning"));
      if (pending.length) { for (const file of pending) await processCommissionFileScan({ db: database.db, storage, scanner: freshScanner, fileId: file.id }); return; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("No uploaded file reached scanning");
  } finally { await database.close(); }
}

test.use({ extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } });

test("buyer attaches a scanned reference and both sides can open it", async ({ page }) => {
  await signIn(page, commissionBuyerToken(18)); await openPackage(page);
  await page.getByLabel("Mô tả yêu cầu của bạn").fill("Brief kèm ảnh tham khảo tổng hợp.");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  await page.getByLabel("Tệp tham khảo (không bắt buộc)").setInputFiles({ name: "tham-khao.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("Đang kiểm tra tệp…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi yêu cầu commission" })).toBeDisabled();
  await scanPending();
  await expect(page.getByText("Đã kiểm tra, không phát hiện mã độc đã biết")).toBeVisible({ timeout: 15_000 });
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: path.resolve(import.meta.dirname, "../.playwright-artifacts/increment-six", `reference-picker-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Gửi yêu cầu commission" }).click();
  await page.waitForURL(/\/commissions\/[0-9a-f-]{36}$/u);
  await expect(page.getByRole("heading", { name: "Tệp tham khảo" })).toBeVisible();
  const orderId = new URL(page.url()).pathname.split("/").at(-1)!;
  await checkFile(page);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: path.resolve(import.meta.dirname, "../.playwright-artifacts/increment-six", `reference-list-${width}.png`), fullPage: true });
  }
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`); await checkFile(page);
});

test("an EICAR file named .png is rejected and cannot be sent", async ({ page }) => {
  await signIn(page, commissionBuyerToken(17)); await openPackage(page);
  await page.getByLabel("Mô tả yêu cầu của bạn").fill("Brief kiểm thử tệp bị từ chối.");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  await page.getByLabel("Tệp tham khảo (không bắt buộc)").setInputFiles({ name: "khong-phai-anh.png", mimeType: "image/png", buffer: EICAR });
  await scanPending();
  await expect(page.getByText("Tệp bị từ chối")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Phát hiện mã độc đã biết. Tệp đã bị xóa.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi yêu cầu commission" })).toBeDisabled();
  await page.getByRole("button", { name: "Gỡ khong-phai-anh.png" }).click();
  await expect(page.getByText("khong-phai-anh.png")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Gửi yêu cầu commission" })).toBeEnabled();
});

test("disabled uploads preserve a text-only request and oversized files never upload", async ({ page }) => {
  await signIn(page, commissionBuyerToken(16)); await openPackage(page);
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  let grants = 0;
  await page.route("**/api/v1/commission-files", async (route) => { grants += 1; await route.fulfill({ status: 503, json: { code: "files_disabled" } }); });
  await page.getByLabel("Tệp tham khảo (không bắt buộc)").setInputFiles({ name: "qua-lon.png", mimeType: "image/png", buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await expect(page.getByText("Tệp vượt quá 25 MB.")).toBeVisible(); expect(grants).toBe(0);
  await page.getByRole("button", { name: "Gỡ qua-lon.png" }).click();
  await page.getByLabel("Tệp tham khảo (không bắt buộc)").setInputFiles({ name: "tham-khao.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("Tạm dừng nhận tệp tham khảo. Bạn vẫn có thể gửi brief chỉ có chữ và liên kết.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi yêu cầu commission" })).toBeDisabled();
  await page.getByRole("button", { name: "Gỡ tham-khao.png" }).click();
  await expect(page.getByRole("button", { name: "Gửi yêu cầu commission" })).toBeEnabled();
});

test("removing a scanning file stops polling and releases the pending form", async ({ page }) => {
  await signIn(page, commissionBuyerToken(15)); await openPackage(page);
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  let reads = 0;
  page.on("request", (request) => { if (request.method() === "GET" && /\/api\/v1\/commission-files\/[0-9a-f-]+$/u.test(request.url())) reads += 1; });
  await page.getByLabel("Tệp tham khảo (không bắt buộc)").setInputFiles({ name: "dang-kiem-tra.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("Đang kiểm tra tệp…")).toBeVisible();
  await page.getByRole("button", { name: "Gỡ dang-kiem-tra.png" }).click();
  const stoppedAt = reads;
  await page.waitForTimeout(1800); expect(reads).toBe(stoppedAt);
  await expect(page.getByRole("button", { name: "Gửi yêu cầu commission" })).toBeEnabled();
});

for (const action of ["remove", "unmount"] as const) {
  test(`${action} aborts the active PUT without completing it`, async ({ page }) => {
    await signIn(page, commissionBuyerToken(14)); await openPackage(page);
    const fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; let completed = 0;
    await page.route("**/api/v1/commission-files", (route) => route.fulfill({ json: { upload: {
      fileId, url: "http://127.0.0.1:4181/synthetic-reference-put", requiredHeaders: { "content-type": "application/octet-stream", "content-length": String(PNG.length) }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } } }));
    await page.route("**/synthetic-reference-put", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.fulfill({ status: 200, body: "" }).catch(() => undefined);
    });
    await page.route(`**/api/v1/commission-files/${fileId}/complete`, (route) => { completed += 1; return route.fulfill({ json: {} }); });
    await page.route(`**/api/v1/commission-files/${fileId}/discard`, (route) => route.fulfill({ json: {} }));
    const started = page.waitForRequest((request) => request.method() === "PUT");
    await page.getByLabel("Tệp tham khảo (không bắt buộc)").setInputFiles({ name: "x\u202ey.png", mimeType: "image/png", buffer: PNG });
    await started;
    await expect(page.getByText("xy.png", { exact: true })).toBeVisible();
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.method() === "PUT" });
    if (action === "remove") await page.getByRole("button", { name: "Gỡ xy.png" }).click();
    else await page.getByRole("link", { name: "Xem commission của bạn" }).click();
    await aborted;
    await page.waitForTimeout(3200); expect(completed).toBe(0);
  });
}
