import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createDatabase, identityOidcSessions } from "@pawket/database";
import { eq } from "drizzle-orm";
import { browserDatabaseUrl } from "./increment-three-database";
import { tipBrowserSessionId, tipBrowserSessionToken } from "./increment-four-global-setup";
import { refreshBrowserSession } from "./oidc-browser-fixture";

const pendingId = "a2000000-0000-4000-8000-000000000001";
async function signIn(page: Page) {
  await refreshBrowserSession(tipBrowserSessionToken);
  await page.context().addCookies([{ name: "pawket.session", value: tipBrowserSessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function mockReview(page: Page, result: unknown) {
  let executions = 0;
  await page.route(`**/api/v1/auth/commands/${pendingId}`, (route) => {
    if (route.request().method() === "POST") { executions++; return route.fulfill({ json: result }); }
    return route.fulfill({ json: { title: "Xử lý giao dịch", body: '{"reason":"Synthetic private draft"}', ready: true,
      returnPath: "/creator/tips", expiresAt: "2099-01-01T00:00:00Z" } });
  });
  return () => executions;
}

test("expired lease starts one top-level recheck and a provider outage leaves public pages usable", async ({ page }) => {
  await signIn(page); const database = createDatabase(browserDatabaseUrl);
  try {
    const start = new Date(Date.now() - 301_000);
    await database.db.update(identityOidcSessions).set({ leaseStartedAt: start, idpValidUntil: new Date(start.getTime() + 300_000) }).where(eq(identityOidcSessions.sessionId, tipBrowserSessionId));
    let checks = 0;
    await page.route("**/api/v1/auth/oidc/lease", (route) => { checks++; return route.fulfill({ status: 503, json: { code: "provider_unavailable" } }); });
    await page.goto("/settings/security");
    await expect(page.getByText("Chưa thể kết nối dịch vụ tài khoản.", { exact: false })).toBeVisible();
    expect(checks).toBe(1);
    await expect(page.getByRole("button", { name: "Tiếp tục phiên đăng nhập", exact: true })).toBeEnabled();
    expect((await page.goto("/"))?.status()).toBe(200); expect(checks).toBe(1);
  } finally { await database.close(); }
});

for (const width of [375, 1440]) test(`pending review never executes on load and hides its one-time result at ${width}px`, async ({ page }) => {
  await signIn(page); await page.setViewportSize({ width, height: 1000 });
  const secret = "s".repeat(43); const executions = await mockReview(page, { webhookSecret: secret, connection: { webhookEndpoint: "https://pawket.example/api/v1/webhooks/sepay/synthetic" } });
  await page.clock.install(); await page.goto(`/auth/review/${pendingId}`);
  await expect(page.getByText("Synthetic private draft", { exact: true })).toBeVisible(); expect(executions()).toBe(0);
  await page.getByRole("button", { name: "Xác nhận thực hiện", exact: true }).click();
  await expect(page.getByLabel("Khóa ký SePay", { exact: true })).toHaveValue(secret); expect(executions()).toBe(1);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`oidc-private-result-${width}.png`), fullPage: true });
  await page.clock.fastForward(300_001);
  await expect(page.getByLabel("Khóa ký SePay", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Đã ẩn thông tin riêng tư.", { exact: false })).toBeVisible();
});

test("review rejects an external authorization destination and never executes after failed reauthentication", async ({ page }) => {
  await signIn(page); const executions = await mockReview(page, {});
  await page.route("**/api/v1/auth/oidc/step-up", (route) => route.fulfill({ json: { authorizationUrl: "https://untrusted.example/" } }));
  await page.goto(`/auth/review/${pendingId}`); await page.getByRole("button", { name: "Xác thực lại với reyuuGAMES" }).click();
  await expect(page.getByText("Chưa thể hoàn tất yêu cầu.", { exact: false })).toBeVisible();
  expect(executions()).toBe(0); expect(new URL(page.url()).origin).toBe("http://127.0.0.1:4177");
});

test("expired or different-actor review discloses no saved draft or confirm action", async ({ page }) => {
  await signIn(page);
  await page.route(`**/api/v1/auth/commands/${pendingId}`, (route) => route.fulfill({ status: 404, json: { code: "actor_changed" } }));
  await page.goto(`/auth/review/${pendingId}`);
  await expect(page.getByText("Thao tác đã hết hạn hoặc không thuộc phiên này.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Xác nhận thực hiện", exact: true })).toHaveCount(0);
  await expect(page.getByText("Synthetic private draft", { exact: true })).toHaveCount(0);
});

test("owner invitation is POST-only and erased after a refused attempt", async ({ page }) => {
  const invitation = "i".repeat(43); let submissions = 0;
  await page.route("**/api/v1/auth/oidc/owner-link", (route) => {
    submissions++; expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ invitation, returnPath: "/settings/security" });
    expect(route.request().url()).not.toContain(invitation); return route.fulfill({ status: 400, json: { code: "transaction_expired" } });
  });
  await page.goto("/auth/owner-link");
  await page.getByLabel("Mã mời liên kết một lần").fill(invitation); await page.getByRole("button", { name: "Xác minh tài khoản owner", exact: true }).click();
  await expect(page.getByText("Chưa thể dùng lời mời này.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Mã mời liên kết một lần")).toHaveValue(""); expect(submissions).toBe(1);
  expect(page.url()).not.toContain(invitation); await expect(page.getByRole("button", { name: "Xác minh tài khoản owner", exact: true })).toBeDisabled();
});
