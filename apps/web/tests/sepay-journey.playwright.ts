import AxeBuilder from "@axe-core/playwright";
import { createHmac } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { tipBrowserSessionToken, tipBrowserUserId, tipPolicyOwnerSessionToken } from "./increment-four-global-setup";

const endpoint = "/api/v1/creator/tips/sepay";
const connectionId = "14000000-0000-4000-8000-000000000001";
const inboxId = "14000000-0000-4000-8000-000000000002";
const syntheticSecret = "s".repeat(43);
async function signIn(page: Page, token = tipBrowserSessionToken) {
  const signature = createHmac("sha256", "playwright-only-better-auth-secret-000000000000").update(token).digest("base64");
  await page.context().addCookies([{ name: "pawket.session", value: `${token}.${signature}`, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
// Browser-only projections exercise interaction independently of the unresolved
// external provider contract. Server/service/database tests cover authority.
async function syntheticUi(page: Page, options: { totp?: boolean; uncertain?: boolean } = {}) {
  let version = 5; let confirmed = false; let confirmAttempts = 0; let rotateAttempts = 0;
  const commands: Array<{ path: string; key: string | undefined; body: unknown }> = [];
  const connection = () => ({ id: connectionId, version, status: "ready", bankName: "Vietcombank", maskedSuffix: "•••• 4567", automationEnabled: true,
    cutoverAt: "2026-09-24T00:00:00.000Z", webhookEndpoint: `http://127.0.0.1:4177/api/v1/webhooks/sepay/${connectionId}`, remoteRevocationStatus: "not_requested" });
  await page.route(`**${endpoint}{,/**,?*}`, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const send = (json: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, json });
    if (request.method() === "GET") {
      if (url.pathname === endpoint) return send({ snapshot: { available: true, blockReason: null, connection: connection() } });
      if (url.pathname === `${endpoint}/reviews`) return send({ queue: { nextCursor: null, items: confirmed ? [] : [{ id: inboxId, connectionId, version: 3,
        status: "review_required", reason: "amount_mismatch", amountVnd: 50_000, reference: "PW0123456789ABCDEF0123", receivedAt: "2026-09-24T01:00:00.000Z" }] } });
    }
    commands.push({ path: url.pathname, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
    if (url.pathname.endsWith("/change")) {
      rotateAttempts++;
      if (options.uncertain && rotateAttempts === 1) return route.abort("connectionfailed");
      version++; return send({ connection: connection(), webhookSecret: syntheticSecret });
    }
    if (url.pathname.endsWith("/confirm")) {
      confirmAttempts++;
      if (options.totp && confirmAttempts === 1) return send({ code: "totp_required" }, 403);
      confirmed = true; return send({ outcome: "confirmed" });
    }
    return send({ code: "invalid_request" }, 400);
  });
  await page.goto("/creator/tips/sepay");
  await page.getByRole("button", { name: "Tải lại", exact: true }).click();
  await expect(page.getByText("Vietcombank · •••• 4567", { exact: true })).toBeVisible();
  return { commands };
}

test("runtime keeps provider contract closed and protects creator/owner surfaces", async ({ page }) => {
  const guest = await page.request.get(endpoint); expect(guest.status()).toBe(401);
  await signIn(page);
  const response = await page.goto("/creator/tips/sepay"); expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("no-store"); expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByRole("button", { name: "Kết nối SePay", exact: true })).toBeDisabled();
  const current = await page.request.get(endpoint);
  expect(await current.json()).toEqual({ snapshot: { available: false, blockReason: "provider_contract_pending", connection: null } });
  expect((await page.request.get("/api/v1/admin/sepay")).status()).toBe(404);
  expect((await page.request.post(`/api/v1/webhooks/sepay/${connectionId}`, { data: {} })).status()).toBe(404);
});

for (const width of [375, 1440]) {
  test(`private setup/review is accessible with one-time secret at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await signIn(page);
    await syntheticUi(page);
    await expect(page.getByText("50.000 ₫", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Đối chiếu lại và xác nhận", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Tạo khóa ký mới", exact: true }).click();
    await expect(page.getByLabel("Khóa ký chỉ hiển thị lần này", { exact: true })).toHaveValue(syntheticSecret);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
    expect(storage).not.toContain(syntheticSecret);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    await page.screenshot({ path: path.resolve(import.meta.dirname, `../../../docs/audits/increment5-creator-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Tôi đã lưu khóa, ẩn đi", exact: true }).click();
    await expect(page.getByLabel("Khóa ký chỉ hiển thị lần này", { exact: true })).toHaveCount(0);
    await page.reload(); await page.getByRole("button", { name: "Tải lại", exact: true }).click();
    await expect(page.getByLabel("Khóa ký chỉ hiển thị lần này", { exact: true })).toHaveCount(0);
  });
}

test("creator keeps the exact review command through TOTP verification", async ({ page }) => {
  await signIn(page); const { commands } = await syntheticUi(page, { totp: true });
  await page.route("**/api/auth/two-factor/verify-totp", (route) => route.fulfill({ json: { status: true } }));
  await page.getByLabel("Lý do xử lý", { exact: true }).fill("Đã kiểm tra giao dịch tổng hợp");
  await page.getByRole("checkbox", { name: "Tôi đã kiểm tra và nhận được đúng khoản tiền này.", exact: true }).check();
  await page.getByRole("button", { name: "Đối chiếu lại và xác nhận", exact: true }).click();
  await page.getByLabel("Mã từ ứng dụng xác thực", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Xác thực để tiếp tục", exact: true }).click();
  await expect(page.getByText("Đã xác thực. Kiểm tra thông tin rồi thực hiện lại thao tác vừa chọn.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Đối chiếu lại và xác nhận", exact: true }).click();
  await expect(page.getByText("Đã ghi nhận kết quả xử lý.", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]); expect(commands[0]?.key).toBeTruthy();
});

test("ambiguous secret rotation preserves its retry key and changed accounts cannot reuse the draft", async ({ page }) => {
  await signIn(page); const { commands } = await syntheticUi(page, { uncertain: true });
  await page.getByRole("button", { name: "Tạo khóa ký mới", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Tạo khóa ký mới", exact: true }).click();
  await expect(page.getByLabel("Khóa ký chỉ hiển thị lần này", { exact: true })).toHaveValue(syntheticSecret);
  expect(commands[0]).toEqual(commands[1]);
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: { user: { id: `${tipBrowserUserId}-different` } } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Tài khoản đăng nhập đã thay đổi. Tải lại trang trước khi tiếp tục.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Khóa ký chỉ hiển thị lần này", { exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(2);
});

test("owner diagnostics remain read-only and disabled payments retain creator history", async ({ page }) => {
  await signIn(page, tipPolicyOwnerSessionToken);
  await page.goto("/admin/sepay");
  await expect(page.getByRole("heading", { name: "Tình trạng kết nối SePay", exact: true })).toBeVisible();
  expect((await page.request.get("/api/v1/admin/sepay")).status()).toBe(200);
  expect((await page.request.post("/api/v1/admin/sepay", { data: { action: "confirm" } })).status()).toBe(405);
  await signIn(page); await page.goto("http://127.0.0.1:4178/creator/tips/sepay");
  await expect(page.getByRole("heading", { name: "Đối soát qua SePay", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kết nối SePay", exact: true })).toBeDisabled();
});
