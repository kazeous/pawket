import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("directory validates filters and remains responsive and accessible", async ({ page }) => {
  // Break caught: directory is missing, overflows narrow viewports, or introduces serious accessibility violations.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/creators?discipline=illustration&handle=art");
    await expect(page.getByRole("heading", { name: "Khám phá nhà sáng tạo" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Artist One" })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll, `directory overflowed at ${width}px`).toBeLessThanOrEqual(dimensions.client);
  }
  await page.getByRole("combobox", { name: "Chuyên ngành" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Handle bắt đầu bằng")).toBeFocused();
  expect(await page.getByLabel("Handle bắt đầu bằng").evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");

  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const zoomed = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(zoomed.scroll, "directory overflowed at 200% zoom").toBeLessThanOrEqual(zoomed.client);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});

test("alias redirects to canonical metadata without exposing hidden state", async ({ page }) => {
  // Break caught: aliases render duplicate pages or metadata points at a non-canonical handle.
  await page.goto("/creators/former-name");
  await expect(page).toHaveURL(/\/creators\/artist-one$/u);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/creators\/artist-one$/u);
  await expect(page).toHaveTitle("Artist One · Pawket");
});

test("unknown creator uses one neutral not-found response", async ({ page }) => {
  // Break caught: public resolution discloses whether a creator is draft, hidden, suspended, or unknown.
  const response = await page.goto("/creators/not-a-real-creator");
  expect(response?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText(/draft|hidden|suspended|application|bank|payment/iu);
});
