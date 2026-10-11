import { expect, test, vi } from "vitest";
import { createSecurityEmailSender, type SmtpMail } from "../src/security-email.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";
import { metricsRegistry } from "@pawket/observability";

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
    expect(body).toContain(`https://pawket.example.invalid/help/locked#t=${token}`);
    expect(body).toContain("Bạn có thể xem chi tiết và gửi kháng nghị một lần trong 14 ngày.");
    expect(body).not.toContain("explanation");
  }
  expect(mail.html).toContain("Xem thông báo và kháng nghị");
  if (kind === "suspension") expect(mail.text).toContain("20/10/2026");
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
