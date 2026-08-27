import { expect, test } from "@playwright/test";

test("Save Draft bypasses incomplete required fields while Submit remains browser completeness-gated", async ({ page }) => {
  // Break caught: browser constraint validation blocking a private draft save, or allowing an incomplete submission.
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/receiving-account")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ account: { referenceId: "account-1", bankBin: "970436", bankName: "Vietcombank", maskedSuffix: "•••• 1234", proofState: "unverified" } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        application: {
          id: "draft-1",
          state: path.endsWith("/submit") ? "submitted" : "draft",
          version: path.endsWith("/submit") ? 2 : 1,
        },
      }),
    });
  });

  await page.goto("/creator/apply");
  await page.getByRole("button", { name: "Lưu bản nháp" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã lưu bản nháp riêng tư.");

  await page.getByRole("button", { name: "Gửi hồ sơ" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã lưu bản nháp riêng tư.");
});

test("reapplication cooldown is displayed in the Ho Chi Minh calendar date", async ({ page }) => {
  // Break caught: formatting the absolute cooldown instant in the browser or host machine's time zone.
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/receiving-account")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ account: null }) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        application: {
          id: "rejected-1",
          state: "rejected",
          version: 3,
          cooldownUntil: "2026-03-14T17:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/creator/apply");
  await expect(page.getByText("Bạn có thể nộp lại từ", { exact: false })).toContainText(
    "15/3/2026",
  );
});

test("changes requested shows the owner explanation without private review data", async ({ page }) => {
  // Break caught: rendering only an internal state token and leaving the applicant
  // unable to know what must change before resubmission.
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/receiving-account")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ account: null }) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        application: {
          id: "changes-requested-1",
          state: "changes_requested",
          version: 3,
          latestDecision: {
            action: "changes_requested",
            reasonCode: "portfolio_insufficient",
            applicantExplanation: "Please add one more public portfolio link.",
            createdAt: "2026-08-27T00:00:00.000Z",
          },
        },
      }),
    });
  });

  await page.goto("/creator/apply");
  await expect(page.getByText("Cần cập nhật", { exact: true })).toBeVisible();
  await expect(page.getByText("Owner yêu cầu cập nhật")).toBeVisible();
  await expect(page.getByText("Please add one more public portfolio link.")).toBeVisible();
  await expect(page.getByText("Lý do: Portfolio chưa đủ.")).toBeVisible();
  await expect(page.getByText("Private review detail")).toHaveCount(0);
});

test("an under-review application keeps deposit instructions visible and locks revision fields", async ({ page }) => {
  // Break caught: owner claim changes submitted to under_review, which previously
  // hid the challenge workflow and made the immutable review snapshot look editable.
  await page.route("**/api/v1/creator-application**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/receiving-account")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          account: {
            referenceId: "00000000-0000-4000-8000-000000000001",
            bankBin: "970415",
            bankName: "VietinBank",
            maskedSuffix: "•••• 0000",
            proofState: "challenge_issued",
          },
        }),
      });
      return;
    }
    if (path.endsWith("/deposit")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          deposit: {
            proofState: "issued",
            refundState: null,
            refundNotBefore: null,
            refundDue: null,
            challengeId: "00000000-0000-4000-8000-000000000002",
            amountVnd: 1000,
            expiresAt: "2026-08-30T12:00:00.000Z",
            operatingAccount: {
              bankBin: "000000",
              bankName: "Pawket Test Bank",
              accountNumber: "000000",
              accountHolderLabel: "PAWKET PLAYWRIGHT",
            },
          },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        application: {
          id: "00000000-0000-4000-8000-000000000003",
          state: "under_review",
          version: 4,
          revision: {
            artistDisplayName: "Synthetic Artist",
            shortIntroduction: "Synthetic review record",
            dateOfBirth: "2004-01-21",
            portfolioUrls: ["https://example.com/synthetic"],
            primaryArtDiscipline: "Illustration",
            practiceDescription: "Synthetic QA only",
            contentIntent: "general_audience_only",
            proposedReceivingAccountId: "00000000-0000-4000-8000-000000000001",
          },
        },
      }),
    });
  });

  await page.goto("/creator/apply");
  await expect(page.getByRole("heading", { name: "Trạng thái khoản nộp và hoàn trả" })).toBeVisible();
  await expect(page.getByText(/Chuyển đúng 1\.000 VND/u)).toContainText("Pawket Test Bank");
  await expect(page.getByRole("button", { name: "Tôi đã chuyển từ tài khoản đã khai" })).toBeVisible();
  await expect(page.getByLabel("Tên nghệ sĩ")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tạo phiên bản tài khoản mới" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Lưu bản nháp" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Gửi hồ sơ" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Rút hồ sơ" })).toBeEnabled();
});
