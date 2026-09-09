import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import {
  adminAuditEvents,
  createDatabase,
  creatorHandleClaims,
  creatorPageDrafts,
  creatorPages,
  creatorShowcaseDrafts,
  publicMediaAssets,
  systemOutbox,
} from "@pawket/database";
import {
  closeReadinessConnection,
  createReadinessConnection,
  readPublicMediaWorkerHealth,
} from "@pawket/queue";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  assertIncrementThreeBrowserDatabaseName,
  browserDatabaseUrl,
} from "./increment-three-database";
import {
  acceptanceCreatorApprovedRevisionId,
  acceptanceCreatorUserId,
  currentOwnerTotp,
  signInAsAcceptanceCreator,
  signInAsOwner,
  syntheticPng,
} from "./increment-three-fixture";
import { resetIncrementThreeState } from "./increment-three-global-setup";

const canonicalHandle = "task17-artist";
const aliasHandle = "task17-first";
const guestReportDetail = "Synthetic Task 17 guest report";
const authenticatedReportDetail = "Synthetic Task 17 authenticated report";
const primaryShowcaseTitle = "Task 17 synthetic work";
const leadingShowcaseTitle = "Task 17 leading work";
const metricsToken = "playwright-metrics-token-000000000000";
const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const candidateRevision =
  process.env.PAWKET_BROWSER_APP_REVISION ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const expectedCurrentFinancialTables = [
  "payments_receiving_account_onboarding",
  "payments_unmatched_deposits",
  "payments_verification_deposit_challenges",
  "payments_verification_deposit_receipts",
  "payments_verification_deposit_refund_obligations",
  "payments_verification_deposit_refunds",
  "payments_verification_deposit_reports",
] as const;

async function readFinancialTableCounts() {
  const database = createDatabase(browserDatabaseUrl);
  try {
    const [connected] = await database.db.execute<{ current_database: string }>(
      sql`select current_database() as current_database`,
    );
    assertIncrementThreeBrowserDatabaseName(connected?.current_database);
    const rows = await database.db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
        and table_name ~ '(^|_)(payments?|tips?|vietqr|sepay|commissions?|orders?|refunds?|deposits?|bank_transactions?)(_|$)'
      order by table_name
    `);
    const tableNames = [...rows].map((row) => row.table_name);
    expect(expectedCurrentFinancialTables.length).toBeGreaterThan(0);
    expect(tableNames).toEqual(
      expect.arrayContaining([...expectedCurrentFinancialTables]),
    );
    expect(tableNames.length).toBeGreaterThanOrEqual(
      expectedCurrentFinancialTables.length,
    );
    const counts: Record<string, number> = {};
    for (const tableName of tableNames) {
      if (!/^[a-z][a-z0-9_]*$/u.test(tableName)) {
        throw new Error("Financial table discovery returned an unsafe identifier");
      }
      const [result] = await database.db.execute<{ count: number | string }>(
        sql.raw(`select count(*)::int as count from "${tableName}"`),
      );
      counts[tableName] = Number(result?.count);
    }
    return counts;
  } finally {
    await database.close();
  }
}

async function initializeAndVerifySeed(page: Page) {
  const database = createDatabase(browserDatabaseUrl);
  try {
    const before = await database.db
      .select({ id: creatorPages.id })
      .from(creatorPages)
      .where(eq(creatorPages.userId, acceptanceCreatorUserId));
    expect(before).toEqual([]);
    expect(
      await database.db
        .select({ id: creatorHandleClaims.id })
        .from(creatorHandleClaims)
        .innerJoin(creatorPages, eq(creatorHandleClaims.pageId, creatorPages.id))
        .where(eq(creatorPages.userId, acceptanceCreatorUserId)),
    ).toEqual([]);
    expect(
      await database.db
        .select({ id: creatorShowcaseDrafts.id })
        .from(creatorShowcaseDrafts)
        .innerJoin(creatorPages, eq(creatorShowcaseDrafts.pageId, creatorPages.id))
        .where(eq(creatorPages.userId, acceptanceCreatorUserId)),
    ).toEqual([]);
    expect(
      await database.db
        .select({ id: publicMediaAssets.id })
        .from(publicMediaAssets)
        .where(eq(publicMediaAssets.ownerUserId, acceptanceCreatorUserId)),
    ).toEqual([]);
  } finally {
    await database.close();
  }

  await signInAsAcceptanceCreator(page);
  await page.goto("/creator");
  await expect(
    page.getByRole("heading", { name: "Góc làm việc trang nhà sáng tạo" }),
  ).toBeVisible();
  await expect(page.getByLabel("Tên hiển thị")).toHaveValue("Task 17 Creator");
  await expect(page.getByLabel("Giới thiệu")).toHaveValue(
    "Synthetic approved creator with no catalog page.",
  );
  await expect(page.getByLabel("Chuyên ngành chính")).toHaveValue("other");

  const initialized = createDatabase(browserDatabaseUrl);
  try {
    const [pageRow] = await initialized.db
      .select({
        id: creatorPages.id,
        initializedFromRevisionId: creatorPages.initializedFromRevisionId,
      })
      .from(creatorPages)
      .where(eq(creatorPages.userId, acceptanceCreatorUserId));
    expect(pageRow).toMatchObject({
      id: expect.any(String),
      initializedFromRevisionId: acceptanceCreatorApprovedRevisionId,
    });
    const [draft] = await initialized.db
      .select({
        displayName: creatorPageDrafts.displayName,
        introduction: creatorPageDrafts.shortIntroduction,
        primaryDiscipline: creatorPageDrafts.primaryDiscipline,
        secondaryDisciplines: creatorPageDrafts.secondaryDisciplines,
        avatarAssetId: creatorPageDrafts.avatarAssetId,
        coverAssetId: creatorPageDrafts.coverAssetId,
      })
      .from(creatorPageDrafts)
      .where(eq(creatorPageDrafts.pageId, pageRow!.id));
    expect(draft).toEqual({
      displayName: "Task 17 Creator",
      introduction: "Synthetic approved creator with no catalog page.",
      primaryDiscipline: "other",
      secondaryDisciplines: [],
      avatarAssetId: null,
      coverAssetId: null,
    });
    expect(
      await initialized.db
        .select({ id: creatorHandleClaims.id })
        .from(creatorHandleClaims)
        .where(eq(creatorHandleClaims.pageId, pageRow!.id)),
    ).toEqual([]);
    expect(
      await initialized.db
        .select({ id: creatorShowcaseDrafts.id })
        .from(creatorShowcaseDrafts)
        .where(eq(creatorShowcaseDrafts.pageId, pageRow!.id)),
    ).toEqual([]);
    expect(
      await initialized.db
        .select({ id: publicMediaAssets.id })
        .from(publicMediaAssets)
        .where(eq(publicMediaAssets.ownerUserId, acceptanceCreatorUserId)),
    ).toEqual([]);
    return pageRow!.id;
  } finally {
    await initialized.close();
  }
}

async function claimRenameAndVerifyAlias(page: Page) {
  await page.getByLabel("Handle").fill(aliasHandle);
  await page.getByRole("button", { name: "Nhận handle" }).click();
  await expect(page.getByText("Đã cập nhật địa chỉ trang.")).toBeVisible();

  await page.getByLabel("Handle").fill(canonicalHandle);
  await page.getByRole("button", { name: "Đổi handle" }).click();
  await expect(page.getByText("Đã cập nhật địa chỉ trang.")).toBeVisible();
  await expect(page.getByText(`Alias đang chuyển hướng: ${aliasHandle}`)).toBeVisible();

  await page.getByLabel("Handle").fill("task17-too-soon");
  await page.getByRole("button", { name: "Đổi handle" }).click();
  await expect(page.getByText(/chỉ có thể đổi handle sau/u)).toBeVisible();
  await expect(page.getByText(/Bản nháp trên máy chủ đã thay đổi/u)).toHaveCount(0);
}

async function uploadValidAndRejectInvalidMedia(page: Page) {
  await page.getByLabel("Tải ảnh bìa").setInputFiles({
    name: "forbidden.gif",
    mimeType: "image/gif",
    buffer: Buffer.from("GIF89a", "ascii"),
  });
  await expect(
    page.getByText("Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP."),
  ).toBeVisible();

  await page.getByLabel("Tải ảnh đại diện").setInputFiles({
    name: "task17-avatar.png",
    mimeType: "image/png",
    buffer: syntheticPng,
  });
  await expect(page.getByText("Ảnh đại diện đã sẵn sàng.")).toBeVisible({
    timeout: 90_000,
  });
  const response = await page.request.get("/api/v1/creator-page");
  expect(response).toBeOK();
  const payload = (await response.json()) as {
    workspace: {
      draft: { avatarAssetId: string | null };
      media: Array<{ assetId: string; state: string }>;
    };
  };
  const assetId = payload.workspace.draft.avatarAssetId;
  expect(assetId).toEqual(expect.any(String));
  expect(payload.workspace.media).toContainEqual(
    expect.objectContaining({ assetId, state: "ready" }),
  );
  return assetId!;
}

async function buildPreviewPublishAndDiscover(
  page: Page,
  browser: Browser,
  assetId: string,
) {
  await page.getByLabel("Tên hiển thị").fill("Task 17 Journey Artist");
  await page
    .getByLabel("Giới thiệu")
    .fill("Synthetic nonfinancial creator catalog acceptance journey.");
  await page.getByLabel("Chuyên ngành chính").selectOption("illustration");
  await page.getByRole("checkbox", { name: "drawing" }).check();
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();

  await page.locator("#new-showcase-title").fill(primaryShowcaseTitle);
  await page
    .locator("#new-showcase-description")
    .fill("Static synthetic work with no payment behavior.");
  await page
    .locator("#new-showcase-url")
    .fill("https://example.com/task17-synthetic-work");
  await page.getByRole("button", { name: "Tạo showcase" }).click();
  await expect(page.getByText("Đã tạo showcase.")).toBeVisible();

  await page.locator("#new-showcase-title").fill(leadingShowcaseTitle);
  await page
    .locator("#new-showcase-description")
    .fill("Second synthetic work used to prove publication ordering.");
  await page
    .locator("#new-showcase-discipline")
    .selectOption("photography");
  await page
    .locator("#new-showcase-url")
    .fill("https://example.com/task17-leading-work");
  await page.getByRole("button", { name: "Tạo showcase" }).click();
  await expect(page.getByText("Đã tạo showcase.")).toBeVisible();
  const leadingShowcase = page.locator("article.showcase-editor__item", {
    has: page.locator(`input[value="${leadingShowcaseTitle}"]`),
  });
  await expect(leadingShowcase).toHaveCount(1, { timeout: 10_000 });
  await leadingShowcase
    .getByRole("button", { name: "Di chuyển lên" })
    .click({ timeout: 10_000 });
  await expect(page.getByText("Đã cập nhật thứ tự tác phẩm.")).toBeVisible();

  const previewMediaResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/media/${assetId}/display` && url.search === "?preview=1";
  });
  await page.goto("/creator/preview");
  await expect(page.getByText("Bản nháp riêng tư")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Task 17 Journey Artist" }),
  ).toBeVisible();
  await expect(page.locator("section.creator-showcase h2")).toHaveText([
    leadingShowcaseTitle,
    primaryShowcaseTitle,
  ]);
  const previewImage = page.getByAltText("Ảnh đại diện của Task 17 Journey Artist");
  await expect(previewImage).toBeVisible();
  expect((await previewMediaResponse).status()).toBe(200);
  await expect(previewImage).toHaveJSProperty("complete", true);
  expect(await previewImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    expect((await anonymous.request.get(`/media/${assetId}/display`)).status()).toBe(404);
  } finally {
    await anonymous.close();
  }

  await page.goto("/creator");
  await page.getByRole("button", { name: "Xuất bản trang" }).click();
  await expect(page.getByText("Trang đã được xuất bản.")).toBeVisible();

  await page.goto(`/creators/${canonicalHandle}`);
  await expect(
    page.getByRole("heading", { name: "Task 17 Journey Artist" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Task 17 Journey Artist · Pawket");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `/creators/${canonicalHandle}`,
  );
  await expect(page.locator("section.creator-showcase h2")).toHaveText([
    leadingShowcaseTitle,
    primaryShowcaseTitle,
  ]);
  expect((await page.request.get(`/media/${assetId}/display`)).status()).toBe(200);
  const alias = await page.request.get(`/creators/${aliasHandle}`, { maxRedirects: 0 });
  expect(alias.status()).toBe(308);
  expect(alias.headers().location).toBe(`/creators/${canonicalHandle}`);

  await page.goto(`/creators?discipline=illustration&handle=task17-a`);
  await expect(page.getByRole("link", { name: "Task 17 Journey Artist" })).toBeVisible();
  await page.goto(`/creators?discipline=photography&handle=task17-a`);
  await expect(page.getByRole("link", { name: "Task 17 Journey Artist" })).toHaveCount(0);

  await page.goto("/creator");
  await page.getByLabel("Tên hiển thị").fill("Task 17 private next draft");
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();
  await page.goto("/creator/preview");
  await expect(
    page.getByRole("heading", { name: "Task 17 private next draft" }),
  ).toBeVisible();
  const liveWhileDraftChanged = await page.request.get(`/creators/${canonicalHandle}`);
  expect(liveWhileDraftChanged).toBeOK();
  expect(await liveWhileDraftChanged.text()).not.toContain("Task 17 private next draft");
  await page.goto("/creator");
  await page.getByLabel("Tên hiển thị").fill("Task 17 Journey Artist");
  await page.getByRole("button", { name: "Lưu hồ sơ nháp" }).click();
  await expect(page.getByText("Đã lưu hồ sơ vào bản nháp riêng tư.")).toBeVisible();
}

async function submitReport(page: Page, detail: string) {
  await page.goto(`/creators/${canonicalHandle}`);
  await page.getByRole("button", { name: "Báo cáo trang này" }).click();
  await page.getByLabel("Chi tiết").fill(detail);
  await page.getByRole("button", { name: "Gửi báo cáo" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Đã nhận báo cáo" }),
  ).toBeVisible({ timeout: 120_000 });
}

async function reportTriageHideRestore(page: Page) {
  await page.context().clearCookies();
  await submitReport(page, guestReportDetail);

  await signInAsAcceptanceCreator(page);
  await submitReport(page, authenticatedReportDetail);

  await signInAsOwner(page);
  await page.goto("/admin/content-reports");
  await expect(
    page.getByRole("heading", { name: "Báo cáo nội dung công khai" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /reporterUserId|người báo cáo/iu,
  );

  const guestReport = page.locator("article").filter({ hasText: guestReportDetail });
  await guestReport.getByRole("button", { name: "Bỏ qua báo cáo" }).click();
  await expect(
    page.getByRole("dialog", { name: "Xác nhận TOTP mới" }),
  ).toBeVisible();
  await page.getByLabel("Mã TOTP").fill(currentOwnerTotp());
  await page.getByRole("button", { name: "Xác minh và thử lại" }).click();
  await expect(page.getByText("Đã đóng báo cáo và ghi audit event.")).toBeVisible();

  const authenticatedReport = page
    .locator("article")
    .filter({ hasText: authenticatedReportDetail });
  await authenticatedReport.getByRole("button", { name: "Ẩn mục tiêu" }).click();
  await expect(page.getByText("Đã ẩn mục tiêu và ghi audit event.")).toBeVisible();
  expect((await page.request.get(`/creators/${canonicalHandle}`)).status()).toBe(404);

  await page.goto("/admin/content-reports");
  const heldReport = page
    .locator("article")
    .filter({ hasText: authenticatedReportDetail });
  await heldReport.getByRole("button", { name: "Khôi phục mục tiêu" }).click();
  await expect(page.getByText("Đã khôi phục mục tiêu và ghi audit event.")).toBeVisible();
  expect((await page.request.get(`/creators/${canonicalHandle}`)).status()).toBe(200);
}

async function suspendReinstateRepublishUnpublish(page: Page, assetId: string) {
  await page.goto("/admin/creator-applications");
  await page.getByRole("button", { name: /Quyền creator/u }).click();
  let creator = page.locator(".item-row").filter({ hasText: acceptanceCreatorUserId });
  await creator.getByRole("button", { name: "Tạm dừng" }).click();
  await expect(page.getByText("Đã tạm dừng quyền creator.")).toBeVisible();
  expect((await page.request.get(`/creators/${canonicalHandle}`)).status()).toBe(404);
  expect((await page.request.get(`/media/${assetId}/display`)).status()).toBe(404);

  await page.goto("/admin/creator-applications");
  await page.getByRole("button", { name: /Quyền creator/u }).click();
  creator = page.locator(".item-row").filter({ hasText: acceptanceCreatorUserId });
  await creator.getByRole("button", { name: "Khôi phục" }).click();
  await expect(page.getByText("Đã khôi phục quyền creator.")).toBeVisible();
  expect((await page.request.get(`/creators/${canonicalHandle}`)).status()).toBe(404);
  expect((await page.request.get(`/media/${assetId}/display`)).status()).toBe(404);

  await signInAsAcceptanceCreator(page);
  await page.goto("/creator");
  await page.getByRole("button", { name: "Xuất bản trang" }).click();
  await expect(page.getByText("Trang đã được xuất bản.")).toBeVisible();
  expect((await page.request.get(`/creators/${canonicalHandle}`)).status()).toBe(200);
  expect((await page.request.get(`/media/${assetId}/display`)).status()).toBe(200);

  await page.goto("/creator");
  await page.getByRole("button", { name: "Gỡ xuất bản" }).click();
  await expect(page.getByText("Trang đã được gỡ khỏi công khai.")).toBeVisible();
}

async function verifyEveryPublicAndMediaRouteClosed(page: Page, assetId: string) {
  await page.context().clearCookies();
  for (const handle of [canonicalHandle, aliasHandle]) {
    const response = await page.request.get(`/creators/${handle}`, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  }
  const directory = await page.request.get(`/creators?handle=${canonicalHandle}`);
  expect(directory).toBeOK();
  expect(await directory.text()).not.toContain("Task 17 Journey Artist");
  const sitemap = await page.request.get("/sitemap.xml");
  expect(sitemap).toBeOK();
  expect(await sitemap.text()).not.toContain(`/creators/${canonicalHandle}`);
  for (const variant of ["master", "thumb", "display", "large"] as const) {
    expect((await page.request.get(`/media/${assetId}/${variant}`)).status()).toBe(404);
    expect((await page.request.head(`/media/${assetId}/${variant}`)).status()).toBe(404);
  }
}

async function verifyOperationalEvidence(
  request: APIRequestContext,
  journeyStartedAt: number,
) {
  await expect
    .poll(async () => {
      const database = createDatabase(browserDatabaseUrl);
      try {
        const [pending] = await database.db
          .select({ count: sql<number>`count(*)::int` })
          .from(systemOutbox)
          .where(isNull(systemOutbox.publishedAt));
        return Number(pending?.count);
      } finally {
        await database.close();
      }
    }, { timeout: 120_000, message: "Increment 3 outbox must fully drain" })
    .toBe(0);

  const database = createDatabase(browserDatabaseUrl);
  try {
    const [outboxTotal] = await database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemOutbox);
    expect(Number(outboxTotal?.count)).toBeGreaterThan(0);
    const audits = await database.db
      .select({ action: adminAuditEvents.action, outcome: adminAuditEvents.outcome })
      .from(adminAuditEvents)
      .where(
        and(
          eq(adminAuditEvents.actorUserId, "task15-owner"),
          inArray(adminAuditEvents.action, [
            "trust.public_report.dismiss",
            "trust.public_report.hide",
            "trust.public_report.restore",
          ]),
        ),
      );
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: "trust.public_report.dismiss", outcome: "succeeded" },
        { action: "trust.public_report.hide", outcome: "succeeded" },
        { action: "trust.public_report.restore", outcome: "succeeded" },
      ]),
    );
  } finally {
    await database.close();
  }

  const webReady = await request.get("/api/health/ready");
  expect(webReady).toBeOK();
  expect(await webReady.json()).toEqual({
    status: "ready",
    database: "up",
    valkey: "up",
    publicMediaStorage: "up",
    publicMediaWorkerScan: "up",
    revision: candidateRevision,
    buildRevision: candidateRevision,
    revisionMatch: true,
  });
  const workerReady = await request.get("http://127.0.0.1:9464/health/ready");
  expect(workerReady).toBeOK();
  expect(await workerReady.json()).toEqual({
    status: "ready",
    initialized: true,
    poll: "up",
    refundScan: "up",
    publicMediaCleanupScan: "up",
    revision: candidateRevision,
    buildRevision: candidateRevision,
    revisionMatch: true,
  });

  const healthConnection = createReadinessConnection(
    process.env.PAWKET_BROWSER_VALKEY_URL ??
      process.env.TEST_VALKEY_URL ??
      "redis://127.0.0.1:6379",
  );
  try {
    const workerHealth = await readPublicMediaWorkerHealth(healthConnection);
    expect(workerHealth).toEqual({
      revision: candidateRevision,
      scanSucceededAtMs: expect.any(Number),
    });
    expect(workerHealth!.scanSucceededAtMs).toBeGreaterThanOrEqual(journeyStartedAt);
    expect(workerHealth!.scanSucceededAtMs).toBeLessThanOrEqual(Date.now());
  } finally {
    await closeReadinessConnection(healthConnection);
  }

  const authorization = { authorization: `Bearer ${metricsToken}` };
  const webMetricsResponse = await request.get("/api/metrics", { headers: authorization });
  expect(webMetricsResponse).toBeOK();
  const webMetrics = await webMetricsResponse.text();
  expect(webMetrics).toContain("pawket_catalog_operations_total");
  expect(webMetrics).toContain("pawket_public_media_operations_total");
  expect(webMetrics).toContain("pawket_creator_directory_resolutions_total");
  expect(webMetrics).toContain("pawket_public_content_report_operations_total");
  const workerMetricsResponse = await request.get("http://127.0.0.1:9464/metrics", {
    headers: authorization,
  });
  expect(workerMetricsResponse).toBeOK();
  const workerMetrics = await workerMetricsResponse.text();
  expect(workerMetrics).toMatch(
    /pawket_worker_scan_healthy\{scan="public_media_cleanup"\} 1/u,
  );
  expect(workerMetrics).toMatch(
    /pawket_worker_last_success_timestamp_seconds\{scan="public_media_cleanup"\} [1-9][0-9]*/u,
  );
  expect(workerMetrics).toMatch(
    /pawket_public_media_cleanup_oldest_eligible_timestamp_seconds [0-9]+/u,
  );
  expect(workerMetrics).toMatch(/pawket_revision_match\{service="worker"\} 1/u);
  for (const privateValue of [
    acceptanceCreatorUserId,
    canonicalHandle,
    guestReportDetail,
    authenticatedReportDetail,
  ]) {
    expect(webMetrics).not.toContain(privateValue);
    expect(workerMetrics).not.toContain(privateValue);
  }
}

test("Increment 3 synthetic creator journey remains nonfinancial", async ({
  browser,
  page,
  request,
}) => {
  // Break caught: the full creator lifecycle skips a real boundary, leaks closed content, or mutates financial state.
  test.setTimeout(600_000);
  const journeyStartedAt = Date.now();
  await test.step("reset state and prove the empty seed", async () => {
    await resetIncrementThreeState();
    await initializeAndVerifySeed(page);
  });
  const before = await test.step("snapshot every financial table", async () =>
    readFinancialTableCounts(),
  );
  await test.step("claim, rename, and rate-limit the creator handle", async () => {
    await claimRenameAndVerifyAlias(page);
  });
  const assetId = await test.step("validate and process public media", async () =>
    uploadValidAndRejectInvalidMedia(page),
  );
  await test.step("build, order, preview, publish, and discover the catalog", async () => {
    await buildPreviewPublishAndDiscover(page, browser, assetId);
  });
  await test.step("report, triage, hide, and restore public content", async () => {
    await reportTriageHideRestore(page);
  });
  await test.step("suspend, reinstate, republish, and unpublish the creator", async () => {
    await suspendReinstateRepublishUnpublish(page, assetId);
  });
  await test.step("prove every public and media route is closed", async () => {
    await verifyEveryPublicAndMediaRouteClosed(page, assetId);
  });
  await test.step("prove every financial table is unchanged", async () => {
    expect(await readFinancialTableCounts()).toEqual(before);
  });
  await test.step("prove exact-revision readiness", async () => {
    await expect
      .poll(async () => (await request.get("/api/health/ready")).status(), {
        timeout: 120_000,
        message: "web readiness must observe the real exact-revision worker scan in Valkey",
      })
      .toBe(200);
  });
  await test.step("prove operational evidence and bounded telemetry", async () => {
    await verifyOperationalEvidence(request, journeyStartedAt);
  });
});
