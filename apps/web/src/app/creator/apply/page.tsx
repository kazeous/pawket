"use client";

import { type FormEvent, useEffect, useState } from "react";

const warning =
  "Tôi xác nhận ngày, tháng, năm sinh đã khai là đúng sự thật. Nếu sau này giấy tờ hoặc thông tin xác minh hợp lệ không khớp vì tôi đã cung cấp thông tin không trung thực khi đăng ký, Pawket sẽ không giải quyết các yêu cầu dựa trên thông tin sai lệch đó và có thể áp dụng biện pháp tài khoản theo chính sách, trừ trường hợp pháp luật bắt buộc Pawket phải tiếp nhận hoặc xử lý.";

type FormState = {
  artistDisplayName: string;
  shortIntroduction: string;
  dateOfBirth: string;
  portfolioUrls: string;
  primaryArtDiscipline: string;
  practiceDescription: string;
  contentIntent: string;
  proposedReceivingAccountId: string;
};

const empty: FormState = {
  artistDisplayName: "",
  shortIntroduction: "",
  dateOfBirth: "",
  portfolioUrls: "",
  primaryArtDiscipline: "",
  practiceDescription: "",
  contentIntent: "general_audience_only",
  proposedReceivingAccountId: "",
};

type Application = {
  id: string;
  state: string;
  version: number;
  cooldownUntil?: string | null;
  revision?: Omit<Partial<FormState>, "portfolioUrls"> & {
    portfolioUrls?: string | string[] | null;
  };
};

type ReceivingAccount = {
  referenceId: string;
  bankBin: string;
  bankName: string;
  maskedSuffix: string;
  proofState: string;
};

type DepositStatus = {
  proofState: string;
  refundState: string | null;
  refundNotBefore: string | null;
  refundDue: string | null;
  challengeId: string | null;
  amountVnd: number | null;
  expiresAt: string | null;
  operatingAccount: {
    bankBin: string;
    bankName: string;
    accountNumber: string;
    accountHolderLabel: string;
  } | null;
};

export default function CreatorApplyPage() {
  const [application, setApplication] = useState<Application | null>(null);
  const [form, setForm] = useState(empty);
  const [dobAcknowledged, setDobAcknowledged] = useState(false);
  const [accepted, setAccepted] = useState({
    truthfulInformationAccepted: false,
    portfolioRightsAccepted: false,
    creatorTermsAccepted: false,
    privacyAccepted: false,
  });
  const [message, setMessage] = useState("");
  const [account, setAccount] = useState<ReceivingAccount | null>(null);
  const [accountDraft, setAccountDraft] = useState({
    bankBin: "970436",
    accountNumber: "",
    accountHolderLabel: "",
  });
  const [deposit, setDeposit] = useState<DepositStatus | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/creator-application", { cache: "no-store" }),
      fetch("/api/v1/creator-application/receiving-account", { cache: "no-store" }),
    ])
      .then(async ([applicationResponse, accountResponse]) => {
        const applicationValue = applicationResponse.ok ? await applicationResponse.json() : null;
        const accountValue = accountResponse.ok ? await accountResponse.json() : null;
        const item = applicationValue?.application as Application | null;
        const receivingAccount = accountValue?.account as ReceivingAccount | null;
        setApplication(item);
        setAccount(receivingAccount);
        const revision = item?.revision;
        setForm((current) => ({
          ...current,
          ...(revision ?? {}),
          proposedReceivingAccountId:
            receivingAccount?.referenceId ??
            revision?.proposedReceivingAccountId ??
            current.proposedReceivingAccountId,
          portfolioUrls: Array.isArray(revision?.portfolioUrls)
            ? revision.portfolioUrls.join("\n")
            : (revision?.portfolioUrls ?? current.portfolioUrls),
        }));
        if (item?.id) {
          const statusResponse = await fetch(
            `/api/v1/creator-application/deposit?applicationId=${encodeURIComponent(item.id)}`,
            { cache: "no-store" },
          );
          if (statusResponse.ok) {
            const statusValue = await statusResponse.json();
            setDeposit(statusValue.deposit as DepositStatus);
          }
        }
      })
      .catch(() => setMessage("Không thể tải hồ sơ lúc này."));
  }, []);

  const proposeReceivingAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("");
    try {
      const response = await fetch("/api/v1/creator-application/receiving-account", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(accountDraft),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(value?.code ?? "REQUEST_FAILED");
      const created = value.account as ReceivingAccount;
      setAccount(created);
      setForm((current) => ({ ...current, proposedReceivingAccountId: created.referenceId }));
      setAccountDraft((current) => ({ ...current, accountNumber: "" }));
      setMessage("Đã lưu tài khoản nhận tiền dưới dạng mã hóa.");
    } catch {
      setMessage("Không thể lưu tài khoản. Hãy đăng nhập lại để xác thực gần đây rồi thử lại.");
    }
  };

  const reportDepositSent = async () => {
    if (!deposit?.challengeId) return;
    setMessage("");
    try {
      const response = await fetch("/api/v1/creator-application/deposit/report", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          challengeId: deposit.challengeId,
          reportedSentAt: new Date().toISOString(),
        }),
      });
      if (!response.ok) throw new Error("REQUEST_FAILED");
      setDeposit({ ...deposit, proofState: "sent_reported" });
      setMessage("Đã ghi nhận báo cáo của bạn. Báo cáo này chưa phải xác minh giao dịch.");
    } catch {
      setMessage("Không thể ghi nhận báo cáo chuyển khoản lúc này.");
    }
  };

  const call = async (path: string, payload: unknown, requireVersion = true) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...(requireVersion && application
          ? { "if-match": String(application.version) }
          : {}),
      },
      body: JSON.stringify(payload),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.code ?? "REQUEST_FAILED");
    setApplication(value.application);
    return value.application as Application;
  };

  const currentSnapshot = () => ({
    ...form,
    portfolioUrls: form.portfolioUrls
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  });

  const save = async () => {
    setMessage("");
    try {
      await call("/api/v1/creator-application", currentSnapshot());
      setMessage("Đã lưu bản nháp riêng tư.");
    } catch {
      setMessage("Không thể lưu. Kiểm tra lại thông tin và đăng nhập.");
    }
  };

  const submit = async () => {
    setMessage("");
    try {
      await call("/api/v1/creator-application/submit", {
        ...currentSnapshot(),
        dateOfBirthAcknowledged: dobAcknowledged,
        ...accepted,
      });
      setMessage("Đã gửi hồ sơ.");
    } catch {
      setMessage("Chưa thể gửi hồ sơ. Vui lòng hoàn tất các xác nhận và thông tin bắt buộc.");
    }
  };

  const withdraw = async () => {
    try {
      await call("/api/v1/creator-application/withdraw", {});
      setMessage("Đã rút hồ sơ.");
    } catch {
      setMessage("Không thể rút hồ sơ lúc này.");
    }
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-action") === "submit") {
      void submit();
    } else {
      void save();
    }
  };

  return (
    <main className="page-shell stack">
      <h1>Đăng ký trở thành nhà sáng tạo</h1>
      <p>
        Pawket chưa xác minh giấy tờ định danh của chính phủ. Hồ sơ này chỉ hiển thị riêng cho
        bạn và nhóm xét duyệt được ủy quyền.
      </p>
      {application?.state === "rejected" && application.cooldownUntil ? (
        <p>
          Bạn có thể nộp lại từ{" "}
          {new Date(application.cooldownUntil).toLocaleDateString("vi-VN", {
            timeZone: "Asia/Ho_Chi_Minh",
          })}
          .
        </p>
      ) : null}
      <section className="panel stack">
        <p className="eyebrow">Tài khoản nhận tiền đề xuất</p>
        <h2>Chứng minh quyền kiểm soát mà không tải giấy tờ tùy thân</h2>
        <p>
          Sau khi hồ sơ được gửi, owner có thể phát hành một thử thách chuyển khoản VND có số
          tiền chính xác và mã tham chiếu dùng một lần trong 72 giờ. Bạn chỉ được chuyển từ tài
          khoản đã khai bên dưới. Báo cáo “đã chuyển” của bạn không tự xác minh giao dịch.
        </p>
        <p>
          Khoản tiền này không phải phí, doanh thu, ví hay tiền của người mua. Khi owner đối soát
          đúng, Pawket ghi nhận nghĩa vụ hoàn lại đúng số tiền về chính phiên bản tài khoản này
          trong khoảng ngày làm việc thứ 5 đến thứ 7.
        </p>
        {account ? (
          <p className="status-message">
            Đang dùng: {account.bankName} ({account.bankBin}) · {account.maskedSuffix} · trạng
            thái {account.proofState}.
          </p>
        ) : null}
        <form className="stack" onSubmit={proposeReceivingAccount}>
          <label>
            Ngân hàng hỗ trợ
            <select
              value={accountDraft.bankBin}
              disabled={application?.state === "submitted"}
              onChange={(event) =>
                setAccountDraft({ ...accountDraft, bankBin: event.target.value })
              }
            >
              <option value="970436">Vietcombank</option>
              <option value="970415">VietinBank</option>
            </select>
          </label>
          <label>
            Số tài khoản VND
            <input
              required
              inputMode="numeric"
              autoComplete="off"
              value={accountDraft.accountNumber}
              disabled={application?.state === "submitted"}
              onChange={(event) =>
                setAccountDraft({ ...accountDraft, accountNumber: event.target.value })
              }
            />
          </label>
          <label>
            Tên chủ tài khoản
            <input
              required
              autoComplete="off"
              value={accountDraft.accountHolderLabel}
              disabled={application?.state === "submitted"}
              onChange={(event) =>
                setAccountDraft({ ...accountDraft, accountHolderLabel: event.target.value })
              }
            />
          </label>
          <button type="submit" disabled={application?.state === "submitted"}>
            {account ? "Tạo phiên bản tài khoản mới" : "Lưu tài khoản mã hóa"}
          </button>
        </form>
      </section>

      {application?.state === "submitted" ? (
        <section className="panel stack">
          <p className="eyebrow">Xác minh chuyển khoản</p>
          <h2>Trạng thái khoản nộp và hoàn trả</h2>
          {deposit?.challengeId && deposit.operatingAccount ? (
            <>
              <p>
                Chuyển đúng {deposit.amountVnd?.toLocaleString("vi-VN")} VND đến{" "}
                {deposit.operatingAccount.bankName} · {deposit.operatingAccount.accountNumber} ·{" "}
                {deposit.operatingAccount.accountHolderLabel}. Chỉ chuyển khi bạn đã nhận mã tham
                chiếu một lần của thử thách; không tự sửa số tiền hay nội dung.
              </p>
              <p>
                Hạn thử thách:{" "}
                {deposit.expiresAt
                  ? new Date(deposit.expiresAt).toLocaleString("vi-VN", {
                      timeZone: "Asia/Ho_Chi_Minh",
                    })
                  : "chưa có"}
                . Trạng thái đối soát: {deposit.proofState}.
              </p>
              {deposit.proofState === "issued" ? (
                <button type="button" onClick={() => void reportDepositSent()}>
                  Tôi đã chuyển từ tài khoản đã khai
                </button>
              ) : null}
            </>
          ) : (
            <p>Owner chưa phát hành thử thách 72 giờ cho phiên bản hồ sơ này.</p>
          )}
          {deposit?.refundState ? (
            <p className="status-message">
              Hoàn trả: {deposit.refundState}
              {deposit.refundNotBefore && deposit.refundDue
                ? ` · cửa sổ ${deposit.refundNotBefore} đến ${deposit.refundDue}`
                : ""}
              . Nghĩa vụ này không mất đi nếu hồ sơ được rút, từ chối hay tài khoản được thay đổi.
            </p>
          ) : null}
        </section>
      ) : null}

      <form className="panel stack" onSubmit={handleFormSubmit}>
        <p className="eyebrow">Hồ sơ xét duyệt riêng tư</p>
        <h2>Thông tin nhà sáng tạo</h2>
        <label>
          Tên nghệ sĩ
          <input
            required
            value={form.artistDisplayName}
            onChange={(event) => setForm({ ...form, artistDisplayName: event.target.value })}
          />
        </label>
        <label>
          Giới thiệu ngắn
          <textarea
            required
            value={form.shortIntroduction}
            onChange={(event) => setForm({ ...form, shortIntroduction: event.target.value })}
          />
        </label>
        <label>
          Ngày sinh
          <input
            required
            type="date"
            value={form.dateOfBirth}
            onChange={(event) => setForm({ ...form, dateOfBirth: event.target.value })}
          />
        </label>
        <label>
          Liên kết portfolio công khai HTTPS (mỗi dòng một liên kết)
          <textarea
            required
            value={form.portfolioUrls}
            onChange={(event) => setForm({ ...form, portfolioUrls: event.target.value })}
          />
        </label>
        <label>
          Chuyên ngành nghệ thuật
          <input
            required
            value={form.primaryArtDiscipline}
            onChange={(event) => setForm({ ...form, primaryArtDiscipline: event.target.value })}
          />
        </label>
        <label>
          Mô tả thực hành
          <textarea
            required
            value={form.practiceDescription}
            onChange={(event) => setForm({ ...form, practiceDescription: event.target.value })}
          />
        </label>
        <label>
          Nội dung
          <select
            value={form.contentIntent}
            onChange={(event) => setForm({ ...form, contentIntent: event.target.value })}
          >
            <option value="general_audience_only">Phù hợp khán giả chung</option>
            <option value="may_include_age_restricted">Có thể có nội dung giới hạn độ tuổi</option>
          </select>
        </label>
        <p className="status-message">
          {account
            ? `Hồ sơ sẽ tham chiếu ${account.bankName} ${account.maskedSuffix}; Pawket không hiển thị số tài khoản đầy đủ trong hồ sơ.`
            : "Hãy lưu một tài khoản nhận VND ở phần trên trước khi gửi hồ sơ."}
        </p>
        <section className="stack compact">
          <p>{warning}</p>
          <label>
            <input
              type="checkbox"
              checked={dobAcknowledged}
              onChange={(event) => setDobAcknowledged(event.target.checked)}
            />{" "}
            Tôi đã đọc và xác nhận cảnh báo ngày sinh.
          </label>
          <label>
            <input
              type="checkbox"
              checked={accepted.truthfulInformationAccepted}
              onChange={(event) =>
                setAccepted({ ...accepted, truthfulInformationAccepted: event.target.checked })
              }
            />{" "}
            Thông tin tôi cung cấp là trung thực.
          </label>
          <label>
            <input
              type="checkbox"
              checked={accepted.portfolioRightsAccepted}
              onChange={(event) =>
                setAccepted({ ...accepted, portfolioRightsAccepted: event.target.checked })
              }
            />{" "}
            Tôi có quyền chia sẻ các liên kết portfolio.
          </label>
          <label>
            <input
              type="checkbox"
              checked={accepted.creatorTermsAccepted}
              onChange={(event) =>
                setAccepted({ ...accepted, creatorTermsAccepted: event.target.checked })
              }
            />{" "}
            Tôi đồng ý Điều khoản dành cho nhà sáng tạo v1.
          </label>
          <label>
            <input
              type="checkbox"
              checked={accepted.privacyAccepted}
              onChange={(event) =>
                setAccepted({ ...accepted, privacyAccepted: event.target.checked })
              }
            />{" "}
            Tôi đồng ý Chính sách quyền riêng tư v1.
          </label>
        </section>
        <div className="button-row">
          <button type="submit" formNoValidate data-action="save">
            Lưu bản nháp
          </button>
          <button
            type="submit"
            data-action="submit"
            disabled={!application || !account || application.state === "submitted"}
          >
            Gửi hồ sơ
          </button>
          {application &&
          ["draft", "submitted", "under_review", "changes_requested"].includes(
            application.state,
          ) ? (
            <button className="secondary" type="button" onClick={withdraw}>
              Rút hồ sơ
            </button>
          ) : null}
        </div>
      </form>
      <p role="status">{message}</p>
    </main>
  );
}
