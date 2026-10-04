import { randomUUID } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { commissionBuyerToken } from "./increment-six-global-setup";
import { tipBrowserHandle, tipBrowserSessionId, tipBrowserSessionToken } from "./increment-four-global-setup";

import { createDatabase, identitySessions } from "@pawket/database";
import { eq } from "drizzle-orm";
import { browserDatabaseUrl } from "./increment-three-database";
import { refreshBrowserSession, completeSyntheticPendingAuthentication, restoreBrowserSessionToken } from "./oidc-browser-fixture";

const origin = "http://127.0.0.1:4181";
async function signIn(page: Page, token: string) {
  await refreshBrowserSession(token);
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function openPackage(page: Page, route: string) {
  const result = await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`); expect(result.status()).toBe(200);
  const data = await result.json(); const offering = data.packages.find((p: { route: string }) => p.route === route); expect(offering).toBeTruthy();
  const response = await page.goto(`/creators/${tipBrowserHandle}/commissions/${offering.id}`); expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("private"); expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  return offering;
}
async function fillBrief(page: Page, content = "Brief riêng tư tổng hợp: chân dung nhân vật trong vườn.") {
  await page.getByLabel("Mô tả yêu cầu của bạn", { exact: true }).fill(content);
  await page.getByLabel("Liên kết tham khảo (không bắt buộc)").fill("https://example.invalid/reference");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
}
async function submitRequest(page: Page, route: string) {
  await page.getByRole("button", { name: route === "fixed_immediate" ? "Đặt commission và xem thanh toán" : "Gửi yêu cầu commission", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u);
  return new URL(page.url()).pathname.split("/").at(-1)!;
}
async function fillTerms(page: Page, amount = "650000") {
  await page.getByLabel("Giá trọn gói (VND)", { exact: true }).fill(amount);
  await page.getByLabel("Phạm vi công việc", { exact: true }).fill("Hai nhân vật cùng bối cảnh đơn giản.");
  await page.getByLabel("Sản phẩm bàn giao", { exact: true }).fill("PNG 3000 px.");
  await page.getByLabel("Quyền sử dụng", { exact: true }).fill("Cá nhân, không bán lại.");
  await page.getByLabel("Điều khoản của nghệ sĩ", { exact: true }).fill("Hai vòng sửa trong phạm vi đã chốt.");
}
for (const [index, entry] of ["fixed_immediate", "fixed_approval", "custom_quote"].entries()) {
  test(`real ${entry} request, acceptance and exact manual settlement`, async ({ page }) => {
    await signIn(page, commissionBuyerToken(index)); await openPackage(page, entry); await fillBrief(page); const orderId = await submitRequest(page, entry);
    if (entry !== "fixed_immediate") {
      await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
      await expect(page.getByText("Brief riêng tư tổng hợp: chân dung nhân vật trong vườn.", { exact: true })).toBeVisible();
      if (entry === "fixed_approval") {
        await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
        await page.getByRole("button", { name: "Nhận yêu cầu và mở thanh toán", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Thanh toán của đơn", exact: true })).toBeVisible();
      } else {
        await fillTerms(page); await page.getByRole("button", { name: "Xem lại báo giá trước khi gửi", exact: true }).click();
        await page.getByRole("checkbox", { name: "Tôi xác nhận nội dung báo giá hiển thị ở trên.", exact: true }).check();
        await page.getByRole("button", { name: "Gửi báo giá đã xem", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Báo giá lần 1", exact: true })).toBeVisible();
        await signIn(page, commissionBuyerToken(index)); await page.goto(`/commissions/${orderId}`);
        await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
        await page.getByRole("button", { name: "Chấp nhận báo giá và xem thanh toán", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toBeVisible();
      }
    }
    await signIn(page, commissionBuyerToken(index)); await page.goto(`/commissions/${orderId}`);
    await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Tôi đã chuyển khoản", exact: true }).click();
    await expect(page.getByRole("button", { name: "Đã báo chuyển khoản", exact: true })).toBeDisabled();
    const receipt = await (await page.request.get(`/api/v1/commissions/${orderId}`)).json();
    expect(receipt.order.payment.state).toBe("awaiting_transfer");
    await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
    await page.getByLabel("Số tiền thực nhận (VND)", { exact: true }).fill(String(receipt.order.payment.amountVnd));
    await page.getByLabel("Nội dung trên giao dịch ngân hàng", { exact: true }).fill(receipt.order.payment.reference);
    await page.getByLabel("Mã giao dịch ngân hàng", { exact: true }).fill(`SYNTH-${randomUUID()}`);
    await page.getByRole("checkbox", { name: "Tôi đã kiểm tra đúng số tiền", exact: false }).check();
    await page.getByRole("button", { name: "Xác nhận đã nhận tiền commission", exact: true }).click();
    await expect(page.getByText("Đã xác nhận thanh toán · đang thực hiện", { exact: true })).toBeVisible();
    await expect(page.getByText("Nguồn xác nhận: nghệ sĩ tự đối chiếu và xác nhận đã nhận tiền.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /hoàn tất|hoàn tiền/iu })).toHaveCount(0);
    const settled = await (await page.request.get(`/api/v1/creator/commissions/${orderId}`)).json();
    expect(settled.order.state).toBe("in_progress"); expect(settled.order.dueAt).toBeTruthy(); expect(settled.order.payment.instruction).toBeNull();
  });
}
for (const [index, width] of [375, 1440].entries()) {
  test(`private brief, terms and payment are accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await signIn(page, commissionBuyerToken(index + 3)); await openPackage(page, "fixed_immediate");
    await fillBrief(page, "Nội dung riêng tư dùng kiểm thử giao diện và lưu trữ."); await submitRequest(page, "fixed_immediate");
    await expect(page.getByRole("button", { name: "Tôi đã chuyển khoản", exact: true })).toBeEnabled();
    await expect(page.locator("svg[role=img]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
    expect(storage).not.toContain("Nội dung riêng tư"); expect(storage).not.toContain("0000001234567");
    await page.screenshot({ path: path.resolve(import.meta.dirname, `../../../docs/audits/increment6-buyer-${width}.png`), fullPage: true });
    await signIn(page, tipBrowserSessionToken); await page.goto("/creator/commissions/packages");
    await expect(page.getByRole("button", { name: "Lưu cài đặt", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: path.resolve(import.meta.dirname, `../../../docs/audits/increment6-packages-${width}.png`), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const save = page.getByRole("button", { name: "Lưu bản nháp", exact: true }); await save.focus();
    const bounds = await save.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: path.resolve(import.meta.dirname, `../../../docs/audits/increment6-packages-zoom-${width}.png`), fullPage: true });
  });
}
test("unknown committed request keeps its bytes and key; changing account clears the private form", async ({ page }) => {
  await signIn(page, commissionBuyerToken(5)); await openPackage(page, "fixed_immediate"); await fillBrief(page);
  const commands: Array<{ key: string | undefined; body: string | null }> = [];
  await page.route("**/api/v1/commissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    commands.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (commands.length === 1) { const committed = await route.fetch(); expect(committed.status()).toBe(200); return route.abort("connectionfailed"); }
    return route.continue();
  });
  await page.getByRole("button", { name: "Đặt commission và xem thanh toán", exact: true }).click();
  await expect(page.getByRole("button", { name: "Kiểm tra lại cùng yêu cầu", exact: true })).toBeVisible();
  await expect(page.getByLabel("Mô tả yêu cầu của bạn", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Kiểm tra lại cùng yêu cầu", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u); expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]); expect(commands[0]?.key).toBeTruthy();
  const list = await (await page.request.get("/api/v1/commissions")).json(); expect(list.orders.items).toHaveLength(1);
  await signIn(page, commissionBuyerToken(6)); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Tài khoản đã thay đổi.", { exact: false })).toBeVisible();
  await expect(page.getByText("Brief riêng tư tổng hợp: chân dung nhân vật trong vườn.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tôi đã chuyển khoản", exact: true })).toHaveCount(0);
});
test("package draft, preview, publish, pause and archive persist through real routes", async ({ page }) => {
  await signIn(page, tipBrowserSessionToken); await page.goto("/creator/commissions/packages");
  await page.getByLabel("Tên gói", { exact: true }).fill("Gói riêng kiểm thử biên tập");
  await page.getByLabel("Mô tả gói", { exact: true }).fill("Một gói mới chỉ dùng trong fixture."); await fillTerms(page);
  await page.getByRole("button", { name: "Xem trước", exact: true }).click();
  await expect(page.getByRole("region", { name: "Xem trước gói", exact: true })).toContainText("650.000 ₫");
  await page.getByRole("button", { name: "Lưu bản nháp", exact: true }).click();
  await expect(page.getByText("Đã lưu bản nháp. Xuất bản để áp dụng cho yêu cầu mới.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Xuất bản bản đã lưu", exact: true }).click(); await expect(page.getByText("Đã xuất bản gói.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tạm dừng gói", exact: true }).click(); await expect(page.getByText("Đã tạm ngừng nhận yêu cầu mới cho gói.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Lưu trữ gói", exact: true }).click(); await page.getByRole("button", { name: "Đồng ý lưu trữ", exact: true }).click();
  await expect(page.getByText("Đã lưu trữ gói. Lịch sử đơn vẫn được giữ.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gói riêng kiểm thử biên tập", exact: false })).toHaveCount(0);
});
test("disabled mode preserves private history and allows unpaid close without QR", async ({ page }) => {
  await signIn(page, commissionBuyerToken(7)); await openPackage(page, "fixed_immediate"); await fillBrief(page); const orderId = await submitRequest(page, "fixed_immediate");
  await page.goto(`http://127.0.0.1:4182/commissions/${orderId}`);
  await expect(page.getByText("Commission đang tạm giới hạn", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Rút hoặc hủy yêu cầu", exact: true }).click(); await page.getByRole("button", { name: "Xác nhận đóng yêu cầu", exact: true }).click();
  await expect(page.getByText("Người đặt đã hủy", { exact: true })).toBeVisible();
  const stranger = await page.request.get(`${origin}/api/v1/creator/commissions/${orderId}`); expect(stranger.status()).toBe(404);
  await page.context().clearCookies(); const guest = await page.request.get(`${origin}/api/v1/commissions/${orderId}`); expect(guest.status()).toBe(401);
});
test("expired instructions stay hidden after a refresh and failed reads hide stale QR", async ({ page }) => {
  await signIn(page, commissionBuyerToken(8)); await page.clock.install(); await openPackage(page, "fixed_immediate"); await fillBrief(page); const orderId = await submitRequest(page, "fixed_immediate");
  await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toBeVisible();
  await page.route(`**/api/v1/commissions/${orderId}`, (route) => route.fulfill({ status: 503, json: { code: "dependency_unavailable" } }));
  await page.getByRole("button", { name: "Cập nhật trạng thái", exact: true }).click();
  await expect(page.getByText("Chưa tải được trạng thái mới", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toHaveCount(0);
  await page.unroute(`**/api/v1/commissions/${orderId}`); await page.getByRole("button", { name: "Kiểm tra trạng thái", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toBeVisible();
  await page.clock.fastForward(86_401_000);
  await expect(page.getByText("Đã qua thời hạn", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cập nhật trạng thái", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toHaveCount(0);
});
test("confirmation preserves exact evidence and key through OIDC review", async ({ page }) => {
  await signIn(page, commissionBuyerToken(9)); await openPackage(page, "fixed_immediate"); await fillBrief(page); const orderId = await submitRequest(page, "fixed_immediate");
  const { order } = await (await page.request.get('/api/v1/commissions/' + orderId)).json();
  await signIn(page, tipBrowserSessionToken); await page.goto('/creator/commissions/' + orderId);
  const database = createDatabase(browserDatabaseUrl);
  try {
    await database.db.update(identitySessions).set({ primaryAuthenticatedAt: new Date(Date.now() - 3_601_000) }).where(eq(identitySessions.id, tipBrowserSessionId));
    const attempts: Array<{ key: string | undefined; body: string | null }> = [];
    await page.route('**/api/v1/creator/commissions/' + orderId + '/confirm', async (route) => {
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() }); await route.continue();
    });
    await page.getByLabel("Số tiền thực nhận (VND)", { exact: true }).fill(String(order.payment.amountVnd));
    await page.getByLabel("Nội dung trên giao dịch ngân hàng", { exact: true }).fill(order.payment.reference);
    await page.getByLabel("Mã giao dịch ngân hàng", { exact: true }).fill('SYNTH-' + randomUUID());
    await page.getByRole("checkbox", { name: "Tôi đã kiểm tra đúng số tiền", exact: false }).check();
    await page.getByRole("button", { name: "Xác nhận đã nhận tiền commission", exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/review\/[0-9a-f-]{36}$/u);
    await expect(page.getByRole("button", { name: "Xác nhận thực hiện", exact: true })).toHaveCount(0);
    const review = await completeSyntheticPendingAuthentication(database.db, new URL(page.url()).pathname.split("/").at(-1)!);
    await page.context().addCookies([{ name: "pawket.session", value: review.sessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
    expect(attempts).toHaveLength(1); expect(review.payload.body).toBe(attempts[0]!.body); expect(review.payload.idempotencyKey).toBe(attempts[0]!.key);
    const unchanged = await (await page.request.get('/api/v1/creator/commissions/' + orderId)).json();
    expect(unchanged.order.state).toBe(order.state);
    await page.reload(); await page.getByRole("button", { name: "Xác nhận thực hiện", exact: true }).click();
    await expect(page.getByText("Đã xử lý yêu cầu.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Quay lại xem kết quả" }).click();
    await expect(page.getByText("Đã xác nhận thanh toán · đang thực hiện", { exact: true })).toBeVisible();
  } finally { await restoreBrowserSessionToken(database.db, tipBrowserSessionId, tipBrowserSessionToken); await database.close(); }
});

test("a stale quote cannot open payment and the replacement requires fresh acceptance", async ({ page, browser }) => {
  await signIn(page, commissionBuyerToken(11)); await openPackage(page, "custom_quote"); await fillBrief(page); const orderId = await submitRequest(page, "custom_quote");
  const creatorContext = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } }); const creator = await creatorContext.newPage();
  try {
    await signIn(creator, tipBrowserSessionToken); await creator.goto(`/creator/commissions/${orderId}`);
    async function sendQuote(amount: string, revision: number) {
      await creator.bringToFront();
      await expect(creator.getByRole("heading", { name: revision === 1 ? "Soạn báo giá" : "Thay báo giá", exact: true })).toBeVisible();
      await expect(creator.getByLabel("Giá trọn gói (VND)", { exact: true })).toHaveCount(1);
      await fillTerms(creator, amount); await creator.getByRole("button", { name: "Xem lại báo giá trước khi gửi", exact: true }).click();
      await creator.getByRole("checkbox", { name: "Tôi xác nhận nội dung báo giá hiển thị ở trên.", exact: true }).check();
      await creator.getByRole("button", { name: "Gửi báo giá đã xem", exact: true }).click();
      await expect(creator.getByRole("heading", { name: `Báo giá lần ${revision}`, exact: true })).toBeVisible();
    }
    await sendQuote("650000", 1); await page.reload();
    await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
    await sendQuote("750000", 2);
    await page.getByRole("button", { name: "Chấp nhận báo giá và xem thanh toán", exact: true }).click();
    await expect(page.getByText("Nội dung đã thay đổi. Tải lại trang và xem lại trước khi tiếp tục.", { exact: true })).toBeVisible();
    expect((await (await page.request.get(`/api/v1/commissions/${orderId}`)).json()).order.payment).toBeNull();
    await page.getByRole("button", { name: "Cập nhật trạng thái", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Báo giá lần 2", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Chấp nhận báo giá và xem thanh toán", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
    await page.getByRole("button", { name: "Chấp nhận báo giá và xem thanh toán", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Chuyển khoản cho Tip Test Artist", exact: true })).toBeVisible();
    expect((await (await page.request.get(`/api/v1/commissions/${orderId}`)).json()).order.payment.amountVnd).toBe(750000);
  } finally { await creatorContext.close(); }
});

test("an empty buyer history remains accessible and private", async ({ page }) => {
  await signIn(page, commissionBuyerToken(19)); const response = await page.goto("/commissions");
  expect(response?.headers()["cache-control"]).toContain("private");
  await expect(page.getByText("Chưa có commission", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
