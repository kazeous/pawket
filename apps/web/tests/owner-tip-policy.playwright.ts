import AxeBuilder from "@axe-core/playwright";
import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createDatabase, identitySessions } from "@pawket/database";
import { eq } from "drizzle-orm";
import { createPlatformTipPolicyService } from "@pawket/catalog";
import { createOwnerTipPolicyAssurancePort } from "@pawket/admin";
import { browserDatabaseUrl } from "./increment-three-database";
import { currentOwnerTotp } from "./increment-three-fixture";
import { tipBrowserHandle, tipBrowserPassword, tipBrowserSessionId, tipBrowserSessionToken, tipPolicyOwnerSessionId, tipPolicyOwnerSessionToken, tipPolicyOwnerUserId } from "./increment-four-global-setup";

const baseURL = "http://127.0.0.1:4177";
const endpoint = "/api/v1/admin/tip-policy";
const offeringEndpoint = `/api/v1/public/creators/${tipBrowserHandle}/tips`;
const launch = { minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000] };
const narrower = { minimumVnd: 30_000, maximumVnd: 500_000, allowedPresetsVnd: [30_000, 50_000, 100_000, 200_000] };
type Amounts = typeof launch;
async function signIn(page: Page, token: string) {
  const signature = createHmac("sha256", "playwright-only-better-auth-secret-000000000000").update(token).digest("base64");
  await page.context().addCookies([{ name: "pawket.session", value: `${token}.${signature}`, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function ownerPage(browser: Browser) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } });
  const page = await context.newPage(); await signIn(page, tipPolicyOwnerSessionToken); return page;
}
async function currentPolicy(page: Page) {
  const response = await page.request.get(endpoint); expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store"); return (await response.json()).policy;
}
async function savePolicy(page: Page, amounts: Amounts, reason = "Synthetic browser policy change") {
  const previous = await currentPolicy(page);
  const body = { ...amounts, expectedRevision: previous.revisionNumber, reason };
  const headers = { origin: baseURL, "idempotency-key": randomUUID() };
  let response = await page.request.post(endpoint, { data: body, headers });
  if (response.status() === 403 && (await response.json()).code === "owner_totp_required") {
    const proof = await page.request.post("/api/auth/two-factor/verify-totp", { data: { code: currentOwnerTotp(), trustDevice: false }, headers: { origin: baseURL } });
    expect(proof.status()).toBe(200);
    response = await page.request.post(endpoint, { data: body, headers });
  }
  expect(response.status(), await response.text()).toBe(200);
  const result = (await response.json()).policy; expect(result.revisionNumber).toBe(previous.revisionNumber + 1); return result;
}
async function fillPolicy(page: Page, amounts: Amounts, reason: string) {
  await page.getByLabel("Số tiền tối thiểu (VND)", { exact: true }).fill(String(amounts.minimumVnd));
  await page.getByLabel("Số tiền tối đa (VND)", { exact: true }).fill(String(amounts.maximumVnd));
  const fields = page.getByRole("textbox", { name: /^Mức gợi ý \d/u });
  while (await fields.count() < amounts.allowedPresetsVnd.length) await page.getByRole("button", { name: "Thêm mức gợi ý" }).click();
  while (await fields.count() > amounts.allowedPresetsVnd.length) await page.getByRole("button", { name: `Xóa mức gợi ý ${await fields.count()}`, exact: true }).click();
  for (let i = 0; i < amounts.allowedPresetsVnd.length; i++) await fields.nth(i).fill(String(amounts.allowedPresetsVnd[i]));
  await page.getByLabel("Lý do thay đổi").fill(reason);
}
async function assertAccessible(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
}
async function restoreLaunch(browser: Browser) {
  // A timed-out reauthentication test must not leave the independent legacy
  // journey using this intentionally aged, synthetic fixture session.
  const fixture = createDatabase(browserDatabaseUrl);
  try { await fixture.db.update(identitySessions).set({ primaryAuthenticatedAt: new Date() }).where(eq(identitySessions.id, tipBrowserSessionId)); }
  finally { await fixture.close(); }
  const owner = await ownerPage(browser);
  try {
    const current = await currentPolicy(owner);
    if (current.minimumVnd !== launch.minimumVnd || current.maximumVnd !== launch.maximumVnd || JSON.stringify(current.allowedPresetsVnd) !== JSON.stringify(launch.allowedPresetsVnd)) await savePolicy(owner, launch, "Restore synthetic launch policy after browser check");
  } finally { await owner.context().close(); }
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } });
  try {
    const creator = await context.newPage(); await signIn(creator, tipBrowserSessionToken);
    const response = await creator.request.get("/api/v1/creator/tip-settings"); expect(response.status()).toBe(200);
    const { settings } = await response.json();
    if (!settings.enabled || JSON.stringify(settings.presetsVnd) !== JSON.stringify(launch.allowedPresetsVnd)) {
      const restored = await creator.request.post("/api/v1/creator/tip-settings", { headers: { origin: baseURL, "idempotency-key": randomUUID() }, data: { expectedRevision: settings.revisionNumber, expectedPolicyRevision: settings.effectivePolicy.revisionNumber, enabled: true, presetsVnd: launch.allowedPresetsVnd } });
      expect(restored.status(), await restored.text()).toBe(200);
    }
  } finally { await context.close(); }
}

test.describe.configure({ mode: "serial" });
test.afterEach(async ({ browser }) => { await restoreLaunch(browser); });

test("owner reviews, validates, completes real TOTP and saves with history at 375px", async ({ page }) => {
  await signIn(page, tipPolicyOwnerSessionToken); await page.setViewportSize({ width: 375, height: 1000 });
  await page.goto("/admin/tip-policy"); await expect(page.getByRole("heading", { name: "Chính sách tip", exact: true })).toBeVisible();
  await expect(page.getByLabel("Số tiền tối thiểu (VND)", { exact: true })).toHaveValue("10000");
  await fillPolicy(page, narrower, "Synthetic owner changes defaults");
  await page.getByLabel("Số tiền tối thiểu (VND)", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Lưu chính sách", exact: true }).click();
  await expect(page.getByLabel("Số tiền tối thiểu (VND)", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Số tiền tối thiểu (VND)", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Số tiền tối thiểu (VND)", { exact: true }).fill("30000");
  await page.getByRole("button", { name: "Lưu chính sách", exact: true }).click();
  await expect(page.getByLabel("Mã từ ứng dụng xác thực")).toBeFocused();
  await expect(page.getByLabel("Lý do thay đổi")).toHaveValue("Synthetic owner changes defaults");
  await page.getByLabel("Mã từ ứng dụng xác thực").fill("12345");
  await page.getByRole("button", { name: "Xác thực và lưu chính sách" }).click();
  await expect(page.getByLabel("Mã từ ứng dụng xác thực")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Mã từ ứng dụng xác thực").fill(currentOwnerTotp());
  await page.getByRole("button", { name: "Xác thực và lưu chính sách" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu chính sách phiên bản" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Synthetic owner changes defaults" })).toContainText(tipPolicyOwnerUserId);
  expect(await currentPolicy(page)).toMatchObject(narrower);
  await assertAccessible(page);
  await page.getByRole("table", { name: "Lịch sử thay đổi chính sách tip" }).focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.locator('[data-slot="table-container"]').evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.getByLabel("Số tiền tối thiểu (VND)", { exact: true }).focus(); await page.keyboard.press("Tab");
  await expect(page.getByLabel("Số tiền tối đa (VND)", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("owner-policy-375.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator(".account-identity").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(200);
  expect(await page.locator(".account-identity strong").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(100);
  await expect(page.getByRole("button", { name: "Lưu chính sách", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("owner-policy-200-percent.png"), fullPage: true });
});

test("lost owner save response retries identical command and creates one policy revision", async ({ page }) => {
  await signIn(page, tipPolicyOwnerSessionToken); await page.goto("/admin/tip-policy");
  await expect(page.getByLabel("Lý do thay đổi")).toBeVisible();
  const before = await currentPolicy(page); await fillPolicy(page, narrower, "Synthetic owner lost response");
  const attempts: { key: string | undefined; body: string | null }[] = []; let dropped = false;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (!dropped) { dropped = true; const result = await route.fetch(); expect(result.status()).toBe(200); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Lưu chính sách", exact: true }).click();
  await expect(page.getByRole("button", { name: "Thử lại lần lưu này" })).toBeVisible();
  await expect(page.getByLabel("Lý do thay đổi")).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu chính sách" })).toHaveCount(0);
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "IDENTITY_UNAVAILABLE" }) }));
  await page.getByRole("button", { name: "Thử lại lần lưu này" }).click();
  await expect(page.getByRole("button", { name: "Thử lại lần lưu này" })).toBeEnabled();
  await expect(page.getByLabel("Lý do thay đổi")).toBeDisabled(); expect(attempts).toHaveLength(1);
  await page.unroute("**/api/v1/me"); await signIn(page, tipBrowserSessionToken);
  await page.getByRole("button", { name: "Thử lại lần lưu này" }).click();
  await expect(page.getByText("Bạn đang đăng nhập bằng tài khoản khác.", { exact: false })).toBeVisible();
  expect(attempts).toHaveLength(1); await expect(page.getByLabel("Lý do thay đổi")).toHaveValue("Synthetic owner lost response");
  await signIn(page, tipPolicyOwnerSessionToken);
  await page.getByRole("button", { name: "Thử lại lần lưu này" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu chính sách phiên bản" })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
  expect((await currentPolicy(page)).revisionNumber).toBe(before.revisionNumber + 1);
});

test("creator reauthenticates in a new tab and replays the original uncertain save", async ({ page, context }) => {
  const database = createDatabase(browserDatabaseUrl);
  try {
    await signIn(page, tipBrowserSessionToken); await page.goto("/creator/tips");
    const before = (await (await page.request.get("/api/v1/creator/tip-settings")).json()).settings.revisionNumber;
    const attempts: { key: string | undefined; body: string | null }[] = []; let dropped = false;
    await page.route("**/api/v1/creator/tip-settings", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!dropped) { dropped = true; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); }
      else await route.continue();
    });
    await page.getByRole("button", { name: "Dừng nhận tip mới", exact: true }).click();
    await page.getByRole("button", { name: "Lưu cài đặt tip", exact: true }).click();
    await expect(page.getByRole("button", { name: "Thử lại lần lưu này" })).toBeVisible();
    await database.db.update(identitySessions).set({ primaryAuthenticatedAt: new Date(Date.now() - 901_000) }).where(eq(identitySessions.id, tipBrowserSessionId));
    await page.getByRole("button", { name: "Thử lại lần lưu này" }).click();
    await expect(page.getByText("Đăng nhập lại đúng tài khoản trong tab mới", { exact: false })).toBeVisible();
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "Đăng nhập lại trong tab mới" }).click();
    const reauth = await opened; await reauth.waitForURL("**/sign-in/reauth");
    await expect(reauth.getByLabel(/^Email/u)).toBeVisible();
    await reauth.getByLabel(/^Email/u).fill("tip-artist@example.invalid");
    await reauth.getByLabel(/^Mật khẩu/u).fill(tipBrowserPassword);
    await reauth.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await reauth.waitForURL("**/settings/security");
    await expect(page).toHaveURL(/\/creator\/tips$/u);
    await expect(page.getByRole("button", { name: "Dừng nhận tip mới", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Dừng nhận tip mới", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Thử lại lần lưu này" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Đã dừng nhận tip mới" })).toBeVisible();
    expect(attempts).toHaveLength(3); expect(attempts[0]).toEqual(attempts[1]); expect(attempts[0]).toEqual(attempts[2]);
    expect((await (await page.request.get("/api/v1/creator/tip-settings")).json()).settings.revisionNumber).toBe(before + 1);
    await reauth.close();
  } finally {
    await database.db.update(identitySessions).set({ primaryAuthenticatedAt: new Date() }).where(eq(identitySessions.id, tipBrowserSessionId));
    await database.close();
  }
});

test("stale owner draft reloads and requires review without discarding input", async ({ page }) => {
  await signIn(page, tipPolicyOwnerSessionToken); await page.goto("/admin/tip-policy");
  await expect(page.getByLabel("Lý do thay đổi")).toBeVisible();
  await fillPolicy(page, narrower, "Keep my draft after concurrent owner update");
  const newer = await savePolicy(page, { ...launch, allowedPresetsVnd: [50_000, 100_000, 200_000] }, "Concurrent owner update");
  await page.getByRole("button", { name: "Lưu chính sách", exact: true }).click();
  await expect(page.getByText("Chính sách đã thay đổi ở nơi khác.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Tải chính sách mới nhất" }).click();
  await expect(page.getByRole("button", { name: "Đã đối chiếu chính sách mới" })).toBeVisible();
  await expect(page.getByLabel("Lý do thay đổi")).toHaveValue("Keep my draft after concurrent owner update");
  await expect(page.getByLabel("Số tiền tối thiểu (VND)", { exact: true })).toHaveValue("30000");
  await expect(page.getByRole("button", { name: "Lưu chính sách", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Đã đối chiếu chính sách mới" }).click();
  await page.getByRole("button", { name: "Lưu chính sách", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: `Đã lưu chính sách phiên bản ${newer.revisionNumber + 1}` })).toBeVisible();
});

test("creator sees fallback, resolves stale policy and explicitly selects three effective presets", async ({ page, browser }) => {
  const owner = await ownerPage(browser);
  try {
    await signIn(page, tipBrowserSessionToken); await page.setViewportSize({ width: 375, height: 1000 }); await page.goto("/creator/tips");
    await page.getByRole("button", { name: "Dừng nhận tip mới", exact: true }).click();
    await savePolicy(owner, narrower);
    await page.getByRole("button", { name: "Lưu cài đặt tip", exact: true }).click();
    await expect(page.getByText("Cài đặt hoặc chính sách đã thay đổi.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Tải lại dữ liệu" }).click();
    await expect(page.getByText("Mức gợi ý đang dùng mặc định mới", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dừng nhận tip mới", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Dùng ba mức đang hiển thị" }).click();
    await page.getByRole("button", { name: "Bật nhận tip", exact: true }).click();
    await page.getByRole("button", { name: "Gợi ý 30.000 ₫", exact: true }).click();
    await page.getByRole("button", { name: "Lưu cài đặt tip", exact: true }).click();
    await expect(page.getByText("Chọn đúng ba mức trong chính sách hiện tại.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Gợi ý 200.000 ₫", exact: true }).focus(); await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Lưu cài đặt tip", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Đã bật nhận tip và lưu ba mức gợi ý." })).toBeVisible();
    await expect(page.getByText("Mức gợi ý đang dùng mặc định mới", { exact: true })).toHaveCount(0);
    const { settings } = await (await page.request.get("/api/v1/creator/tip-settings")).json();
    expect(settings.enabled).toBe(true); expect(settings.presetsVnd).toEqual([50_000, 100_000, 200_000]); expect(settings.presetsFallback).toBe(false);
    await assertAccessible(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("creator-effective-presets-375.png"), fullPage: true });
  } finally { await owner.context().close(); }
});

for (const failRefresh of [false, true]) test(`stale buyer amount refresh preserves entered content${failRefresh ? " after a failed refresh" : ""}`, async ({ page, browser }) => {
  const owner = await ownerPage(browser);
  try {
    await page.goto(`/creators/${tipBrowserHandle}`);
    await page.getByLabel("Số tiền (VND)", { exact: true }).fill("20000");
    await page.getByLabel("Tên hiển thị (không bắt buộc)").fill("Keep buyer name");
    await page.getByLabel("Lời nhắn (không bắt buộc)").fill("Keep buyer message <script>literal</script>");
    await savePolicy(owner, narrower);
    if (failRefresh) await page.route(`**${offeringEndpoint}`, async (route) => { if (route.request().method() === "GET") await route.abort("failed"); else await route.continue(); });
    await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
    if (failRefresh) {
      await expect(page.getByRole("button", { name: "Tải lại mức gợi ý" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" })).toBeDisabled();
      await page.unroute(`**${offeringEndpoint}`); await page.getByRole("button", { name: "Tải lại mức gợi ý" }).click();
    }
    await expect(page.getByRole("button", { name: "Tip 30.000 ₫", exact: true })).toBeVisible();
    await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toHaveValue("20000");
    await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Tên hiển thị (không bắt buộc)")).toHaveValue("Keep buyer name");
    await expect(page.getByLabel("Lời nhắn (không bắt buộc)")).toHaveValue("Keep buyer message <script>literal</script>");
    await expect(page.getByRole("region", { name: "Hướng dẫn chuyển khoản" })).toHaveCount(0);
    await page.getByRole("button", { name: "Tip 50.000 ₫", exact: true }).click();
    const creation = page.waitForResponse((r) => new URL(r.url()).pathname === offeringEndpoint && r.request().method() === "POST");
    await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
    const result = await creation; expect(result.status()).toBe(201); expect((await result.json()).instruction.amountVnd).toBe(50_000);
  } finally { await owner.context().close(); }
});

test("owner can prepare policy while receiving is disabled", async ({ page }) => {
  await signIn(page, tipPolicyOwnerSessionToken); await page.goto("http://127.0.0.1:4178/admin/tip-policy");
  await expect(page.getByText("Nhận tip đang tạm đóng", { exact: true })).toBeVisible();
  await fillPolicy(page, narrower, "Prepare policy while tips are disabled");
  await page.getByRole("button", { name: "Lưu chính sách", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu chính sách phiên bản" })).toBeVisible();
  const response = await page.request.get("http://127.0.0.1:4178/api/v1/admin/tip-policy");
  const state = await response.json(); expect(state.paymentsEnabled).toBe(false); expect(state.policy).toMatchObject(narrower);
});

test("owner history pages through immutable actual revisions", async ({ page }) => {
  await signIn(page, tipPolicyOwnerSessionToken);
  // Seed additional local history through the real Catalog service and Identity
  // owner/proof ports. No revision rows or current pointer are rewritten/deleted.
  const db = createDatabase(browserDatabaseUrl);
  try {
    const service = createPlatformTipPolicyService({ db: db.db, applicationRevision: "synthetic-history-pagination", commandFingerprintKey: new Uint8Array(32).fill(2), ...createOwnerTipPolicyAssurancePort() });
    for (let i = 0; i < 26; i++) {
      const previous = await currentPolicy(page);
      await service.savePolicy({ actor: { userId: tipPolicyOwnerUserId, sessionId: tipPolicyOwnerSessionId }, expectedRevision: previous.revisionNumber, ...launch, reason: `Synthetic history entry ${i}`, idempotencyKey: randomUUID(), requestId: randomUUID() });
    }
  } finally { await db.close(); }
  await page.goto("/admin/tip-policy");
  await expect(page.getByRole("row").filter({ hasText: "Synthetic history entry 25" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lịch sử cũ hơn" })).toBeEnabled();
  await page.getByRole("button", { name: "Lịch sử cũ hơn" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Synthetic history entry 0" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Synthetic history entry 25" })).toHaveCount(0);
  await page.getByRole("button", { name: "Lịch sử mới hơn" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Synthetic history entry 25" })).toBeVisible();
});

test("owner page and policy history remain inaccessible to anonymous and creator sessions", async ({ page }) => {
  await page.goto("/admin/tip-policy"); await expect(page).toHaveURL(/\/sign-in$/u);
  const anonymous = await page.request.get(endpoint); expect(anonymous.status()).toBe(401);
  expect(await anonymous.json()).toEqual({ code: "authentication_required" });
  await signIn(page, tipBrowserSessionToken);
  const hidden = await page.goto("/admin/tip-policy"); expect(hidden!.status()).toBe(404);
  const creator = await page.request.get(endpoint); expect(creator.status()).toBe(403);
  expect(await creator.json()).toEqual({ code: "owner_required" });
});
