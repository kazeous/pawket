import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createDatabase, paymentIntents, paymentTransferClaims } from "@pawket/database";
import { createIdentityTipAssurancePort } from "@pawket/identity";
import { createCreatorTipPaymentService } from "@pawket/payments";
import { createTipLifecyclePort } from "@pawket/tips";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";
import { eq } from "drizzle-orm";
import { browserDatabaseUrl } from "./increment-three-database";
import { tipBrowserAccount, tipBrowserHandle, tipBrowserUserId, tipBrowserSessionId } from "./increment-four-global-setup";

const creatorPath = `/creators/${tipBrowserHandle}`;
const creationPath = `/api/v1/public/creators/${tipBrowserHandle}/tips`;
async function createBrowserTip(page: Page) {
  await page.goto(creatorPath);
  await page.getByLabel("Tên hiển thị (không bắt buộc)").fill("Synthetic private receipt guest");
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === creationPath);
  await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
  const response = await created; expect(response.status()).toBe(201);
  return (await response.json()).instruction.reference as string;
}
async function receiptFacts(reference: string) {
  const database = createDatabase(browserDatabaseUrl);
  try {
    const referenceHash = createLookupHmac({ key: new Uint8Array(32).fill(2), context: "tip-transfer-reference", value: reference });
    const [intent] = await database.db.select().from(paymentIntents).where(eq(paymentIntents.referenceHash, referenceHash));
    const claims = await database.db.select().from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intent!.id));
    return { intent: intent!, claims };
  } finally { await database.close(); }
}
async function confirmSyntheticReceipt(reference: string) {
  const { intent } = await receiptFacts(reference); const database = createDatabase(browserDatabaseUrl);
  const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
  try {
    await createCreatorTipPaymentService({ db: database.db, keyring, lookupHmacKey: new Uint8Array(32).fill(2), paymentsMode: "manual_only", pageSize: 25,
      recentAuthMs: 900_000, totpAuthMs: 300_000, assurance: createIdentityTipAssurancePort(), tips: createTipLifecyclePort({ keyring }) }).confirm({
      actor: { userId: tipBrowserUserId, sessionId: tipBrowserSessionId }, paymentIntentId: intent.id, observedAmountVnd: intent.amountVnd,
      observedTransferReference: reference, observedBankTransactionId: `SYNTHETIC-${randomUUID()}`, attestedReceived: true, idempotencyKey: randomUUID(), requestId: randomUUID(),
    });
  } finally { await database.close(); }
}
async function countIntents() {
  const database = createDatabase(browserDatabaseUrl);
  try { return (await database.db.select({ id: paymentIntents.id }).from(paymentIntents).where(eq(paymentIntents.creatorUserId, tipBrowserUserId))).length; }
  finally { await database.close(); }
}
for (const width of [375, 1440]) {
  test(`guest form, local QR and cookie transport at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 1000 });
    const externalRequests: string[] = []; const pageErrors: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).origin !== "http://127.0.0.1:4177") externalRequests.push(request.url()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const response = await page.goto(creatorPath);
    await expect(page.getByRole("heading", { name: "Gửi tip cho Tip Test Artist" })).toBeVisible();
    expect(await response!.text()).not.toContain(tipBrowserAccount);
    await page.getByRole("button", { name: "Tip 20.000 ₫", exact: true }).focus();
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space");
    await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toHaveValue("50000");
    await page.getByLabel("Số tiền (VND)", { exact: true }).fill("50.000");
    await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
    await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toBeFocused();
    await page.getByLabel("Số tiền (VND)", { exact: true }).fill("5000000");
    await page.getByLabel("Tên hiển thị (không bắt buộc)").fill("Khách 🎨");
    await page.getByLabel("Lời nhắn (không bắt buộc)").fill("Cảm ơn bạn <script>test</script>");
    const formAxe = await new AxeBuilder({ page }).analyze();
    expect(formAxe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === creationPath);
    await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
    const creation = await created; expect(creation.status()).toBe(201);
    const body = await creation.json(); const reference = body.instruction.reference as string;
    expect(JSON.stringify(body)).not.toMatch(/guestCapability|capability|secret|guestContent|Khách/u);
    await expect(page.getByRole("img", { name: "VietQR chuyển khoản trực tiếp cho nghệ sĩ" })).toBeVisible();
    await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
    await expect(page.getByText("5.000.000 ₫", { exact: true })).toBeVisible();
    await expect(page.getByText(reference, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Hướng dẫn chuyển khoản" })).toBeFocused();
    const cookies = await context.cookies();
    const capabilities = cookies.filter((c) => c.name === `__Secure-pawket_tip_${reference}`);
    expect(capabilities.map((c) => c.path).sort()).toEqual([`/api/v1/tips/${reference}`, `/tips/${reference}`].sort());
    for (const cookie of capabilities) { expect(cookie.secure).toBe(true); expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe("Strict"); }
    expect(await page.evaluate(() => document.cookie)).not.toContain("pawket_tip");
    const receipt = await page.evaluate(async (ref) => { const r = await fetch(`/api/v1/tips/${ref}`, { cache: "no-store" }); return { status: r.status, value: await r.json(), cache: r.headers.get("cache-control") }; }, reference);
    expect(receipt.status).toBe(200); expect(receipt.value.receipt.state).toBe("awaiting_transfer"); expect(receipt.cache).toContain("no-store");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Sao chép số tiền", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("5000000");
    await page.getByRole("button", { name: "Sao chép nội dung chuyển khoản", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reference);
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    const bounds = await page.getByRole("button", { name: "Sao chép nội dung chuyển khoản" }).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    const layout = await page.locator('.site-frame, .site-header, .page-shell, .creator-publication, .creator-publication__header, .creator-publication__header > *, [data-tip-surface], [data-tip-surface] [data-slot="card"]').evaluateAll((elements) => elements.map((element) => {
      const r = element.getBoundingClientRect(); const css = getComputedStyle(element); return { element: element.className, slot: element.getAttribute("data-slot"), left: r.left, right: r.right, width: css.width, minWidth: css.minWidth, gridColumns: css.gridTemplateColumns, containerType: css.containerType };
    }));
    for (const box of layout) {
      expect(box.left, JSON.stringify(layout)).toBeGreaterThanOrEqual(0); expect(box.right, JSON.stringify(layout)).toBeLessThanOrEqual(width + 1);
    }
    const qr = await page.getByRole("img", { name: "VietQR chuyển khoản trực tiếp cho nghệ sĩ" }).boundingBox();
    expect(Math.abs(qr!.width - qr!.height)).toBeLessThan(1);
    expect(await page.locator('[data-tip-surface] [data-slot="badge"]').evaluateAll((elements) => elements.every((element) => element.scrollHeight <= element.clientHeight + 1))).toBe(true);
    expect(externalRequests).toEqual([]); expect(pageErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`tip-instruction-${width}.png`), fullPage: true });
  });
}

test("lost create response retries the same command and commits exactly one intent", async ({ page }) => {
  await page.goto(creatorPath);
  await expect(page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" })).toBeVisible();
  const before = await countIntents(); const keys: string[] = []; let dropped = false;
  await page.route(`**${creationPath}`, async (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    if (!dropped) { dropped = true; const committed = await route.fetch(); expect(committed.status()).toBe(201); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
  await expect(page.getByText("Chưa lấy được kết quả.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Số tiền (VND)", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Thử lại yêu cầu này" }).click();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(await countIntents()).toBe(before + 1);
});

test("QR chunk and clipboard failure preserve exact text instructions", async ({ page }) => {
  await page.goto(creatorPath);
  await expect(page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" })).toBeVisible();
  await page.route("**/_next/static/chunks/*.js", (route) => route.abort("failed"));
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("synthetic clipboard denial"); } } }); });
  await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
  await expect(page.getByText("Chưa hiển thị được QR", { exact: true })).toBeVisible();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
  await expect(page.getByText(/^PW[0-9A-F]{20}$/u)).toBeVisible();
  await page.getByRole("button", { name: "Sao chép số tài khoản", exact: true }).click();
  await expect(page.getByText("Chưa sao chép được.", { exact: false })).toBeVisible();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toHaveCSS("user-select", "text");
});

test("expiry removes QR and receiving details without claiming whether money arrived", async ({ page }) => {
  await page.clock.install();
  await page.goto(creatorPath);
  await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
  await page.clock.fastForward(86_401_000);
  await expect(page.getByRole("heading", { name: "Yêu cầu đã hết hạn" })).toBeVisible();
  await expect(page.getByRole("img", { name: "VietQR chuyển khoản trực tiếp cho nghệ sĩ" })).toBeHidden();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeHidden();
  await expect(page.getByText("Liên hệ nghệ sĩ để đối chiếu; trạng thái hết hạn không xác định tiền đã đến hay chưa.", { exact: true })).toBeVisible();
});

test("without JavaScript, form submission cannot place optional content in a URL", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:4177${creatorPath}`);
    await page.getByLabel("Tên hiển thị (không bắt buộc)").fill("Synthetic private guest");
    const sent = page.waitForRequest((r) => new URL(r.url()).pathname === creationPath);
    await page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" }).click();
    const request = await sent;
    expect(request.method()).toBe("POST"); expect(new URL(request.url()).search).toBe("");
    expect(request.url()).not.toContain("Synthetic");
  } finally { await context.close(); }
});

test("guest receipt reload, untrusted claim and real manual confirmation stay distinct", async ({ page, context }) => {
  const reference = await createBrowserTip(page);
  const navigation = page.waitForResponse((r) => new URL(r.url()).pathname === `/tips/${reference}` && r.request().isNavigationRequest());
  await page.getByRole("button", { name: "Mở phiếu tip", exact: true }).click();
  const response = await navigation;
  expect(response.headers()["cache-control"]).toContain("no-store"); expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  const html = await response.text(); const cookie = (await context.cookies()).find((c) => c.name === `__Secure-pawket_tip_${reference}`)!;
  expect(html).not.toContain(cookie.value); expect(html).not.toContain("Synthetic private receipt guest");
  await expect(page.getByRole("heading", { name: "Phiếu tip của bạn" })).toBeVisible();
  await page.reload(); await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tôi đã chuyển khoản", exact: true }).click();
  await expect(page.getByRole("button", { name: "Đã báo đã chuyển khoản", exact: true })).toBeDisabled();
  await expect(page.getByText("Thông báo của bạn không phải bằng chứng ngân hàng và không xác nhận thanh toán.", { exact: false })).toBeVisible();
  const claimed = await receiptFacts(reference); expect(claimed.intent.state).toBe("awaiting_transfer"); expect(claimed.claims).toHaveLength(1);
  await confirmSyntheticReceipt(reference);
  await page.getByRole("button", { name: "Kiểm tra trạng thái", exact: true }).click();
  await expect(page.getByText("Nghệ sĩ đã xác nhận nhận tiền", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "VietQR chuyển khoản trực tiếp cho nghệ sĩ" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Tôi đã chuyển khoản", exact: true })).toBeHidden();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeHidden();
  await expect(page.locator("body")).not.toContainText("Synthetic private receipt guest");
  expect((await receiptFacts(reference)).intent.state).toBe("confirmed");
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
});

test("receipt access survives mode-off as private history with no payment instruction or mutation", async ({ page }) => {
  const reference = await createBrowserTip(page);
  await page.goto(`http://127.0.0.1:4178/tips/${reference}`);
  await expect(page.getByRole("heading", { name: "Tip cho Tip Test Artist", exact: true })).toBeVisible();
  await expect(page.getByText("Tính năng tip đang tạm đóng", { exact: true })).toBeVisible();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Tôi đã chuyển khoản", exact: true })).toBeHidden();
  const claimStatus = await page.evaluate(async (ref) => (await fetch(`/api/v1/tips/${ref}/transfer-claims`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, reference);
  expect(claimStatus).toBe(503); expect((await receiptFacts(reference)).claims).toHaveLength(0);
  await page.goto(`http://127.0.0.1:4178${creatorPath}`);
  await expect(page.getByRole("heading", { name: "Tip Test Artist", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tạo hướng dẫn chuyển khoản" })).toHaveCount(0);
});

test("absent and invalid capability states disclose no receipt facts", async ({ page, browser }) => {
  const reference = await createBrowserTip(page); const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } });
  try {
    const other = await context.newPage();
    for (const ref of [reference, "PWFFFFFFFFFFFFFFFFFFFF"]) {
      await other.goto(`http://127.0.0.1:4177/tips/${ref}`);
      await expect(other.getByText("Trình duyệt này chưa có quyền xem phiếu tip.", { exact: false })).toBeVisible();
      await expect(other.locator("body")).not.toContainText(tipBrowserAccount);
      await expect(other.getByRole("heading", { name: "Tip cho Tip Test Artist", exact: true })).toHaveCount(0);
    }
    await context.addCookies([{ name: `__Secure-pawket_tip_${reference}`, value: "Z".repeat(43), domain: "127.0.0.1", path: `/tips/${reference}`, secure: true, httpOnly: true, sameSite: "Strict" }]);
    await other.goto(`http://127.0.0.1:4177/tips/${reference}`);
    await expect(other.getByText("Không mở được phiếu tip bằng quyền truy cập hiện tại.", { exact: false })).toBeVisible();
    await expect(other.locator("body")).not.toContainText(tipBrowserAccount);
  } finally { await context.close(); }
});

test("receipt dependency failure hides stale bank instructions and recovers on explicit refresh", async ({ page }) => {
  const reference = await createBrowserTip(page); await page.goto(`/tips/${reference}`);
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
  await page.route(`**/api/v1/tips/${reference}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"dependency_unavailable"}' }));
  await page.getByRole("button", { name: "Kiểm tra trạng thái", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chưa xem được phiếu tip" })).toBeVisible();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeHidden();
  await page.unroute(`**/api/v1/tips/${reference}`);
  await page.getByRole("button", { name: "Kiểm tra trạng thái", exact: true }).click();
  await expect(page.getByText(tipBrowserAccount, { exact: true })).toBeVisible();
});
