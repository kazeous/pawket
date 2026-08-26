import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const accountPayload = {
  user: {
    id: "user-owner",
    displayName: "Hishou",
    displayEmail: "hishou@kazeous.com",
    emailVerified: true,
    accessStatus: "active",
  },
};

async function mockSignedInAccount(page: Page) {
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(accountPayload),
    });
  });
}

test("the shared shell identifies the signed-in account without mobile overflow", async ({ page }) => {
  await mockSignedInAccount(page);

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByText("Đã đăng nhập", { exact: true })).toBeVisible();
    await expect(page.getByText("hishou@kazeous.com", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
    if (process.env.HALLMARK_SCREENSHOT_DIR) {
      await page.screenshot({
        fullPage: true,
        path: `${process.env.HALLMARK_SCREENSHOT_DIR}/account-shell-${width}.png`,
      });
    }
    const dimensions = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scroll, `account controls overflowed at ${width}px`).toBeLessThanOrEqual(
      dimensions.client,
    );
  }

  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(path.endsWith("/receiving-account") ? { account: null } : { application: null }),
    });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/creator/apply");
  await expect(page.getByRole("link", { name: "Bảo mật", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
  if (process.env.HALLMARK_SCREENSHOT_DIR) {
    await page.screenshot({
      fullPage: true,
      path: `${process.env.HALLMARK_SCREENSHOT_DIR}/protected-account-shell-320.png`,
    });
  }
  const protectedDimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(protectedDimensions.scroll).toBeLessThanOrEqual(protectedDimensions.client);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});

test("logout reports an in-flight state and gives an actionable failure", async ({ page }) => {
  await mockSignedInAccount(page);
  await page.route("**/api/auth/sign-out", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "AUTHENTICATION_UNAVAILABLE" }),
    });
  });

  await page.goto("/");
  const signOut = page.getByRole("button", { name: "Đăng xuất" });
  await signOut.click();
  await expect(page.getByRole("button", { name: "Đang đăng xuất…" })).toBeDisabled();
  await expect(page.getByText("Không thể đăng xuất. Hãy thử lại.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeEnabled();
});

test("successful logout returns to sign in and clears the account indicator", async ({ page }) => {
  let signedOut = false;
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill(
      signedOut
        ? { status: 401, contentType: "application/json", body: JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }) }
        : { contentType: "application/json", body: JSON.stringify(accountPayload) },
    );
  });
  await page.route("**/api/auth/sign-out", async (route) => {
    signedOut = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page).toHaveURL(/\/sign-in$/u);
  await expect(page.getByText("hishou@kazeous.com", { exact: true })).toHaveCount(0);
});

test("an anonymous session shows sign in without claiming an account", async ({ page }) => {
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }),
    });
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Đăng nhập" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toHaveCount(0);
  await expect(page.getByText("Đã đăng nhập", { exact: true })).toHaveCount(0);
});

test("an account lookup outage is explicit and retryable", async ({ page }) => {
  let recovered = false;
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill(
      recovered
        ? { contentType: "application/json", body: JSON.stringify(accountPayload) }
        : { status: 503, contentType: "application/json", body: JSON.stringify({ code: "IDENTITY_UNAVAILABLE" }) },
    );
  });

  await page.goto("/");
  await expect(page.getByText("Không thể xác định phiên", { exact: true })).toBeVisible();
  recovered = true;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByText("hishou@kazeous.com", { exact: true })).toBeVisible();
});
