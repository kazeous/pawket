import { expect, test, vi } from "vitest";
import { createSecurityEmailSender, type SmtpMail } from "../src/security-email.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";
import { metricsRegistry } from "@pawket/observability";
import { renderNotice } from "@pawket/notifications";

function fixture() {
  const sendMail = vi.fn<(mail: SmtpMail) => Promise<unknown>>().mockResolvedValue({});
  const sender = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: "https://pawket.example.invalid",
    smtp: { host: "smtp.invalid", port: 587, tlsMode: "starttls", username: "synthetic", password: "synthetic", fromEmail: "mail@example.invalid", fromName: "Pawket" },
    createTransport: () => ({ sendMail }) });
  return { sender, sendMail };
}
test.each(["suspension", "removal"])("renders enforcement_notice %s with a fragment link and no explanation text", async (kind) => {
  const f = fixture(); const token = Buffer.alloc(32, 7).toString("base64url");
  await f.sender.send({ handoffId: "synthetic", purpose: "enforcement_notice", destination: "user@example.invalid", secret: token,
    templateData: { kind, endsAt: kind === "suspension" ? "2026-10-20T03:00:00.000Z" : "" } });
  const mail = f.sendMail.mock.calls[0]![0];
  expect(mail.subject).toBe("Thông báo về tài khoản Pawket");
  for (const body of [mail.text, mail.html]) {
    expect(body).toContain(kind === "suspension" ? "Tài khoản Pawket của bạn đã bị tạm khóa." : "Tài khoản Pawket của bạn đã bị đóng.");
    expect(body).toContain(`https://pawket.example.invalid/help/locked#t=${token}`);
    expect(body).toContain("Bạn có thể xem chi tiết và gửi kháng nghị một lần trong 14 ngày.");
    expect(body).toContain("Liên kết này chỉ dành cho bạn và có thời hạn. Nếu liên kết hết hạn, hãy yêu cầu liên kết mới tại Trung tâm trợ giúp.");
    expect(body).not.toContain("explanation");
  }
  expect(mail.html).toContain("Xem thông báo và kháng nghị");
  if (kind === "suspension") for (const body of [mail.text, mail.html]) {
    expect(body).toContain("10:00 20/10/2026 (giờ Việt Nam)");
  }
});
test("refuses malformed enforcement secrets and free-text template data before SMTP", async () => {
  const f = fixture();
  for (const changes of [{ secret: "bad#token" }, { templateData: { kind: "suspension", endsAt: "tomorrow" } },
    { templateData: { kind: "removal", endsAt: "", explanation: "private text" } }, { templateData: { kind: "warning", endsAt: "" } }]) {
    await expect(f.sender.send({ handoffId: "synthetic", purpose: "enforcement_notice", destination: "user@example.invalid",
      secret: Buffer.alloc(32, 7).toString("base64url"), templateData: { kind: "removal", endsAt: "" }, ...changes })).rejects.toThrow("Invalid security email message");
  }
  expect(f.sendMail).not.toHaveBeenCalled();
});
test("worker accepts enforcement_notice handoffs and acknowledges after delivery", async () => {
  const deliver = vi.fn().mockResolvedValue("delivered"); const acknowledge = vi.fn().mockResolvedValue(true);
  const processor = createWorkerJobProcessor({ database: {} as never, logger: { info() {}, error() {} } as never,
    acknowledge, securityEmail: { keyring: {} as never, sender: {} as never, deliver } });
  const id = "11111111-1111-4111-8111-111111111111";
  await processor({ id, name: "system.outbox-event", data: { outboxEventId: id, eventType: "identity.security_email.requested.v1", eventVersion: 1,
    aggregateType: "security_email_handoff", aggregateId: id, payload: { handoffId: id, purpose: "enforcement_notice" }, occurredAt: "2026-10-12T03:00:00.000Z" } } as never);
  expect(deliver).toHaveBeenCalledOnce(); expect(acknowledge).toHaveBeenCalledOnce();
  expect(await metricsRegistry.metrics()).toContain('pawket_security_emails_total{purpose="enforcement_notice",outcome="sent"}');
});

const notificationOrderId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const notificationMessage = (templateData: Record<string, string>) => ({ handoffId: "synthetic", purpose: "notification" as const,
  destination: "user@example.invalid", secret: null, templateData });
test("renders a notification email with the category subject and a same-origin button", async () => {
  const f = fixture();
  await f.sender.send(notificationMessage({ kind: "order_requested", variant: "", category: "orders", linkPath: `/creator/commissions/${notificationOrderId}` }));
  const mail = f.sendMail.mock.calls[0]![0];
  expect(mail.subject).toBe("Cập nhật đơn đặt vẽ trên Pawket");
  for (const body of [mail.text, mail.html]) {
    expect(body).toContain(renderNotice("order_requested", null).title);
    expect(body).toContain(renderNotice("order_requested", null).body);
    expect(body).toContain(`https://pawket.example.invalid/creator/commissions/${notificationOrderId}`);
    expect(body).toContain("Quản lý thông báo");
    expect(body).toContain("https://pawket.example.invalid/settings/notifications");
  }
  expect(mail.html).toContain(renderNotice("order_requested", null).actionLabel);
  expect(mail.html).not.toMatch(/href="https?:\/\/(?!pawket\.example\.invalid)/u);
  await f.sender.send(notificationMessage({ kind: "tip_status", variant: "created", category: "tips", linkPath: "/creator/tips" }));
  expect(f.sendMail.mock.calls[1]![0].subject).toBe("Cập nhật tip Pawket");
});
test("keeps the subjects of the existing purposes", async () => {
  const f = fixture();
  await f.sender.send({ handoffId: "synthetic", purpose: "tip_status", destination: "user@example.invalid", secret: null,
    templateData: { state: "created", returnPath: "/creator/tips" } });
  expect(f.sendMail.mock.calls[0]![0].subject).toBe("Cập nhật tip Pawket");
});
test("refuses a notification with an unknown kind or an absolute link", async () => {
  const f = fixture();
  const good = { kind: "order_requested", variant: "", category: "orders", linkPath: "/creator" };
  for (const changes of [{ kind: "not_a_kind" }, { variant: "Bad-Variant" }, { variant: "x".repeat(41) }, { category: "billing" }, { category: "account" },
    { linkPath: "https://evil.example/creator" }, { linkPath: "//evil.example" }, { linkPath: "/creator?x=1" }, { linkPath: "/settings/security" },
    { extra: "value" }]) {
    await expect(f.sender.send(notificationMessage({ ...good, ...changes }))).rejects.toThrow("Invalid security email message");
  }
  const { variant: omitted, ...withoutVariant } = good; void omitted;
  await expect(f.sender.send(notificationMessage(withoutVariant))).rejects.toThrow("Invalid security email message");
  await expect(f.sender.send({ ...notificationMessage(good), secret: "unexpected" })).rejects.toThrow("Invalid security email message");
  expect(f.sendMail).not.toHaveBeenCalled();
});
test("worker accepts notification handoffs and acknowledges after delivery", async () => {
  const deliver = vi.fn().mockResolvedValue("delivered"); const acknowledge = vi.fn().mockResolvedValue(true);
  const processor = createWorkerJobProcessor({ database: {} as never, logger: { info() {}, error() {} } as never,
    acknowledge, securityEmail: { keyring: {} as never, sender: {} as never, deliver } });
  const id = "22222222-2222-4222-8222-222222222222";
  await processor({ id, name: "system.outbox-event", data: { outboxEventId: id, eventType: "identity.security_email.requested.v1", eventVersion: 1,
    aggregateType: "security_email_handoff", aggregateId: id, payload: { handoffId: id, purpose: "notification" }, occurredAt: "2026-10-12T03:00:00.000Z" } } as never);
  expect(deliver).toHaveBeenCalledOnce(); expect(acknowledge).toHaveBeenCalledOnce();
  expect(await metricsRegistry.metrics()).toContain('pawket_security_emails_total{purpose="notification",outcome="sent"}');
});
