import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { createDatabase, identityCreatorCapabilities, importConfiguredBusinessCalendarVersion, paymentIntents, commissionRefundEvents, commissionRefundObligations, trustCases } from "@pawket/database";
import { createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import { createResolutionMaintenance } from "@pawket/resolutions";
import { createEncryptionKeyring } from "@pawket/security";
import { createTrustCasePort } from "@pawket/trust";
import { assertIncrementThreeBrowserDatabaseName, browserDatabaseUrl } from "./increment-three-database";
import { commissionBuyerId, commissionBuyerToken } from "./increment-six-global-setup";
import { tipBrowserHandle, tipBrowserSessionToken, tipBrowserUserId, tipPolicyOwnerSessionToken } from "./increment-four-global-setup";
import { refreshBrowserSession } from "./oidc-browser-fixture";
import { resolutionFormLabels } from "./resolution-fixture-data";
import { resolutionSchema } from "../src/ui/resolutions/resolution-client";

const DAY = 86_400_000;
const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
const refunds = createCommissionRefundPort({ keyring, calendarVersion: "vn-playwright-v1" });
const orders = createCommissionResolutionOrderPort({ applicationRevision: "synthetic-resolution-browser", newId: randomUUID });
const cases = createTrustCasePort();
const ids = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });
function databaseFixture() {
  assertIncrementThreeBrowserDatabaseName(new URL(browserDatabaseUrl).pathname.slice(1));
  return createDatabase(browserDatabaseUrl);
}
test.beforeAll(async () => {
  const fixture = databaseFixture();
  try { await fixture.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: "vn-playwright-v1", holidayDates: [] })); }
  finally { await fixture.close(); }
});
async function signIn(page: Page, token: string) {
  await refreshBrowserSession(token);
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function accessible(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations.length).toBe(0);
}
async function resolution(page: Page, orderId: string, role: "buyer" | "creator" = "buyer") {
  const response = await page.request.get(`/api/v1${role === "buyer" ? "" : "/creator"}/commissions/${orderId}/resolution`);
  expect(response.status()).toBe(200); return resolutionSchema.parse(await response.json()).resolution;
}
async function openOrder(page: Page, buyer: number, paid = true) {
  await signIn(page, commissionBuyerToken(buyer));
  const response = await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`); expect(response.status()).toBe(200);
  const offering = (await response.json()).packages.find((entry: { route: string }) => entry.route === "fixed_immediate");
  expect(Boolean(offering)).toBe(true);
  await page.goto(`/creators/${tipBrowserHandle}/commissions/${offering.id}`);
  await page.getByLabel("Mô tả yêu cầu của bạn", { exact: true }).fill("Commission tổng hợp để kiểm thử xử lý kết thúc đơn.");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
  await page.getByRole("button", { name: "Đặt commission và xem thanh toán", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u);
  const orderId = new URL(page.url()).pathname.split("/").at(-1)!;
  if (!paid) return orderId;
  const detail = await page.request.get(`/api/v1/commissions/${orderId}`); expect(detail.status()).toBe(200);
  const { order } = await detail.json();
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  await page.getByLabel("Số tiền thực nhận (VND)", { exact: true }).fill(String(order.payment.amountVnd));
  await page.getByLabel("Nội dung trên giao dịch ngân hàng", { exact: true }).fill(order.payment.reference);
  await page.getByLabel("Mã giao dịch ngân hàng", { exact: true }).fill(`SYNTH-${randomUUID()}`);
  await page.getByRole("checkbox", { name: "Tôi đã kiểm tra đúng số tiền", exact: false }).check();
  await page.getByRole("button", { name: "Xác nhận đã nhận tiền commission", exact: true }).click();
  await expect(page.locator("[data-order-state]")).toHaveText("Đang thực hiện");
  return orderId;
}
async function propose(page: Page, orderId: string, buyer: number) {
  await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
  const panel = page.locator("[data-resolution-panel]");
  await panel.getByRole("button", { name: "Đề nghị hủy hoặc hoàn tiền", exact: true }).click();
  await panel.getByLabel("Số tiền hoàn (VND)", { exact: false }).fill("100000");
  await panel.getByLabel("Lời nhắn cho bên kia", { exact: false }).fill("Thống nhất hủy đơn và hoàn một phần số tiền đã trả.");
  await panel.getByRole("button", { name: "Gửi đề nghị", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toBeVisible();
}
async function enterDestination(page: Page, orderId: string, buyer: number) {
  await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
  const panel = page.getByRole("region", { name: "Hoàn tiền", exact: true });
  await expect(panel.getByRole("heading", { name: "Nhập tài khoản nhận hoàn tiền", exact: true })).toBeVisible();
  await panel.getByLabel("Ngân hàng", { exact: false }).selectOption("970436");
  await panel.getByLabel("Số tài khoản", { exact: false }).fill("000000004321");
  await panel.getByLabel("Tên chủ tài khoản", { exact: false }).fill("SYNTHETIC BUYER");
  await panel.getByRole("button", { name: "Lưu tài khoản nhận hoàn tiền", exact: true }).click();
  await expect(panel.getByText("Chờ chuyển hoàn tiền", { exact: true })).toBeVisible();
  await accessible(page);
}
async function recordSend(page: Page, orderId: string) {
  await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
  const obligationId = (await resolution(page, orderId, "creator")).refunds[0]!.obligationId;
  const fixture = databaseFixture();
  const revealCount = async () => {
    const [row] = await fixture.db.select({ count: count() }).from(commissionRefundEvents)
      .where(and(eq(commissionRefundEvents.obligationId, obligationId), eq(commissionRefundEvents.action, "destination_revealed")));
    return row!.count;
  };
  try {
    const before = await revealCount();
    const panel = page.getByRole("region", { name: "Hoàn tiền", exact: true });
    await expect(panel.getByRole("region", { name: "Thông tin chuyển hoàn tiền", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Xem thông tin chuyển hoàn tiền", exact: true }).click();
    const reveal = panel.getByRole("region", { name: "Thông tin chuyển hoàn tiền", exact: true });
    await expect(reveal.getByRole("img", { name: "Mã QR chuyển hoàn tiền", exact: true })).toBeVisible();
    // A boolean assertion keeps synthetic account data out of failure output.
    expect(await reveal.locator("dd").evaluateAll((nodes) => nodes.some((node) => node.textContent === "000000004321"))).toBe(true);
    expect(await revealCount()).toBe(before + 1);
    await accessible(page);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    await reveal.getByLabel(resolutionFormLabels.transferDate, { exact: true }).fill(today);
    await reveal.getByLabel(resolutionFormLabels.bankReference, { exact: true }).fill(`SYNTH-${randomUUID()}`);
    await reveal.getByRole("button", { name: "Ghi nhận đã chuyển", exact: true }).click();
    await expect(panel.getByText("Nghệ sĩ đã ghi nhận chuyển", { exact: true })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Thông tin chuyển hoàn tiền", exact: true })).toHaveCount(0);
  } finally { await fixture.close(); }
}
async function scanAt(at: Date) {
  const fixture = databaseFixture();
  try { return await createResolutionMaintenance({ db: fixture.db, refunds, orders, cases, payments: createCommissionPaymentFactsPort(), now: () => at }).scan({ limit: 500 }); }
  finally { await fixture.close(); }
}
async function creatorStanding(state: "active" | "suspended") {
  const fixture = databaseFixture();
  try {
    await fixture.db.transaction(async (tx) => {
      await lockCommissionCreator(tx, tipBrowserUserId);
      const [row] = await tx.select().from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.userId, tipBrowserUserId)).for("update");
      if (!row) throw new Error("Missing synthetic creator capability");
      await tx.update(identityCreatorCapabilities).set({ state, suspendedAt: state === "suspended" ? new Date() : null, version: row.version + 1, updatedAt: new Date() }).where(eq(identityCreatorCapabilities.id, row.id));
    });
  } finally { await fixture.close(); }
}

for (const width of [375, 1440]) {
  test.describe(`commission resolution at ${width}px`, () => {
    // Each scenario and width owns its buyer, including when an earlier journey fails.
    const firstBuyer = width === 375 ? 20 : 26;
    test.describe.configure({ timeout: 120_000 });
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 1000 }); });

    test("agreed cancellation, account entry, audited reveal, send and buyer receipt", async ({ page }) => {
      const buyer = firstBuyer; const orderId = await openOrder(page, buyer); await propose(page, orderId, buyer); await accessible(page);
      await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
      await page.getByRole("button", { name: "Đồng ý", exact: true }).click();
      await page.getByRole("button", { name: "Xác nhận đồng ý và kết thúc đơn", exact: true }).click();
      await expect(page.locator("[data-order-state]")).toHaveText("Đã đóng");
      await enterDestination(page, orderId, buyer); await recordSend(page, orderId);
      await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
      await page.getByRole("button", { name: "Tôi đã nhận được tiền", exact: true }).click();
      await page.getByRole("button", { name: "Xác nhận đã nhận tiền", exact: true }).click();
      await expect(page.getByRole("region", { name: "Hoàn tiền", exact: true }).getByText("Đã nhận tiền", { exact: true })).toBeVisible();
      expect((await resolution(page, orderId)).refunds[0]!.state).toBe("received"); await accessible(page);
    });

    test("dispute, owner ruling, refund and presumed receipt after seven days", async ({ page }) => {
      const buyer = firstBuyer + 1; const orderId = await openOrder(page, buyer); await propose(page, orderId, buyer);
      await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
      await page.getByRole("button", { name: "Từ chối", exact: true }).click();
      await expect(page.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toHaveCount(0);
      await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
      await page.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
      const form = page.locator("[data-resolution-panel] form");
      await form.getByLabel(resolutionFormLabels.statement, { exact: true }).fill("Hai bên chưa thống nhất việc kết thúc đơn.");
      await form.getByLabel("Số tiền muốn hoàn (VND)", { exact: false }).fill("500000");
      await expect(form.getByRole("button", { name: "Mở khiếu nại", exact: true })).toBeDisabled();
      await form.getByRole("checkbox", { name: resolutionFormLabels.staffReview, exact: true }).check();
      await form.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Khiếu nại đang được Pawket xem xét", exact: true })).toBeVisible(); await accessible(page);
      const disputeId = (await resolution(page, orderId)).dispute!.id;
      // A ruling is available after the other party responds or its deadline passes.
      await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
      const dispute = page.getByRole("region", { name: "Khiếu nại", exact: true });
      await dispute.getByLabel("Bổ sung trình bày", { exact: false }).fill("Đề nghị Pawket xem xét kết thúc đơn và hoàn tiền.");
      await dispute.getByRole("button", { name: "Bổ sung trình bày", exact: true }).click();
      await expect.poll(async () => (await resolution(page, orderId, "creator")).dispute!.statements.some((row) => row.authorRole === "creator" && row.kind === "response")).toBe(true);
      const fixture = databaseFixture(); let caseId: string;
      try { const [row] = await fixture.db.select().from(trustCases).where(eq(trustCases.sourceId, disputeId)); if (!row) throw new Error("Missing synthetic dispute case"); caseId = row.id; }
      finally { await fixture.close(); }
      await signIn(page, tipPolicyOwnerSessionToken); await page.goto(`/admin/cases/${caseId}`);
      await expect(page.getByRole("button", { name: "Xem bằng chứng", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Xem bằng chứng", exact: true }).click();
      await expect(page.getByRole("button", { name: "Ẩn bằng chứng", exact: true })).toBeVisible(); await accessible(page);
      const ruling = page.locator("form").filter({ has: page.getByRole("heading", { name: "Kết luận vụ việc", exact: true }) });
      await ruling.getByLabel("Kết quả", { exact: false }).selectOption("close_full");
      await ruling.getByLabel("Kết luận (hai bên sẽ thấy)", { exact: false }).fill("Kết thúc đơn và ghi nhận hoàn toàn bộ số tiền đã trả.");
      await ruling.getByRole("button", { name: "Xác nhận kết luận", exact: true }).click();
      await expect(page.getByText("Vụ việc đã giải quyết; bằng chứng riêng tư đã đóng", { exact: true })).toBeVisible();
      await enterDestination(page, orderId, buyer);
      await expect(page.getByRole("heading", { name: "Kết luận của Pawket", exact: true })).toBeVisible();
      await recordSend(page, orderId);
      const sent = (await resolution(page, orderId, "creator")).refunds[0]!; expect(Boolean(sent.confirmBy)).toBe(true);
      await scanAt(new Date(Date.parse(sent.confirmBy!) - 1));
      expect((await resolution(page, orderId, "creator")).refunds[0]!.state).toBe("sent");
      expect((await scanAt(new Date(sent.confirmBy!))).presumedReceived).toBeGreaterThanOrEqual(1);
      await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
      await expect(page.getByText("Hết hạn xác nhận hoàn tiền", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Tôi đã nhận được tiền", exact: true })).toHaveCount(0); await accessible(page);
    });

    test("overdue refund pauses public intake and the creator banner clears after a send", async ({ page }) => {
      const buyer = firstBuyer + 2; const orderId = await openOrder(page, buyer); const fixture = databaseFixture(); let obligationId: string | undefined;
      try {
        // Seed an aged obligation with the real payment binding and business calendar,
        // as in maintenance integration fixtures. No deadline or pause row is edited.
        const at = new Date(Date.now() - 21 * DAY);
        obligationId = await fixture.db.transaction(async (tx) => {
          await lockCommissionCreator(tx, tipBrowserUserId);
          const [payment] = await tx.select().from(paymentIntents).where(eq(paymentIntents.commissionOrderId, orderId));
          if (!payment) throw new Error("Missing synthetic payment binding");
          return (await refunds.createObligation(tx, { orderId, paymentIntentId: payment.id, creatorUserId: tipBrowserUserId,
            buyerUserId: commissionBuyerId(buyer), source: "agreement", sourceId: randomUUID(), amountVnd: 100_000, at, requestId: randomUUID() })).obligationId;
        });
        const service = createCommissionRefundService({ db: fixture.db, keyring, lookupHmacKey: new Uint8Array(32).fill(2),
          applicationRevision: "synthetic-resolution-browser", calendarVersion: "vn-playwright-v1", mode: "enabled", recentAuthMs: 3_600_000,
          mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases, now: () => at,
          assurance: { async getTipSessionAssurance() { return { primaryAuthenticatedAt: at, sessionExpiresAt: new Date(at.getTime() + DAY), mfaEnrolled: false, mfaVerifiedAt: null }; } } });
        await service.enterDestination({ actor: { userId: commissionBuyerId(buyer), sessionId: `${commissionBuyerId(buyer)}-session` }, obligationId,
          expectedVersion: 1, bankBin: "970436", accountNumber: "000000004321", accountHolder: "SYNTHETIC BUYER", ...ids() });
        expect((await scanAt(new Date())).overdueCases).toBeGreaterThanOrEqual(1);
        await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/creators/${tipBrowserHandle}`);
        await expect(page.getByText("Tạm ngưng nhận đơn", { exact: true }).first()).toBeVisible();
        await expect(page.getByText(/hoàn tiền quá hạn/u)).toHaveCount(0); await accessible(page);
        await signIn(page, tipBrowserSessionToken); await page.goto("/creator/commissions/packages");
        await expect(page.getByText("Bạn đang tạm ngưng nhận đơn mới vì có khoản hoàn tiền quá hạn.", { exact: true })).toBeVisible(); await accessible(page);
        await recordSend(page, orderId); await page.goto("/creator/commissions/packages");
        await expect(page.getByText("Bạn đang tạm ngưng nhận đơn mới vì có khoản hoàn tiền quá hạn.", { exact: true })).toHaveCount(0);
        const [resolved] = await fixture.db.select({ state: trustCases.state, resolutionKind: trustCases.resolutionKind }).from(trustCases)
          .where(and(eq(trustCases.sourceId, obligationId), eq(trustCases.kind, "refund_overdue")));
        expect(resolved?.state).toBe("resolved"); expect(resolved?.resolutionKind).toBe("send_recorded");
        await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/creators/${tipBrowserHandle}`);
        await expect(page.getByText("Tạm ngưng nhận đơn", { exact: true })).toHaveCount(0);
        const response = await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`); expect(response.status()).toBe(200);
        const packages = (await response.json()).packages;
        expect(packages.some((entry: { route: string; accepting: boolean }) => entry.route === "fixed_immediate" && entry.accepting)).toBe(true); await accessible(page);
      } finally {
        // A failed UI assertion must not leave a global creator intake fence behind.
        try { if (obligationId) await fixture.db.transaction(async (tx) => {
          await lockCommissionCreator(tx, tipBrowserUserId);
          const [row] = await tx.select().from(commissionRefundObligations).where(eq(commissionRefundObligations.id, obligationId!));
          if (row && ["awaiting_destination", "awaiting_send", "not_received"].includes(row.state)) await refunds.waive(tx, { obligationId: row.id, actor: null, at: new Date(), requestId: randomUUID() });
        }); } finally { await fixture.close(); }
      }
    });

    test("late-payment claim on a closed unpaid order creates a refund without reopening", async ({ page }) => {
      const buyer = firstBuyer + 3; const orderId = await openOrder(page, buyer, false);
      await page.getByRole("button", { name: "Rút hoặc hủy yêu cầu", exact: true }).click();
      await page.getByRole("button", { name: "Xác nhận đóng yêu cầu", exact: true }).click();
      await expect(page.locator("[data-order-state]")).toHaveText("Đã đóng");
      await page.getByRole("button", { name: "Tôi đã chuyển khoản sau khi đơn đóng", exact: true }).click();
      // datetime-local follows the device time zone and defaults to minute increments.
      const transferAt = await page.evaluate(() => { const at = new Date(); const pad = (n: number) => String(n).padStart(2, "0");
        return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`; });
      const panel = page.getByRole("region", { name: "Chuyển khoản sau khi đơn đóng", exact: true });
      await panel.getByLabel("Thời điểm chuyển", { exact: false }).fill(transferAt);
      await panel.getByLabel("Số tiền đã chuyển (VND)", { exact: false }).fill("500000");
      await panel.getByLabel(resolutionFormLabels.bankReference, { exact: true }).fill(`SYNTH-${randomUUID()}`);
      expect(await panel.locator("form").evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(true);
      await panel.getByRole("button", { name: "Gửi yêu cầu đối chiếu", exact: true }).click();
      await expect(panel.getByText("Chờ nghệ sĩ đối chiếu", { exact: true })).toBeVisible(); await accessible(page);
      await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
      await page.getByRole("button", { name: "Đã nhận tiền", exact: true }).click();
      await page.getByLabel("Số tiền thực nhận (VND)", { exact: false }).fill("500000");
      await page.getByRole("button", { name: "Xác nhận đối chiếu", exact: true }).click();
      await expect(page.getByText("Đã xác nhận khoản cần hoàn", { exact: true })).toBeVisible();
      const view = await resolution(page, orderId, "creator"); expect(view.refunds[0]!.amountVnd).toBe(500_000);
      expect(view.lateClaim!.state).toBe("refund_owed"); await expect(page.locator("[data-order-state]")).toHaveText("Đã đóng"); await accessible(page);
    });

    test("buyer cancels after creator suspension with a full refund", async ({ page }) => {
      const buyer = firstBuyer + 4; const orderId = await openOrder(page, buyer);
      try {
        await creatorStanding("suspended"); await signIn(page, commissionBuyerToken(buyer)); await page.goto(`/commissions/${orderId}`);
        await page.getByRole("button", { name: "Hủy đơn và yêu cầu hoàn tiền toàn bộ", exact: true }).click(); await accessible(page);
        await page.getByRole("button", { name: "Xác nhận hủy và yêu cầu hoàn tiền", exact: true }).click();
        await expect(page.locator("[data-order-state]")).toHaveText("Đã đóng");
        expect((await resolution(page, orderId)).refunds[0]!.amountVnd).toBe(500_000);
        await expect(page.getByPlaceholder("Nhắn cho nghệ sĩ…", { exact: true })).toHaveCount(0); await accessible(page);
      } finally { await creatorStanding("active"); }
    });

    test("owner freezes suspended creator orders and the creator retains refund access", async ({ page }) => {
      const buyer = firstBuyer + 5; const orderId = await openOrder(page, buyer); const otherOrderId = await openOrder(page, buyer); await propose(page, orderId, buyer);
      await signIn(page, tipBrowserSessionToken); await page.goto(`/creator/commissions/${orderId}`);
      await page.getByRole("button", { name: "Từ chối", exact: true }).click();
      await expect(page.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toHaveCount(0);
      // Open a case via the existing HTTP route so the owner freeze screen has a case.
      await signIn(page, commissionBuyerToken(buyer));
      const detail = await (await page.request.get(`/api/v1/commissions/${orderId}`)).json();
      const opened = await page.request.post(`/api/v1/commissions/${orderId}/disputes`, { headers: { origin: "http://127.0.0.1:4181", "idempotency-key": randomUUID() },
        data: { expectedVersion: detail.order.version, reason: "communication_breakdown", statement: "Nội dung tổng hợp để mở vụ việc đóng băng.", acknowledgeStaffReview: true, requestedOutcome: { kind: "close", refundAmountVnd: 500_000 } } });
      expect(opened.status()).toBe(200); const { disputeId } = await opened.json();
      const fixture = databaseFixture(); let caseId: string;
      try { const [row] = await fixture.db.select().from(trustCases).where(eq(trustCases.sourceId, disputeId)); if (!row) throw new Error("Missing synthetic freeze case"); caseId = row.id; }
      finally { await fixture.close(); }
      try {
        await creatorStanding("suspended"); await signIn(page, tipPolicyOwnerSessionToken); await page.goto(`/admin/cases/${caseId}`);
        const freeze = page.locator("form").filter({ has: page.getByRole("heading", { name: "Đóng băng thực hiện đơn", exact: true }) });
        await expect(freeze.getByRole("heading", { name: "Đóng băng thực hiện đơn", exact: true })).toBeVisible();
        await freeze.getByLabel("Lý do", { exact: false }).fill("Đóng băng thực hiện theo quyết định kiểm thử tổng hợp.");
        await freeze.getByLabel("Tôi đã kiểm tra và đồng ý đóng mọi đơn đang thực hiện của nghệ sĩ này", { exact: false }).check(); await accessible(page);
        await freeze.getByRole("button", { name: "Đóng băng thực hiện đơn", exact: true }).click();
        await expect(page.getByText("Vụ việc đã giải quyết; bằng chứng riêng tư đã đóng", { exact: true })).toBeVisible();
        await enterDestination(page, orderId, buyer); await recordSend(page, orderId);
        const view = await resolution(page, orderId, "creator"); expect(view.refunds[0]!.amountVnd).toBe(500_000);
        const other = await page.request.get(`/api/v1/creator/commissions/${otherOrderId}`); expect(other.status()).toBe(200);
        const otherOrder = (await other.json()).order; expect(otherOrder.state).toBe("closed"); expect(otherOrder.closeReason).toBe("fulfillment_frozen");
        expect((await resolution(page, otherOrderId, "creator")).refunds[0]!.amountVnd).toBe(500_000);
        await expect(page.locator("[data-order-state]")).toHaveText("Đã đóng");
        await expect(page.getByPlaceholder("Nhắn cho người đặt…", { exact: true })).toHaveCount(0); await accessible(page);
      } finally { await creatorStanding("active"); }
    });
  });
}
