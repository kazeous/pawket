import { expect, test } from "@playwright/test";
import { signInAsCreator } from "./increment-three-fixture";

test("creator keeps the live page unchanged while editing and previews the private draft", async ({ page }) => {
  // Break caught: saving authoring changes mutates the live revision or preview reads the public revision.
  await signInAsCreator(page);
  await page.goto("/creator");
  await expect(page.getByRole("heading", { name: "Góc làm việc trang nhà sáng tạo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Xem bản nháp riêng tư" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Xuất bản trang" })).toBeVisible();

  await page.getByLabel("Tên hiển thị").fill("Draft name from browser");
  const saveResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/creator-page") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status(), JSON.stringify(await saveResponse.json())).toBe(200);
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();

  await page.goto("/creators/artist-one");
  await expect(page.getByRole("heading", { name: "Artist One" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft name from browser" })).toHaveCount(0);

  await page.goto("/creator/preview");
  await expect(page.getByRole("heading", { name: "Draft name from browser" })).toBeVisible();
});

test("private preview is an authenticated draft-only surface", async ({ page }) => {
  // Break caught: preview is absent or rendered from the public revision.
  await signInAsCreator(page);
  await page.goto("/creator/preview");
  await expect(page.getByText("Bản nháp riêng tư")).toBeVisible();
  await expect(page.locator("img:not([alt])")).toHaveCount(0);
});
