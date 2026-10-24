import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { createDatabase, identityEmailHandoffs, trustAppeals, trustCases, trustContentHides, trustReports } from "@pawket/database";
import { DeterministicLocalSecurityEmailSink } from "@pawket/identity/security-email";
import { deliverSecurityEmailHandoff } from "@pawket/identity/security-email-handoff";
import { createEncryptionKeyring } from "@pawket/security";
import { caseDetailSchema } from "../src/ui/cases/case-client";
import { ordersSchema, publicPackagesSchema, workspaceSchema, type PublicPackage } from "../src/ui/commissions/commission-client";
import { myCasesSchema, resolutionSchema } from "../src/ui/resolutions/resolution-client";
import { appealResultSchema } from "../src/ui/trust/trust-client";
import { oidcCommand } from "../src/platform/oidc-command-registry";
import { assertIncrementThreeBrowserDatabaseName, browserDatabaseUrl } from "./increment-three-database";
import { commissionBuyerId, commissionBuyerToken } from "./increment-six-global-setup";
import { tipBrowserHandle, tipBrowserSessionToken, tipBrowserUserId, tipPolicyOwnerSessionId, tipPolicyOwnerSessionToken } from "./increment-four-global-setup";
import { completeSyntheticPendingAuthentication, makeSyntheticOwnerAuthenticationStale, refreshBrowserSession, restoreBrowserSessionToken } from "./oidc-browser-fixture";
import { resolutionFormLabels } from "./resolution-fixture-data";

const origin = "http://127.0.0.1:4181";
const unavailable = "Nội dung hoặc thao tác này hiện không khả dụng.";
const hiddenMessage = "Tin nhắn này đã bị Pawket ẩn vì vi phạm quy định cộng đồng.";
const reportAccepted = "Đã gửi báo cáo. Pawket sẽ xem xét và không cho người bị báo cáo biết thông tin của bạn.";
const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
const packageResult = z.object({ packageId: z.uuid() });
const penaltyResult = z.object({ penaltyId: z.uuid() });

function databaseFixture() {
  assertIncrementThreeBrowserDatabaseName(new URL(browserDatabaseUrl).pathname.slice(1));
  return createDatabase(browserDatabaseUrl);
}
async function setSessionCookie(page: Page, token: string) {
  await page.context().addCookies([{ name: "pawket.session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}
async function signIn(page: Page, token: string) {
  await refreshBrowserSession(token);
  await setSessionCookie(page, token);
}
function commandResponse(page: Page, path: string) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
}
async function packages(page: Page) {
  const response = await page.request.get(`/api/v1/public/creators/${tipBrowserHandle}/commissions`);
  expect(response.status()).toBe(200);
  return publicPackagesSchema.parse(await response.json()).packages;
}
async function offering(page: Page, route: PublicPackage["route"]) {
  const result = (await packages(page)).find((entry) => entry.route === route && entry.accepting);
  if (!result) throw new Error(`Missing synthetic ${route} package`);
  return result;
}
async function fillBrief(page: Page) {
  await page.getByLabel("Mô tả yêu cầu của bạn", { exact: true }).fill("Brief tổng hợp cho hành trình báo cáo và kháng nghị.");
  await page.getByRole("checkbox", { name: "Tôi đã đọc và đồng ý", exact: false }).check();
}
async function paidOrder(page: Page, buyer: number) {
  await signIn(page, commissionBuyerToken(buyer));
  const selected = await offering(page, "fixed_immediate");
  await page.goto(`/creators/${tipBrowserHandle}/commissions/${selected.id}`);
  await fillBrief(page);
  await page.getByRole("button", { name: "Đặt commission và xem thanh toán", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u);
  const orderId = z.uuid().parse(new URL(page.url()).pathname.split("/").at(-1));
  const detail = await page.request.get(`/api/v1/commissions/${orderId}`);
  expect(detail.status()).toBe(200);
  const { order } = await detail.json();
  await signIn(page, tipBrowserSessionToken);
  await page.goto(`/creator/commissions/${orderId}`);
  await page.getByLabel("Số tiền thực nhận (VND)", { exact: true }).fill(String(order.payment.amountVnd));
  await page.getByLabel("Nội dung trên giao dịch ngân hàng", { exact: true }).fill(order.payment.reference);
  await page.getByLabel("Mã giao dịch ngân hàng", { exact: true }).fill(`SYNTH-TRUST-${randomUUID()}`);
  await page.getByRole("checkbox", { name: "Tôi đã kiểm tra đúng số tiền", exact: false }).check();
  await page.getByRole("button", { name: "Xác nhận đã nhận tiền commission", exact: true }).click();
  await expect(page.locator("[data-order-state]")).toHaveText("Đang thực hiện");
  return orderId;
}

// Exercise the saved command, action-bound proof and explicit browser confirmation.
// Only provider evidence is synthetic, using the same OIDC fixture as Stage A.
async function ownerCommand(page: Page, actionClass: string, submit: () => Promise<unknown>) {
  const fixture = databaseFixture();
  try {
    await makeSyntheticOwnerAuthenticationStale(fixture.db, tipPolicyOwnerSessionId);
    await submit();
    await expect(page).toHaveURL(/\/auth\/review\/[0-9a-f-]{36}$/u);
    const pendingId = new URL(page.url()).pathname.split("/").at(-1)!;
    const review = await completeSyntheticPendingAuthentication(fixture.db, pendingId);
    expect(review.ready).toBe(true);
    expect(oidcCommand(review.payload)?.policy.actionClass).toBe(actionClass);
    await setSessionCookie(page, review.sessionToken);
    await page.reload();
    const confirmed = commandResponse(page, `/api/v1/auth/commands/${pendingId}`);
    await page.getByRole("button", { name: "Xác nhận thực hiện", exact: true }).click();
    const response = await confirmed;
    expect(response.status()).toBe(200);
    const result: unknown = await response.json();
    await expect(page.getByText("Đã xử lý yêu cầu.", { exact: false })).toBeVisible();
    return result;
  } finally {
    // Synthetic step-up rotates this shared fixture token; preserve it for later tests.
    try { await restoreBrowserSessionToken(fixture.db, tipPolicyOwnerSessionId, tipPolicyOwnerSessionToken); }
    finally { await fixture.close(); }
    await setSessionCookie(page, tipPolicyOwnerSessionToken);
  }
}
async function sourceCase(kind: "dispute" | "appeal", sourceId: string) {
  const fixture = databaseFixture();
  try {
    const [row] = await fixture.db.select({ id: trustCases.id }).from(trustCases)
      .where(and(eq(trustCases.kind, kind), eq(trustCases.sourceId, sourceId)));
    if (!row) throw new Error(`Missing synthetic ${kind} case`);
    return row.id;
  } finally { await fixture.close(); }
}
async function submitReport(page: Page, trigger: Locator) {
  await trigger.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Lý do báo cáo", { exact: true }).selectOption("privacy");
  await dialog.getByLabel("Chi tiết", { exact: true }).fill("Nội dung tổng hợp cần được Pawket xem xét.");
  const fixture = databaseFixture();
  try {
    const existingIds = new Set((await fixture.db.select({ id: trustReports.id }).from(trustReports)).map((row) => row.id));
    const submitted = commandResponse(page, "/api/v1/reports");
    await dialog.getByRole("button", { name: "Gửi báo cáo", exact: true }).click();
    const response = await submitted;
    // Chromium may discard the body consumed by the page; check status and UI instead.
    expect(response.status()).toBe(202);
    await expect(dialog.getByText(reportAccepted, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
    const rows = (await fixture.db.select().from(trustReports)).filter((row) => !existingIds.has(row.id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  } finally { await fixture.close(); }
}
async function hide(page: Page, caseId: string, reason: string) {
  await signIn(page, tipPolicyOwnerSessionToken);
  await page.goto(`/admin/cases/${caseId}`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Xác nhận xử lý báo cáo", exact: true }) });
  await form.getByLabel("Hành động", { exact: false }).selectOption("hide");
  await form.getByLabel("Lý do", { exact: false }).fill(reason);
  await ownerCommand(page, "owner.trust_hide", () => form.getByRole("button", { name: "Xác nhận xử lý báo cáo", exact: true }).click());
  const response = await page.request.get(`/api/v1/admin/cases/${caseId}`);
  expect(response.status()).toBe(200);
  const detail = caseDetailSchema.parse(await response.json()).case;
  if (detail.kind !== "report" || !detail.activeHideId) throw new Error("Synthetic hide was not recorded");
  return detail.activeHideId;
}
async function decideAppeal(page: Page, caseId: string, decision: "reversed" | "upheld", reasoning: string) {
  await signIn(page, tipPolicyOwnerSessionToken);
  await page.goto(`/admin/cases/${caseId}`);
  await page.getByLabel("Quyết định", { exact: false }).selectOption(decision);
  await page.getByLabel("Kết luận (người kháng nghị sẽ thấy)", { exact: false }).fill(reasoning);
  await ownerCommand(page, "owner.trust_appeal_decide", () => page.getByRole("button", { name: "Ghi nhận quyết định", exact: true }).click());
  await page.goto(`/admin/cases/${caseId}`);
  await expect(page.getByText("Vụ việc đã giải quyết; bằng chứng riêng tư đã đóng", { exact: true })).toBeVisible();
}
async function disputeCase(page: Page, buyer: number, orderId: string) {
  await signIn(page, commissionBuyerToken(buyer));
  await page.goto(`/commissions/${orderId}`);
  const panel = page.locator("[data-resolution-panel]");
  await panel.getByRole("button", { name: "Đề nghị hủy hoặc hoàn tiền", exact: true }).click();
  await panel.getByLabel("Số tiền hoàn (VND)", { exact: false }).fill("100000");
  await panel.getByLabel("Lời nhắn cho bên kia", { exact: false }).fill("Đề nghị hai bên xem xét kết thúc đơn tổng hợp.");
  await panel.getByRole("button", { name: "Gửi đề nghị", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toBeVisible();
  await signIn(page, tipBrowserSessionToken);
  await page.goto(`/creator/commissions/${orderId}`);
  await page.getByRole("button", { name: "Từ chối", exact: true }).click();
  await expect(page.getByRole("region", { name: "Đề nghị đang chờ", exact: true })).toHaveCount(0);
  await signIn(page, commissionBuyerToken(buyer));
  await page.goto(`/commissions/${orderId}`);
  await panel.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
  const form = panel.locator("form");
  await form.getByLabel(resolutionFormLabels.statement, { exact: true }).fill("Hai bên chưa thống nhất việc kết thúc đơn tổng hợp.");
  await form.getByLabel("Số tiền muốn hoàn (VND)", { exact: false }).fill("100000");
  await form.getByRole("checkbox", { name: resolutionFormLabels.staffReview, exact: true }).check();
  await form.getByRole("button", { name: "Mở khiếu nại", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Khiếu nại đang được Pawket xem xét", exact: true })).toBeVisible();
  const response = await page.request.get(`/api/v1/commissions/${orderId}/resolution`);
  expect(response.status()).toBe(200);
  const dispute = resolutionSchema.parse(await response.json()).resolution.dispute;
  if (!dispute) throw new Error("Missing synthetic dispute");
  return sourceCase("dispute", dispute.id);
}
async function applyBuyerPenalty(page: Page, caseId: string, buyer: number, kind: "suspension" | "restriction", explanation: string) {
  await signIn(page, tipPolicyOwnerSessionToken);
  await page.goto(`/admin/cases/${caseId}`);
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Áp dụng biện pháp", exact: true }) });
  await form.getByLabel("Người dùng bắt buộc", { exact: true }).selectOption(commissionBuyerId(buyer));
  await form.getByLabel("Biện pháp", { exact: false }).selectOption(kind);
  if (kind === "suspension") await form.getByLabel("Phạm vi", { exact: false }).selectOption("account");
  else await form.getByLabel("Thao tác bị hạn chế", { exact: false }).selectOption("commission_buying");
  await form.getByLabel("Nhóm lý do", { exact: false }).selectOption("dispute_or_report_abuse");
  await form.getByLabel("Giải thích (người dùng sẽ thấy)", { exact: false }).fill(explanation);
  await form.getByLabel("Ghi chú nội bộ (chỉ owner thấy)", { exact: false }).fill("Ghi chú tổng hợp riêng cho owner.");
  return penaltyResult.parse(await ownerCommand(page, "owner.trust_penalty_apply", () => form.getByRole("button", { name: "Áp dụng biện pháp", exact: true }).click())).penaltyId;
}

// Use the actual worker delivery function and encrypted handoff, as in tip tests.
// No SMTP, token SQL edit, or production-only endpoint is involved.
async function deliverNotice(buyer: number, excludeId?: string) {
  const fixture = databaseFixture();
  try {
    const [row] = await fixture.db.select({ id: identityEmailHandoffs.id }).from(identityEmailHandoffs)
      .where(and(eq(identityEmailHandoffs.userId, commissionBuyerId(buyer)), eq(identityEmailHandoffs.purpose, "enforcement_notice"),
        excludeId === undefined ? undefined : ne(identityEmailHandoffs.id, excludeId)));
    if (!row) throw new Error("Missing synthetic enforcement notice handoff");
    const sink = new DeterministicLocalSecurityEmailSink();
    const input = { handoffId: row.id, workerId: "synthetic-trust-browser", keyring, sender: sink, now: new Date() };
    expect(await deliverSecurityEmailHandoff(fixture.db, input)).toBe("delivered");
    expect(await deliverSecurityEmailHandoff(fixture.db, input)).toBe("already_delivered");
    expect(sink.snapshot()).toHaveLength(1);
    const message = sink.snapshot()[0]!;
    expect(message.purpose).toBe("enforcement_notice");
    expect(message.destination).toBe(`${commissionBuyerId(buyer)}@example.invalid`);
    const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).parse(message.secret);
    return { handoffId: row.id, url: `${origin}/help/locked#t=${token}` };
  } finally { await fixture.close(); }
}

test.describe("trust enforcement browser journeys", () => {
  test.describe.configure({ timeout: 180_000 });

  test("buyer reports a creator message, owner hides it, creator appeals, owner reverses, message visible again", async ({ page }) => {
    const buyer = 32;
    const orderId = await paidOrder(page, buyer);
    const text = "Tin nhắn tổng hợp cần được xem xét trong hành trình kháng nghị.";
    await page.getByPlaceholder("Nhắn cho người đặt…", { exact: true }).fill(text);
    await page.getByRole("form", { name: "Nhắn cho người đặt…", exact: true }).getByRole("button", { name: "Gửi", exact: true }).click();
    await expect(page.locator("[data-message-text]").filter({ hasText: text })).toBeVisible();
    await signIn(page, commissionBuyerToken(buyer));
    await page.goto(`/commissions/${orderId}`);
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText(text, { exact: true }) });
    const report = await submitReport(page, card.getByRole("button", { name: "Báo cáo", exact: true }));
    expect(report.reporterUserId).toBe(commissionBuyerId(buyer));
    const reason = "Ẩn tin nhắn tổng hợp để xem xét quyền riêng tư.";
    const hideId = await hide(page, report.caseId, reason);
    await signIn(page, commissionBuyerToken(buyer));
    await page.goto(`/commissions/${orderId}`);
    await expect(page.getByText(hiddenMessage, { exact: true })).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    const hiddenThread = await page.request.get(`/api/v1/commissions/${orderId}/thread`);
    expect(hiddenThread.status()).toBe(200);
    expect(await hiddenThread.text()).not.toContain(text);
    await signIn(page, tipBrowserSessionToken);
    await page.goto(`/creator/commissions/${orderId}`);
    await expect(page.getByText(hiddenMessage, { exact: true })).toBeVisible();
    await page.goto("/help/cases");
    const hideCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "Tin nhắn · Đã bị ẩn", exact: true }) });
    await expect(page.getByText(reason, { exact: true })).toHaveCount(0);
    await hideCard.getByRole("button", { name: "Kháng nghị", exact: true }).click();
    await hideCard.getByLabel("Trình bày kháng nghị", { exact: true }).fill("Đề nghị xem lại ngữ cảnh tin nhắn tổng hợp này.");
    const submitted = commandResponse(page, "/api/v1/help/appeals");
    await hideCard.getByRole("button", { name: "Gửi kháng nghị", exact: true }).click();
    const response = await submitted;
    expect(response.status()).toBe(202);
    const appealId = appealResultSchema.parse(await response.json()).appealId;
    const reasoning = "Đã xem lại ngữ cảnh và khôi phục tin nhắn tổng hợp.";
    await decideAppeal(page, await sourceCase("appeal", appealId), "reversed", reasoning);
    await signIn(page, commissionBuyerToken(buyer));
    await page.goto(`/commissions/${orderId}`);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByText(hiddenMessage, { exact: true })).toHaveCount(0);
    await signIn(page, tipBrowserSessionToken);
    await page.goto(`/creator/commissions/${orderId}`);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await page.goto("/help/cases");
    await expect(page.getByText(reasoning, { exact: true })).toBeVisible();
    const ownCases = await page.request.get("/api/v1/help/cases");
    expect(ownCases.status()).toBe(200);
    const rows = myCasesSchema.parse(await ownCases.json()).cases;
    expect(rows.hides?.find((entry) => entry.hideId === hideId)?.releasedAt).toBeTruthy();
    expect(rows.reportsFiled).toEqual([]);
  });

  test("guest reports a public package, owner hides it, package disappears from the creator page and checkout refuses", async ({ page }) => {
    // A dedicated package keeps a hidden item from breaking the other journeys.
    await signIn(page, tipBrowserSessionToken);
    const selected = await offering(page, "fixed_immediate");
    const workspaceResponse = await page.request.get("/api/v1/creator/commissions/packages");
    expect(workspaceResponse.status()).toBe(200);
    const workspace = workspaceSchema.parse(await workspaceResponse.json()).workspace;
    const headers = { origin, "idempotency-key": randomUUID(), "x-pawket-actor": tipBrowserUserId };
    const saved = await page.request.post("/api/v1/creator/commissions/packages", { headers, data: {
      pageId: workspace.pageId, packageId: null, expectedVersion: 0, draft: { title: "Gói riêng kiểm thử báo cáo khách",
        description: "Gói tổng hợp cho hành trình kiểm thử ẩn nội dung công khai.", discipline: selected.discipline, route: "fixed_immediate",
        briefInstructions: selected.briefInstructions, terms: selected.terms, showcaseId: null },
    } });
    expect(saved.status()).toBe(200);
    const packageId = packageResult.parse(await saved.json()).packageId;
    const published = await page.request.post("/api/v1/creator/commissions/packages/change", { headers: { ...headers, "idempotency-key": randomUUID() },
      data: { packageId, expectedVersion: 1, action: "publish", policyRevisionId: selected.policy!.revisionId } });
    expect(published.status()).toBe(200);
    const target = (await packages(page)).find((entry) => entry.id === packageId)!;
    expect(target).toBeTruthy();
    await page.context().clearCookies();
    await page.goto(`/creators/${tipBrowserHandle}/commissions/${packageId}`);
    await expect(page.getByText("Đăng nhập để đặt commission", { exact: true })).toBeVisible();
    const report = await submitReport(page, page.getByRole("button", { name: "Báo cáo", exact: true }));
    expect(report.reporterUserId).toBeNull();
    expect(report.reporterNetworkHmac).toBeTruthy();
    const hideId = await hide(page, report.caseId, "Ẩn gói tổng hợp sau khi xem xét báo cáo của khách.");
    await page.context().clearCookies();
    await page.goto(`/creators/${tipBrowserHandle}`);
    await expect(page.getByRole("link", { name: target.title, exact: true })).toHaveCount(0);
    expect((await packages(page)).some((entry) => entry.id === packageId)).toBe(false);
    expect((await page.goto(`/creators/${tipBrowserHandle}/commissions/${packageId}`))?.status()).toBe(404);
    await signIn(page, commissionBuyerToken(33));
    const checkout = await page.request.post("/api/v1/commissions", { headers: { origin, "idempotency-key": randomUUID(), "x-pawket-actor": commissionBuyerId(33) },
      data: { packageId, revisionId: target.revisionId, policyRevisionId: target.policy!.revisionId, acceptTerms: true,
        brief: { text: "Yêu cầu tổng hợp dùng phiên bản gói đã bị ẩn.", referenceLinks: [] } } });
    expect(checkout.status()).toBe(404);
    expect(await checkout.json()).toEqual({ code: "not_available" });
    const fixture = databaseFixture();
    try {
      const [row] = await fixture.db.select().from(trustContentHides).where(eq(trustContentHides.id, hideId));
      expect(row?.releasedAt).toBeNull();
    } finally { await fixture.close(); }
  });

  test("owner suspends a buyer account from a dispute case; the notice email link opens the locked case page; the buyer appeals; owner upholds; old link after resend shows the expired state", async ({ page, browser }) => {
    const buyer = 34;
    const orderId = await paidOrder(page, buyer);
    const caseId = await disputeCase(page, buyer, orderId);
    const explanation = "Tạm khóa tài khoản tổng hợp trong hành trình xem xét khiếu nại.";
    const penaltyId = await applyBuyerPenalty(page, caseId, buyer, "suspension", explanation);
    const notice = await deliverNotice(buyer);
    const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } });
    try {
      const locked = await context.newPage();
      const suspended = await context.request.get(`/api/v1/commissions/${orderId}`, { headers: { cookie: `pawket.session=${commissionBuyerToken(buyer)}` } });
      expect(suspended.status()).toBe(401);
      await locked.goto(notice.url);
      await expect(locked).toHaveURL(`${origin}/help/locked/case`);
      await expect(locked.getByText(explanation, { exact: true })).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === "pawket.session")).toBe(false);
      const helpCookie = (await context.cookies()).find((cookie) => cookie.name === "pawket_help");
      expect(helpCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/help/locked" });
      await expect(locked.getByText("Ghi chú tổng hợp riêng cho owner.", { exact: true })).toHaveCount(0);
      await locked.getByLabel("Trình bày kháng nghị", { exact: true }).fill("Đề nghị xem lại biện pháp tạm khóa tài khoản tổng hợp.");
      const submitted = commandResponse(locked, "/help/locked/appeal");
      await locked.getByRole("button", { name: "Gửi kháng nghị", exact: true }).click();
      const response = await submitted;
      expect(response.status()).toBe(202);
      const appealId = appealResultSchema.parse(await response.json()).appealId;
      const reasoning = "Giữ nguyên biện pháp sau khi xem xét kháng nghị tổng hợp.";
      await decideAppeal(page, await sourceCase("appeal", appealId), "upheld", reasoning);
      await locked.reload();
      await expect(locked.getByText("Kháng nghị · Đã giữ nguyên biện pháp", { exact: true })).toBeVisible();
      await expect(locked.getByText(reasoning, { exact: true })).toBeVisible();
      await expect(locked.getByRole("button", { name: "Gửi kháng nghị", exact: true })).toHaveCount(0);
      await locked.goto("/help/locked/resend");
      await locked.getByLabel("Email", { exact: true }).fill(`${commissionBuyerId(buyer)}@example.invalid`);
      const requested = commandResponse(locked, "/help/locked/link-request");
      await locked.getByRole("button", { name: "Gửi liên kết mới", exact: true }).click();
      expect((await requested).status()).toBe(204);
      await expect(locked.getByText("Nếu email này thuộc một tài khoản đang bị khóa, Pawket đã gửi liên kết mới.", { exact: true })).toBeVisible();
      const resent = await deliverNotice(buyer, notice.handoffId);
      // Resend revokes both the old link and its help session.
      await locked.goto("/help/locked/case");
      await expect(locked.getByText("Liên kết không còn hiệu lực.", { exact: true })).toBeVisible();
      await locked.goto(notice.url);
      await expect(locked.getByText("Liên kết không còn hiệu lực.", { exact: true })).toBeVisible();
      await expect(locked.getByRole("link", { name: "Yêu cầu liên kết mới", exact: true })).toBeVisible();
      await locked.goto(resent.url);
      await expect(locked).toHaveURL(`${origin}/help/locked/case`);
      await expect(locked.getByText(reasoning, { exact: true })).toBeVisible();
      const fixture = databaseFixture();
      try {
        const [appeal] = await fixture.db.select().from(trustAppeals).where(eq(trustAppeals.id, appealId));
        expect(appeal).toMatchObject({ penaltyId, state: "upheld", submittedVia: "help_link" });
      } finally { await fixture.close(); }
    } finally { await context.close(); }
  });

  test("commission_buying restriction blocks a new request with the generic message and lifts after the owner lifts it", async ({ page }) => {
    const buyer = 35;
    const orderId = await paidOrder(page, buyer);
    const caseId = await disputeCase(page, buyer, orderId);
    const penaltyId = await applyBuyerPenalty(page, caseId, buyer, "restriction", "Hạn chế đặt commission cho tài khoản tổng hợp.");
    await signIn(page, commissionBuyerToken(buyer));
    const selected = await offering(page, "fixed_approval");
    await page.goto(`/creators/${tipBrowserHandle}/commissions/${selected.id}`);
    await fillBrief(page);
    const rejected = commandResponse(page, "/api/v1/commissions");
    await page.getByRole("button", { name: "Gửi yêu cầu commission", exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ code: "not_available" });
    await expect(page.getByText(unavailable, { exact: true })).toBeVisible();
    const list = await page.request.get("/api/v1/commissions");
    expect(list.status()).toBe(200);
    expect(ordersSchema.parse(await list.json()).orders.items.map((entry) => entry.id)).toEqual([orderId]);
    await signIn(page, tipPolicyOwnerSessionToken);
    await page.goto("/admin/cases");
    await page.getByRole("button", { name: "Biện pháp", exact: true }).click();
    const penalty = page.getByRole("article").filter({ has: page.getByRole("heading", { name: `Hạn chế · ${commissionBuyerId(buyer)}`, exact: true }) });
    await penalty.getByLabel("Lý do gỡ biện pháp", { exact: false }).fill("Gỡ hạn chế đặt commission sau khi xem xét lại.");
    await ownerCommand(page, "owner.trust_penalty_lift", () => penalty.getByRole("button", { name: "Gỡ biện pháp", exact: true }).click());
    await signIn(page, commissionBuyerToken(buyer));
    await page.goto("/help/cases");
    const casesResponse = await page.request.get("/api/v1/help/cases");
    expect(casesResponse.status()).toBe(200);
    expect(myCasesSchema.parse(await casesResponse.json()).cases.penalties?.find((entry) => entry.penaltyId === penaltyId)?.state).toBe("lifted");
    await page.goto(`/creators/${tipBrowserHandle}/commissions/${selected.id}`);
    await fillBrief(page);
    await page.getByRole("button", { name: "Gửi yêu cầu commission", exact: true }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4181\/commissions\/[0-9a-f-]{36}$/u);
    expect(new URL(page.url()).pathname).not.toBe(`/commissions/${orderId}`);
    await expect(page.locator("[data-order-state]")).toHaveText("Chờ nghệ sĩ");
  });
});
