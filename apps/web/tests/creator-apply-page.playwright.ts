import { expect, test } from "@playwright/test";

test("Save Draft bypasses incomplete required fields while Submit remains browser completeness-gated", async ({ page }) => {
  // Break caught: browser constraint validation blocking a private draft save, or allowing an incomplete submission.
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        application: {
          id: "draft-1",
          state: path.endsWith("/submit") ? "submitted" : "draft",
          version: path.endsWith("/submit") ? 2 : 1,
        },
      }),
    });
  });

  await page.goto("/creator/apply");
  await page.getByRole("button", { name: "Lưu bản nháp" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã lưu bản nháp riêng tư.");

  await page.getByRole("button", { name: "Gửi hồ sơ" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã lưu bản nháp riêng tư.");
});
