import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { build } from "tsup";

const webRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(webRoot, ".playwright-artifacts", "foundation-bundle");
let bundle: string;
let stylesheetLinks: string;

test.beforeAll(async () => {
  await build({
    entry: [path.join(import.meta.dirname, "ui-foundation-fixture.tsx").replaceAll("\\", "/")],
    outDir,
    format: ["iife"],
    platform: "browser",
    noExternal: [/.*/],
    tsconfig: path.join(webRoot, "tsconfig.json"),
    config: false,
    splitting: false,
    silent: true,
    define: { "process.env.NODE_ENV": '"production"' },
    esbuildOptions(options) { options.jsx = "automatic"; },
  });
  bundle = await readFile(path.join(outDir, "ui-foundation-fixture.global.js"), "utf8");
  const cssFiles = await readdir(path.join(webRoot, ".next", "static", "css"));
  stylesheetLinks = cssFiles.filter((file) => file.endsWith(".css"))
    .map((file) => `<link rel="stylesheet" href="/_next/static/css/${file}">`).join("");
});

for (const width of [375, 1440]) {
  test(`reviewed Base UI components at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Serve a test document with the actual production CSS. No test route is
    // included in Next's route tree and no payment/backend mutation is needed.
    await page.route("**/__tests/foundation.js", (route) => route.fulfill({ contentType: "text/javascript", body: bundle }));
    await page.route("**/__tests/foundation", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI fixture</title>${stylesheetLinks}</head><body><div id="fixture"></div><script src="/__tests/foundation.js"></script></body></html>`,
    }));
    await page.goto("/__tests/foundation");
    const name = page.getByLabel("Tên hiển thị");
    await expect(name).toBeVisible();
    // Default Nova control dimensions must come from utilities, not the old
    // unlayered button/input element styles. Focus remains Pawket's solid ring.
    await expect(name).toHaveCSS("height", "32px");
    await expect(name).toHaveCSS("border-top-width", "1px");
    await page.keyboard.press("Tab");
    await expect(name).toBeFocused();
    await expect(name).toHaveCSS("outline-style", "solid");
    await expect(name).toHaveCSS("outline-width", "2px");
    await name.fill("Khách thử nghiệm");
    await expect(page.getByLabel("Giá trị thử nghiệm")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator('[data-slot="input-group"]')).toHaveCSS("border-top-width", "1px");
    await expect(page.getByLabel("Giá trị thử nghiệm")).toHaveCSS("border-top-width", "0px");
    await page.getByRole("button", { name: "Mẫu A", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    const choice = page.getByRole("button", { name: "Mẫu B", exact: true });
    await expect(choice).toBeFocused();
    await page.keyboard.press("Space");
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Đang xử lý" })).toBeDisabled();
    const trigger = page.getByRole("button", { name: "Xem hộp thoại" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Kiểm tra bằng bàn phím" });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", { name: "Đóng thử nghiệm" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    const dialogA11y = await new AxeBuilder({ page }).analyze();
    expect(dialogA11y.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCSS("animation-duration", "1e-05s");
    expect(errors).toEqual([]);
  });
}
