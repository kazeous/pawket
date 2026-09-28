import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const publicRoutes = ["/", "/register", "/sign-in", "/forgot-password", "/verify-email/resend", "/creators"];

for (const width of [320, 375, 414, 768]) {
  test(`public UI has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of publicRoutes) {
      await page.goto(route);
      const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(dimensions.scroll, `${route} overflowed at ${width}px`).toBeLessThanOrEqual(dimensions.client);
    }
  });
}

test("public identity journeys have no serious axe violations", async ({ page }) => {
  for (const route of publicRoutes) {
    await page.goto(route);
    const results = await new AxeBuilder({ page }).analyze();
    const severe = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    if (severe.length > 0) {
      console.error(
        `${route}: ${severe.map((violation) => `${violation.id} — ${violation.nodes.map((node) => `${node.target.join(" ")}: ${node.html}`).join(" | ")}`).join(", ")}`,
      );
    }
    expect(severe, route).toEqual([]);
  }
});

test("creator workbench remains accessible and narrow-screen safe", async ({ page }) => {
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(path.endsWith("/receiving-account") ? { account: null } : { application: null }),
    });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/creator/apply");
  await expect(page.getByRole("heading", { name: "Hồ sơ nhà sáng tạo" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});

test("retired challenge links discard tokens without submitting credentials", async ({ page }) => {
  const token = "challenge-token-that-is-long-enough";
  let submittedToken: unknown;
  await page.route("**/api/v1/auth/email-verification/complete", async (route) => {
    submittedToken = route.request().postDataJSON().token;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verified: true }) });
  });
  await page.goto(`/verify-email?token=${token}`);
  await expect(page).toHaveURL(/\/sign-in\?notice=auth_moved$/);
  await expect(page.getByRole("button", { name: "Đăng nhập với reyuuGAMES" })).toBeVisible();
  expect(submittedToken).toBeUndefined();
  await expect(page.locator("body")).not.toContainText(token);
});

test("SSO outage is actionable and public pages remain available", async ({ page }) => {
  await page.route("**/api/v1/auth/oidc/start", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "provider_unavailable" }),
    });
  });
  await page.goto("/register");
  await page.getByRole("button", { name: "Đăng nhập với reyuuGAMES" }).click();

  await expect(page.getByText("Chưa thể kết nối dịch vụ tài khoản.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/HIBP|SHA-1|provider|IDENTITY_/iu);
  expect((await page.goto("/"))?.status()).toBe(200);
});
