import { expect, test } from "@playwright/test";
import { signInAsCreator, syntheticPng } from "./increment-three-fixture";
import { resetIncrementThreeState } from "./increment-three-global-setup";

test.beforeEach(async () => resetIncrementThreeState());

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

test("creator authors disciplines, profile media, and showcase media through the real worker", async ({ browser, page }) => {
  // Break caught: the workspace exposes status placeholders but cannot author/process complete media-backed content.
  test.setTimeout(180_000);
  await signInAsCreator(page);
  await page.goto("/creator");
  const secondary = page.getByRole("checkbox", { name: "drawing" });
  await expect(secondary).toBeVisible({ timeout: 5_000 });
  await secondary.check();
  const avatarIntentPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/creator-page/media/uploads") && response.request().method() === "POST");
  await page.getByLabel("Tải ảnh đại diện").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: syntheticPng });
  const avatarIntent = await avatarIntentPromise;
  expect(avatarIntent.status(), await avatarIntent.text()).toBe(200);
  await expect(page.getByText("Ảnh đại diện đã sẵn sàng.")).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("Tải ảnh bìa").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: syntheticPng });
  await expect(page.getByText("Ảnh bìa đã sẵn sàng.")).toBeVisible({ timeout: 90_000 });

  await page.getByLabel("Tên showcase").fill("Browser showcase");
  await page.getByLabel("Mô tả showcase").fill("Created through the real authoring boundary.");
  await page.getByLabel("Liên kết tác phẩm").fill("https://example.com/browser-showcase");
  await page.getByRole("button", { name: "Tạo showcase" }).click();
  const showcase = page.locator(".showcase-editor__item");
  await showcase.getByLabel("Chuyên ngành showcase đã lưu").selectOption("painting");
  await showcase.getByLabel("Mô tả thay thế cho ảnh mới").fill("Mô tả ban đầu sẽ được thay thế");
  await showcase.getByLabel("Thêm ảnh showcase").setInputFiles({ name: "showcase.png", mimeType: "image/png", buffer: syntheticPng });
  await expect(page.getByText("Ảnh showcase đã sẵn sàng.")).toBeVisible({ timeout: 90_000 });
  const savedAlt = showcase.locator('input[id^="showcase-alt-"]');
  await savedAlt.fill("Mô tả đã sửa trước khi gỡ");
  await showcase.getByRole("button", { name: "Lưu showcase" }).click();
  await expect(page.getByText("Đã lưu showcase.")).toBeVisible();
  await showcase.getByRole("button", { name: "Gỡ ảnh khỏi showcase" }).click();
  await expect(page.getByText("Đã gỡ ảnh khỏi showcase.")).toBeVisible();
  await expect(savedAlt).toHaveCount(0);
  await showcase.getByLabel("Mô tả thay thế cho ảnh mới").fill("Ô vuông xanh do creator mô tả");
  await showcase.getByLabel("Thêm ảnh showcase").setInputFiles({ name: "showcase-replacement.png", mimeType: "image/png", buffer: syntheticPng });
  await expect(page.getByText("Ảnh showcase đã sẵn sàng.")).toBeVisible({ timeout: 90_000 });

  await page.goto("/creator/preview");
  const previewImages = page.locator("img");
  await expect(previewImages).toHaveCount(3);
  await expect(page.getByAltText("Ảnh đại diện của Draft name")).toBeVisible();
  await expect(page.getByAltText("Ô vuông xanh do creator mô tả")).toBeVisible();
  for (const image of await previewImages.all()) {
    expect(Number(await image.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(await image.getAttribute("height"))).toBeGreaterThan(0);
  }
  const privateSource = await previewImages.last().getAttribute("src");
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(new URL(privateSource!, page.url()).toString())).status()).toBe(404);
  await anonymous.close();

  await page.goto("/creator");
  await page.getByRole("button", { name: "Xuất bản trang" }).click();
  await expect(page.getByText("Trang đã được xuất bản.")).toBeVisible();
  await page.goto("/creators/artist-one");
  await expect(page.locator("img")).toHaveCount(3);
  await expect(page.getByAltText("Ảnh đại diện của Draft name")).toBeVisible();
  await expect(page.getByAltText("Ô vuông xanh do creator mô tả")).toBeVisible();
  await expect(page.getByText("drawing")).toBeVisible();
  await expect(page.getByText("painting")).toBeVisible();
  await expect(page.getByRole("link", { name: "Mở tác phẩm ngoài Pawket" })).toHaveAttribute("href", "https://example.com/browser-showcase");
});

test("true version conflicts refresh authority without replacing typed profile or showcase edits", async ({ page }) => {
  // Break caught: every 409 is mislabeled or a stale reorder destroys the creator's unsent input.
  await signInAsCreator(page);
  await page.goto("/creator");
  const newShowcaseTitle = page.locator("#new-showcase-title");
  await newShowcaseTitle.fill("First ordered work");
  await page.getByRole("button", { name: "Tạo showcase" }).click();
  await expect(page.locator(".showcase-editor__item")).toHaveCount(1);
  await newShowcaseTitle.fill("Second ordered work");
  await page.getByRole("button", { name: "Tạo showcase" }).click();
  await expect(page.locator(".showcase-editor__item")).toHaveCount(2);
  await page.getByLabel("Tên hiển thị").fill("Unsent local profile");
  const second = page.locator(".showcase-editor__item").nth(1);
  await second.getByLabel("Tên showcase đã lưu").fill("Unsent local showcase");
  const workspace = await (await page.request.get("/api/v1/creator-page")).json();
  const staleVersion = workspace.workspace.draftVersion as number;
  const concurrent = await page.request.post("/api/v1/creator-page/showcases", {
    headers: { Origin: "http://127.0.0.1:4175", "Idempotency-Key": crypto.randomUUID(), "If-Match": String(staleVersion) },
    data: {
      pageId: workspace.workspace.pageId,
      action: "reorder",
      showcaseIds: [...workspace.workspace.showcases].reverse().map((showcase: { id: string }) => showcase.id),
    },
  });
  expect(concurrent.status()).toBe(200);
  await second.getByRole("button", { name: "Di chuyển lên" }).click();
  await expect(page.getByText(/Bản nháp trên máy chủ đã thay đổi/u)).toBeVisible();
  await expect(page.getByLabel("Tên hiển thị")).toHaveValue("Unsent local profile");
  const orderedTitles = page.getByLabel("Tên showcase đã lưu");
  await expect(orderedTitles.nth(0)).toHaveValue("Unsent local showcase");
  await expect(orderedTitles.nth(1)).toHaveValue("First ordered work");
});

test("suspended creator can remediate private content but cannot claim, rename, or publish", async ({ page }) => {
  // Break caught: suspension locks the creator out of private remediation or accidentally permits a public mutation.
  test.setTimeout(180_000);
  const { currentOwnerTotp, signInAsOwner } = await import("./increment-three-fixture");
  await signInAsOwner(page);
  await page.goto("/admin/creator-applications");
  await page.getByRole("button", { name: /Quyền creator/u }).click();
  await page.locator(".item-row").filter({ hasText: "task15-creator" }).getByRole("button", { name: "Tạm dừng" }).click();
  await page.getByLabel("Mã TOTP").fill(currentOwnerTotp());
  await page.getByRole("button", { name: "Xác minh & thử lại" }).click();
  await expect(page.getByText("Đã tạm dừng quyền creator.")).toBeVisible();

  await signInAsCreator(page);
  await page.goto("/creator");
  await expect(page.getByText(/Quyền creator đang tạm dừng/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /Đổi handle|Nhận handle/u })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Xuất bản trang" })).toBeDisabled();
  await page.getByLabel("Tên hiển thị").fill("Private remediation draft");
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();
  await page.getByLabel("Tải ảnh bìa").setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: syntheticPng });
  await expect(page.getByText("Ảnh bìa đã sẵn sàng.")).toBeVisible({ timeout: 90_000 });
  await page.goto("/creator/preview");
  await expect(page.getByRole("heading", { name: "Private remediation draft" })).toBeVisible();
  expect((await page.request.get("/creators/artist-one")).status()).toBe(404);
});

test("handle cooldown is not mislabeled as a version conflict", async ({ page }) => {
  // Break caught: non-version 409 responses are collapsed into misleading conflict recovery.
  await signInAsCreator(page);
  await page.goto("/creator");
  await page.getByLabel("Handle").fill("artist-renamed-too-soon");
  await page.getByRole("button", { name: "Đổi handle" }).click();
  await expect(page.getByText(/chỉ có thể đổi handle sau/u)).toBeVisible();
  await expect(page.getByText(/Bản nháp trên máy chủ đã thay đổi/u)).toHaveCount(0);
});
