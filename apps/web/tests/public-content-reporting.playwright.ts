import { expect, test } from "@playwright/test";
import { currentOwnerTotp, signInAsCreator, signInAsOwner } from "./increment-three-fixture";

test("public creator page offers contextual reporting without reporter identity", async ({ page }) => {
  // Break caught: reporting is absent, detached from the publication revision, or requests identity.
  await page.goto("/creators/artist-one");
  await expect(page.getByRole("button", { name: "Báo cáo trang này" })).toBeVisible();
  await page.getByRole("button", { name: "Báo cáo trang này" }).click();
  await expect(page.getByLabel("Lý do báo cáo")).toBeVisible();
  await expect(page.getByLabel(/email|tên người báo cáo/iu)).toHaveCount(0);
  await page.getByLabel("Chi tiết").fill("Synthetic Task 15 privacy detail");

  await page.getByRole("button", { name: "Gửi báo cáo" }).click();
  const cancel = page.getByRole("button", { name: "Hủy tạo bằng chứng" });
  await expect(cancel).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Đã thử" })).toBeVisible();
  await cancel.click();
  await expect(page.getByRole("button", { name: "Gửi báo cáo" })).toBeEnabled();

  await page.getByRole("button", { name: "Gửi báo cáo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã nhận báo cáo" })).toBeVisible({ timeout: 120_000 });

  await page.goto("/creators/artist-one");
  await expect(page.getByRole("heading", { name: "Artist One" })).toBeVisible();
});

test("owner report queue hides and restores the target with fresh TOTP without reporter identity", async ({ page }) => {
  // Break caught: owner triage leaks reporter identity or applies unaudited visibility changes without TOTP step-up.
  await signInAsOwner(page);
  await page.goto("/admin/content-reports");
  await expect(page.getByRole("heading", { name: "Báo cáo nội dung công khai" })).toBeVisible();
  await expect(page.getByText("Synthetic Task 15 privacy detail").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/reporter|người báo cáo|reporterUserId/iu);

  const report = page.locator("article").filter({ hasText: "Synthetic Task 15 privacy detail" }).first();
  await report.getByRole("button", { name: "Ẩn mục tiêu" }).click();
  await page.getByLabel("Mã TOTP").fill(currentOwnerTotp());
  await page.getByRole("button", { name: "Xác minh và thử lại" }).click();
  await expect(page.getByText("Đã ẩn mục tiêu và ghi audit event.")).toBeVisible();

  const hidden = await page.goto("/creators/artist-one");
  expect(hidden?.status()).toBe(404);

  await page.goto("/admin/content-reports");
  const heldReport = page.locator("article").filter({ hasText: "Synthetic Task 15 privacy detail" }).first();
  await heldReport.getByRole("button", { name: "Khôi phục mục tiêu" }).click();
  await expect(page.getByText("Đã khôi phục mục tiêu và ghi audit event.")).toBeVisible();

  await page.goto("/creators/artist-one");
  await expect(page.getByRole("heading", { name: "Artist One" })).toBeVisible();
});

test("suspension and reinstatement never republish until the creator explicitly publishes", async ({ page }) => {
  // Break caught: reinstating a capability silently republishes the prior public revision.
  await signInAsCreator(page);
  await page.goto("/creator");
  await page.getByLabel("Tên hiển thị").fill("Suspension draft");
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();

  await signInAsOwner(page);
  await page.goto("/admin/creator-applications");
  await page.getByRole("button", { name: /Quyền creator/u }).click();
  const creator = page.locator(".item-row").filter({ hasText: "task15-creator" });
  await creator.getByRole("button", { name: "Tạm dừng" }).click();
  await expect(page.getByText("Đã tạm dừng quyền creator.")).toBeVisible();

  expect((await page.goto("/creators/artist-one"))?.status()).toBe(404);

  await page.goto("/admin/creator-applications");
  await page.getByRole("button", { name: /Quyền creator/u }).click();
  await page.locator(".item-row").filter({ hasText: "task15-creator" }).getByRole("button", { name: "Khôi phục" }).click();
  await expect(page.getByText("Đã khôi phục quyền creator.")).toBeVisible();
  expect((await page.goto("/creators/artist-one"))?.status()).toBe(404);

  await signInAsCreator(page);
  await page.goto("/creator");
  await page.getByRole("button", { name: "Xuất bản trang" }).click();
  await expect(page.getByText("Trang đã được xuất bản.")).toBeVisible();
  await page.goto("/creators/artist-one");
  await expect(page.getByRole("heading", { name: "Suspension draft" })).toBeVisible();

  await page.goto("/creator");
  await page.getByLabel("Tên hiển thị").fill("Artist One");
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();
  await page.getByRole("button", { name: "Xuất bản trang" }).click();
  await expect(page.getByText("Trang đã được xuất bản.")).toBeVisible();
});
