import { describe, expect, test } from "vitest";

import {
  ownerActionMessage,
  reconciliationNotice,
} from "../src/app/admin/creator-applications/owner-feedback";

describe("owner acceptance feedback", () => {
  test("distinguishes matched reconciliation from an unmatched audit record", () => {
    expect(reconciliationNotice({ reconciliation: { kind: "matched" } })).toEqual({
      tone: "success",
      text: "Đã đối soát khớp và tạo nghĩa vụ hoàn trả. Danh sách hoàn trả đã được làm mới.",
    });
    expect(
      reconciliationNotice({
        reconciliation: { kind: "unmatched", reason: "source_mismatch" },
      }),
    ).toEqual({
      tone: "warning",
      text: "Giao dịch được ghi nhận là chưa khớp: tài khoản nguồn không khớp. Chưa tạo nghĩa vụ hoàn trả.",
    });
    expect(() => reconciliationNotice({ reconciliation: { kind: "unknown" } })).toThrow(
      "Reconciliation response is invalid",
    );
  });

  test("surfaces approval guards and safely bounds unknown owner codes", () => {
    expect(ownerActionMessage("REFUND_OBLIGATION_MISSING")).toBe(
      "Chưa có nghĩa vụ hoàn trả gắn đúng bằng chứng xác minh.",
    );
    expect(ownerActionMessage("NEW_SAFE_CODE")).toBe(
      "Chưa thể hoàn tất thao tác owner (mã NEW_SAFE_CODE).",
    );
    expect(ownerActionMessage("unsafe detail")).toBe("Chưa thể hoàn tất thao tác owner.");
  });
});
