import { expect, test } from "@playwright/test";
import { signInAsCreator } from "./increment-three-fixture";

test("publishing disabled exposes no state-changing creator controls", async ({ page }) => {
  // Break caught: disabled publishing accidentally exposes authoring mutations.
  await signInAsCreator(page);
  await page.goto("/creator");
  await expect(page.getByRole("heading", { name: "Trang nhà sáng tạo chưa khả dụng" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Xuất bản/u })).toHaveCount(0);
});

test("publishing disabled exposes no public directory, creator page, media, or sitemap entry", async ({ request }) => {
  // Break caught: a disabled deployment leaks any public creator surface.
  expect((await request.get("/creators")).status()).toBe(404);
  expect((await request.get("/creators/artist-one")).status()).toBe(404);
  expect((await request.get("/media/00000000-0000-4000-8000-000000000001/thumb")).status()).toBe(404);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).not.toContain("/creators/");
});
