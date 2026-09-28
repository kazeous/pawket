import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { signInAsCreator, signInAsOwner } from "./increment-three-fixture";

async function assertAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
}

async function snapshot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    // Repeated pre-change captures vary by up to 1,745 edge pixels in the
    // narrow disabled card (fractional text/grid rasterization on Windows).
    // All other captured states must match exactly.
    maxDiffPixels: name === "creator-disabled-375" ? 2_000 : 0,
  });
}

async function tabTo(page: Page, target: Locator) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) {
      await expect(target).toBeFocused();
      const focus = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return { visible: element.matches(":focus-visible"), width: style.outlineWidth, style: style.outlineStyle };
      });
      expect(focus.visible).toBe(true);
      expect(focus.width).not.toBe("0px");
      expect(focus.style).not.toBe("none");
      return;
    }
  }
  throw new Error("Expected control could not be reached with the keyboard");
}

async function mockCreatorApplication(page: Page) {
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path.endsWith("/receiving-account") ? { account: null } : { application: null } });
  });
}

async function mockAccountSummary(page: Page, role: "creator" | "owner") {
  // Freeze the shared shell's client projection; server route authorization
  // still uses the real, isolated PostgreSQL session fixture.
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: {
    user: { displayName: `Synthetic ${role}`, displayEmail: `${role}@example.test` },
  } }));
}

async function mockOwnerQueue(page: Page) {
  await page.route("**/api/v1/admin/creator-applications", (route) => route.fulfill({ json: { applications: [] } }));
  await page.route("**/api/v1/admin/creator-capabilities", (route) => route.fulfill({ json: { capabilities: [] } }));
  await page.route("**/api/v1/admin/refund-obligations", (route) => route.fulfill({ json: { obligations: [] } }));
}

for (const width of [375, 1440]) {
  test.describe(`${width}px preserved UI`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("public home and sign-in", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Đăng nhập", exact: true })).toBeVisible();
      await assertAccessible(page);
      await snapshot(page, `home-${width}`);
      await page.goto("/sign-in");
      const email = page.getByRole("button", { name: "Đăng nhập với reyuuGAMES" });
      await tabTo(page, email);
      await assertAccessible(page);
      await snapshot(page, `sign-in-focus-${width}`);
    });

    test("security and creator application", async ({ page }) => {
      await signInAsCreator(page);
      await mockAccountSummary(page, "creator");
      await page.route("**/api/v1/me/sessions", (route) => route.fulfill({ json: { sessions: [{ id: "synthetic-session", deviceLabel: "Chromium", isCurrent: true, lastUsedAt: "2026-09-12T00:00:00.000Z" }] } }));
      await page.goto("/settings/security");
      await expect(page.getByRole("button", { name: "Thu hồi phiên Chromium hiện tại" })).toBeVisible();
      await expect(page.getByText("Đã đăng nhập", { exact: true })).toBeVisible();
      await assertAccessible(page);
      await snapshot(page, `security-${width}`);
      await mockCreatorApplication(page);
      await page.goto("/creator/apply");
      await expect(page.getByRole("button", { name: "Lưu bản nháp" })).toBeEnabled();
      await assertAccessible(page);
      await snapshot(page, `creator-application-${width}`);
    });

    test("owner workbench and disabled creator/public states", async ({ page }) => {
      await signInAsOwner(page);
      await mockAccountSummary(page, "owner");
      await mockOwnerQueue(page);
      await page.goto("/admin/creator-applications");
      await expect(page.getByRole("button", { name: "Hàng đợi (0)" })).toBeVisible();
      await expect(page.getByText("Đã đăng nhập", { exact: true })).toBeVisible();
      await assertAccessible(page);
      await snapshot(page, `owner-${width}`);
      await signInAsCreator(page);
      await mockAccountSummary(page, "creator");
      await page.goto("/creator");
      await expect(page.getByRole("heading", { name: "Trang nhà sáng tạo chưa khả dụng" })).toBeVisible();
      await expect(page.getByText("creator@example.test", { exact: true })).toBeVisible();
      await assertAccessible(page);
      await snapshot(page, `creator-disabled-${width}`);
      await page.context().clearCookies();
      await page.unroute("**/api/v1/me");
      expect((await page.goto("/creators"))?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
      await assertAccessible(page);
      await snapshot(page, `public-disabled-${width}`);
    });

    test("SSO loading and service error preserve public navigation", async ({ page }) => {
      let releaseResponse!: () => void;
      const pendingResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
      let submissions = 0;
      await page.route("**/api/v1/auth/oidc/start", async (route) => {
        submissions++; expect(route.request().postDataJSON()).toEqual({ returnPath: "/settings/security" });
        await pendingResponse; await route.fulfill({ status: 503, json: { code: "provider_unavailable" } });
      });
      await page.goto("/sign-in");
      await page.getByRole("button", { name: "Đăng nhập với reyuuGAMES", exact: true }).click();
      await expect(page.getByRole("button", { name: "Đang chuyển đến trang tài khoản…" })).toBeDisabled();
      try { await snapshot(page, 'sign-in-pending-' + width); } finally { releaseResponse(); }
      await expect(page.getByRole("alert").filter({ hasText: "Chưa thể kết nối dịch vụ tài khoản." })).toBeVisible();
      expect(submissions).toBe(1); await assertAccessible(page); await snapshot(page, 'sign-in-error-' + width);
    });
  });
}

test("owner SSO review preserves keyboard access, cancel and draft privacy", async ({ page }) => {
  await signInAsOwner(page); await mockAccountSummary(page, "owner"); await mockOwnerQueue(page);
  const id = "a1000000-0000-4000-8000-000000000001"; let cancelled = false;
  await page.route("**/api/v1/admin/creator-capabilities", (route) => route.fulfill({ json: { capabilities: [{ userId: "synthetic-creator", artistDisplayName: "Synthetic Creator", state: "active", version: 1, updatedAt: "2026-09-12T00:00:00.000Z" }] } }));
  await page.route("**/api/v1/admin/creator-capabilities/synthetic-creator", (route) => route.fulfill({ status: 403, json: { code: "OIDC_STEP_UP_REQUIRED", reviewPath: '/auth/review/' + id } }));
  await page.route('**/api/v1/auth/commands/' + id, (route) => {
    if (route.request().method() === "DELETE") { cancelled = true; return route.fulfill({ json: {} }); }
    return route.fulfill({ json: { title: "Tạm dừng quyền creator", body: '{"reason":"Synthetic review only"}', ready: false, returnPath: "/admin/creator-applications", expiresAt: "2099-01-01T00:00:00Z" } });
  });
  await page.goto("/admin/creator-applications"); await page.getByRole("button", { name: "Quyền creator (1)" }).click();
  await tabTo(page, page.getByRole("button", { name: "Tạm dừng", exact: true })); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp('/auth/review/' + id + '$'));
  await expect(page.getByText("Synthetic review only", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Xác nhận thực hiện", exact: true })).toHaveCount(0);
  await assertAccessible(page); await snapshot(page, "owner-step-up");
  await tabTo(page, page.getByRole("button", { name: "Hủy thao tác", exact: true })); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/creator-applications$/u); expect(cancelled).toBe(true);
  await expect(page.getByText("Synthetic review only", { exact: true })).toHaveCount(0);
});
