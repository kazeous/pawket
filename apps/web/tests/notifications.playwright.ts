import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { acknowledgeOutboxEvent, commissionDisputes, commissionRefundObligations, createDatabase, importConfiguredBusinessCalendarVersion, notifications, systemOutbox } from "@pawket/database";
import { DeterministicLocalSecurityEmailSink } from "@pawket/identity/security-email";
import { deliverSecurityEmailHandoff } from "@pawket/identity/security-email-handoff";
import { NOTIFICATION_SOURCE_EVENTS, renderNotice } from "@pawket/notifications";
import { OUTBOX_JOB } from "@pawket/queue";
import { createEncryptionKeyring } from "@pawket/security";
import { createWorkerJobProcessor } from "../../worker/src/worker-runtime";
import { createWorkerNotificationMaintenance, createWorkerNotificationMaterializer } from "../../worker/src/notification-wiring";
import { assertIncrementThreeBrowserDatabaseName, browserDatabaseUrl } from "./increment-three-database";
import { commissionBuyerId, commissionBuyerToken } from "./increment-six-global-setup";
import { tipBrowserHandle, tipBrowserSessionToken, tipBrowserUserId } from "./increment-four-global-setup";
import { refreshBrowserSession } from "./oidc-browser-fixture";
import { resolutionFormLabels } from "./resolution-fixture-data";

// The existing paired disabled server also disables payments, preserving P9 during the RED run.
const origin = process.env.PAWKET_NOTIFICATIONS_DISABLED_CHECK === "1" ? "http://127.0.0.1:4182" : "http://127.0.0.1:4181";
test.use({ baseURL: origin });
const DAY = 86_400_000;
const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
let since: Date; let sink: DeterministicLocalSecurityEmailSink;
function database() {
  assertIncrementThreeBrowserDatabaseName(new URL(browserDatabaseUrl).pathname.slice(1)); return createDatabase(browserDatabaseUrl);
}
test.beforeAll(async () => {
  const fixture = database();
  try { await fixture.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: "vn-playwright-v1", holidayDates: [] })); }
  finally { await fixture.close(); }
});
async function signIn(page: Page, token: string) {
  await refreshBrowserSession(token);
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function accessible(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
test.beforeEach(async ({ page }) => {
  since = new Date(); sink = new DeterministicLocalSecurityEmailSink();
  await signIn(page, tipBrowserSessionToken);
  // Disabled-first TDD fails here (404). Every enabled journey also proves availability.
  expect((await page.request.get("/api/v1/notifications/summary")).status()).toBe(200);
  expect((await page.request.post("/api/v1/notifications/read", { headers: { origin }, data: { all: true } })).status()).toBe(204);
});

/** Deterministically runs the real worker processor, validators, materializer and email delivery against this suite's committed events. */
async function pump(at = new Date()) {
  const fixture = database();
  try {
    const processor = createWorkerJobProcessor({ database: fixture.db, acknowledge: acknowledgeOutboxEvent,
      logger: { info() {}, error() {} } as never,
      notifications: createWorkerNotificationMaterializer({ db: fixture.db, keyring, now: () => at }),
      securityEmail: { keyring, sender: sink, deliver: (db, input) => deliverSecurityEmailHandoff(db, { ...input, now: at }) } });
    for (let pass = 0; pass < 10; pass++) {
      const events = await fixture.db.select().from(systemOutbox).where(and(isNull(systemOutbox.publishedAt), gte(systemOutbox.occurredAt, since),
        inArray(systemOutbox.eventType, [...NOTIFICATION_SOURCE_EVENTS, "identity.security_email.requested.v1"]))).orderBy(asc(systemOutbox.occurredAt), asc(systemOutbox.id));
      if (!events.length) return;
      for (const row of events) await processor({ id: row.id, name: OUTBOX_JOB, data: { outboxEventId: row.id, eventType: row.eventType,
        eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() } } as never);
    }
    throw new Error("Notification test pipeline did not drain");
  } finally { await fixture.close(); }
}
async function scan(at: Date) {
  const fixture = database();
  try { await createWorkerNotificationMaintenance({ db: fixture.db, keyring, now: () => at }).runOnce(); }
  finally { await fixture.close(); }
  await pump(at);
}
async function inboxItem(userId: string, orderId: string, kind: string) {
  const fixture = database();
  try { return (await fixture.db.select().from(notifications).where(and(eq(notifications.recipientUserId, userId),
    eq(notifications.linkPath, userId === tipBrowserUserId ? `/creator/commissions/${orderId}` : `/commissions/${orderId}`), eq(notifications.kind, kind)))); }
  finally { await fixture.close(); }
}
function emails(kind: string, userId: string) {
  return sink.snapshot().filter((message) => message.purpose === "notification" && message.templateData.kind === kind
    && message.destination === `${userId}@example.invalid`);
}
async function openOrder(page: Page, buyer: number, paid = true) {
  await signIn(page, commissionBuyerToken(buyer));
  const response = await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`); expect(response.status()).toBe(200);
  const offering = (await response.json()).packages.find((entry: { route: string }) => entry.route === "fixed_immediate");
  await page.goto(`/creators/${tipBrowserHandle}/commissions/${offering.id}`);
  await page.getByLabel("Mô tả yêu cầu của bạn", { exact: true }).fill("Yêu cầu tổng hợp cho kiểm thử thông báo.");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  await page.getByRole("button", { name: "Đặt commission và xem thanh toán", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u);
  const orderId = new URL(page.url()).pathname.split("/").at(-1)!;
  if (paid) await confirmPayment(page, orderId);
  return orderId;
}
async function confirmPayment(page: Page, orderId: string) {
  const response = await page.request.get(`/api/v1/commissions/${orderId}`); expect(response.status()).toBe(200);
  const { order } = await response.json();
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await page.getByLabel("Số tiền thực nhận (VND)", { exact: true }).fill(String(order.payment.amountVnd));
  await page.getByLabel("Nội dung trên giao dịch ngân hàng", { exact: true }).fill(order.payment.reference);
  await page.getByLabel("Mã giao dịch ngân hàng", { exact: true }).fill(`SYNTH-NOTICE-${randomUUID()}`);
  await page.getByRole("checkbox", { name: "Tôi đã kiểm tra đúng số tiền", exact: false }).check();
  await page.getByRole("button", { name: "Xác nhận đã nhận tiền commission", exact: true }).click();
  await expect(page.locator("[data-order-state]")).toHaveText("Đang thực hiện");
}
async function propose(page: Page, orderId: string, buyer: number) {
  await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
  const panel = page.locator("[data-resolution-panel]");
  await panel.getByRole("button", { name: "Đề nghị hủy hoặc hoàn tiền", exact: true }).click();
  await panel.getByLabel("Số tiền hoàn (VND)", { exact: false }).fill("100000");
  await panel.getByLabel("Lời nhắn cho bên kia", { exact: false }).fill("Đề nghị tổng hợp cho kiểm thử thông báo.");
  await panel.getByRole("button", { name: "Gửi đề nghị", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toBeVisible();
}

test("buyer opens a dispute; the creator sees the bell count, the inbox item and the email; 24 hours before the deadline the creator gets a reminder; after the deadline both get the missed notice", async ({ page }) => {
  const buyer = 36; const orderId = await openOrder(page, buyer); await propose(page, orderId, buyer);
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await page.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect(page.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toHaveCount(0);
  await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
  await page.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
  const form = page.locator("[data-resolution-panel] form");
  await form.getByLabel(resolutionFormLabels.statement, { exact: true }).fill("Trình bày tổng hợp, không phải khiếu nại thật.");
  await form.getByLabel("Số tiền muốn hoàn (VND)", { exact: false }).fill("100000");
  await form.getByRole("checkbox", { name: resolutionFormLabels.staffReview, exact: true }).check();
  await form.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Khiếu nại đang được Pawket xem xét", exact: true })).toBeVisible();
  await pump();
  const [item] = await inboxItem(tipBrowserUserId, orderId, "dispute_opened"); expect(item).toBeDefined();
  expect(sink.snapshot().some((email) => email.handoffId === item!.emailHandoffId)).toBe(true);
  await signIn(page, tipBrowserSessionToken); await page.goto("/notifications");
  const unread = (await (await page.request.get("/api/v1/notifications/summary")).json()).unread;
  await expect(page.getByRole("link", { name: `Thông báo, ${unread} chưa đọc`, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: renderNotice("dispute_opened", null).title, exact: true })).toBeVisible();
  await expect(page.getByText("Cần bạn xử lý", { exact: true }).first()).toBeVisible(); await accessible(page);
  await page.getByRole("button", { name: "Đánh dấu tất cả là đã đọc", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get("/api/v1/notifications/summary")).json()).unread).toBe(0);
  const fixture = database(); let deadline: Date;
  try { const [dispute] = await fixture.db.select().from(commissionDisputes).where(eq(commissionDisputes.orderId, orderId)); deadline = dispute!.respondBy; }
  finally { await fixture.close(); }
  await scan(new Date(deadline.getTime() - DAY));
  expect((await inboxItem(tipBrowserUserId, orderId, "reminder_due")).some((row) => row.variant === "dispute_response")).toBe(true);
  await scan(new Date(deadline.getTime() + 1));
  for (const user of [tipBrowserUserId, commissionBuyerId(buyer)]) expect(await inboxItem(user, orderId, "deadline_missed")).toHaveLength(1);
});

test("refund owed: buyer gets the account request, enters the account; creator gets the send reminder, records the send; buyer gets the confirmation request and confirms; both see refund settled", async ({ page }) => {
  const buyer = 37; const orderId = await openOrder(page, buyer); await propose(page, orderId, buyer);
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await page.getByRole("button", { name: "Đồng ý", exact: true }).click();
  const accepted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/proposals/") && response.url().endsWith("/respond"));
  await page.getByRole("button", { name: "Xác nhận đồng ý và kết thúc đơn", exact: true }).click();
  const result = await accepted; expect({ status: result.status(), code: (await result.json()).code ?? null }).toEqual({ status: 200, code: null });
  await expect(page.locator("[data-order-state]")).toHaveText("Đã đóng"); await pump();
  expect(await inboxItem(commissionBuyerId(buyer), orderId, "refund_account_needed")).toHaveLength(1);
  await signIn(page, commissionBuyerToken(buyer)); await page.goto("/notifications");
  const entry = page.locator("li").filter({ has: page.getByRole("heading", { name: renderNotice("refund_account_needed", null).title, exact: true }) });
  await entry.getByRole("link", { name: renderNotice("refund_account_needed", null).actionLabel, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/commissions/${orderId}$`, "u"));
  expect((await inboxItem(commissionBuyerId(buyer), orderId, "refund_account_needed"))[0]!.readAt).not.toBeNull();
  const panel = page.getByRole("region", { name: "Hoàn tiền", exact: true });
  await panel.getByLabel("Ngân hàng", { exact: false }).selectOption("970436"); await panel.getByLabel("Số tài khoản", { exact: false }).fill("000000004321");
  await panel.getByLabel("Tên chủ tài khoản", { exact: false }).fill("SYNTHETIC BUYER"); await panel.getByRole("button", { name: "Lưu tài khoản nhận hoàn tiền", exact: true }).click();
  await expect(panel.getByText("Chờ chuyển hoàn tiền", { exact: true })).toBeVisible(); await pump();
  expect(await inboxItem(tipBrowserUserId, orderId, "refund_send_due")).toHaveLength(1);
  const fixture = database(); let deadline: Date;
  try { const [refund] = await fixture.db.select().from(commissionRefundObligations).where(eq(commissionRefundObligations.orderId, orderId)); deadline = refund!.dueAt!; }
  finally { await fixture.close(); }
  await scan(new Date(deadline.getTime() - DAY));
  expect((await inboxItem(tipBrowserUserId, orderId, "reminder_due")).some((row) => row.variant === "refund_send")).toBe(true);
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await page.getByRole("button", { name: "Xem thông tin chuyển hoàn tiền", exact: true }).click();
  const reveal = page.getByRole("region", { name: "Thông tin chuyển hoàn tiền", exact: true });
  await reveal.getByLabel(resolutionFormLabels.transferDate, { exact: true }).fill(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  await reveal.getByLabel(resolutionFormLabels.bankReference, { exact: true }).fill(`SYNTH-NOTICE-${randomUUID()}`);
  await reveal.getByRole("button", { name: "Ghi nhận đã chuyển", exact: true }).click();
  await expect(page.getByText("Nghệ sĩ đã ghi nhận chuyển", { exact: true })).toBeVisible(); await pump();
  expect(await inboxItem(commissionBuyerId(buyer), orderId, "refund_sent")).toHaveLength(1);
  await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
  await page.getByRole("button", { name: "Tôi đã nhận được tiền", exact: true }).click(); await page.getByRole("button", { name: "Xác nhận đã nhận tiền", exact: true }).click();
  await expect(page.getByText("Đã nhận tiền", { exact: true })).toBeVisible(); await pump();
  for (const user of [tipBrowserUserId, commissionBuyerId(buyer)]) expect(await inboxItem(user, orderId, "refund_settled")).toHaveLength(1);
});

test("three messages give one inbox item; opening the order clears it and no email is sent", async ({ page }) => {
  const buyer = 38; const orderId = await openOrder(page, buyer); await pump();
  await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
  for (let index = 0; index < 3; index++) {
    await page.getByRole("textbox", { name: "Nhắn cho nghệ sĩ…", exact: true }).fill(`Tin tổng hợp ${index + 1}`);
    await page.getByRole("button", { name: "Gửi", exact: true }).click();
    await expect(page.locator("[data-message-text]").filter({ hasText: `Tin tổng hợp ${index + 1}` })).toBeVisible();
  }
  await pump(); const rows = await inboxItem(tipBrowserUserId, orderId, "order_messages"); expect(rows).toHaveLength(1); expect(rows[0]!.collapsedCount).toBe(3);
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await expect.poll(async () => (await inboxItem(tipBrowserUserId, orderId, "order_messages"))[0]!.readAt !== null).toBe(true);
  await scan(new Date(Date.now() + 16 * 60_000));
  expect((await inboxItem(tipBrowserUserId, orderId, "order_messages"))[0]!.emailState).toBe("suppressed");
  expect(sink.snapshot().some((email) => email.purpose === "notification" && email.templateData.kind === "order_messages" && email.templateData.linkPath === `/creator/commissions/${orderId}`)).toBe(false);
});

test("turning off order emails stops the in_progress email but not the payment-due email", async ({ page }) => {
  const buyer = 39; await signIn(page, commissionBuyerToken(buyer)); await page.goto("/settings/notifications");
  const orders = page.getByRole("switch", { name: "Email về đơn commission", exact: true });
  await orders.click(); await expect(orders).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("status")).toHaveText("Đã lưu lựa chọn."); await accessible(page);
  const orderId = await openOrder(page, buyer, false); await pump();
  const due = (await inboxItem(commissionBuyerId(buyer), orderId, "order_payment_due"))[0]!;
  expect(due.emailState).toBe("queued"); expect(emails("order_payment_due", commissionBuyerId(buyer))).toHaveLength(1);
  await confirmPayment(page, orderId); await pump();
  expect((await inboxItem(commissionBuyerId(buyer), orderId, "order_in_progress"))[0]!.emailState).toBe("suppressed");
  expect(emails("order_in_progress", commissionBuyerId(buyer))).toHaveLength(0);
});
