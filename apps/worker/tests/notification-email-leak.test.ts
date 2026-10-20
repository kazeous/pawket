import { describe, expect, test, vi } from "vitest";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_KINDS, renderNotice, subjectForCategory } from "@pawket/notifications";
import { createSecurityEmailSender, type SmtpMail } from "../src/security-email.js";

// Mirrors packages/notifications/tests/copy-leak.test.ts for the rendered email (HTML and text).
const MARKERS = ["MARKER-MESSAGE-BODY", "MARKER-FILE.png", "9704229999999999", "MARKER-REPORTER", "MARKER-OWNER-REASON", "MARKER-DISPLAY-NAME"] as const;
const appBase = "https://pawket.example.invalid";
const orderId = "0f8fad5b-d9cb-469f-a165-70867728950e";

function sender() {
  const sendMail = vi.fn<(mail: SmtpMail) => Promise<unknown>>().mockResolvedValue({});
  const s = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: appBase,
    smtp: { host: "smtp.invalid", port: 587, tlsMode: "starttls", username: "synthetic", password: "synthetic", fromEmail: "mail@example.invalid", fromName: "Pawket" },
    createTransport: () => ({ sendMail }) });
  return { s, sendMail };
}
const message = (templateData: Record<string, string>) => ({ handoffId: "synthetic", purpose: "notification" as const, destination: "user@example.invalid", secret: null, templateData });

describe("notification email never carries private content", () => {
  test("renders every kind and variant without any marker", async () => {
    const { s, sendMail } = sender();
    for (const kind of NOTIFICATION_KINDS) for (const variant of [null, "created", "dispute"]) {
      await s.send(message({ kind, variant: variant ?? "", category: "orders", linkPath: `/commissions/${orderId}` }));
      const mail = sendMail.mock.calls.at(-1)![0];
      for (const body of [mail.subject, mail.text, mail.html]) for (const marker of MARKERS) expect(body).not.toContain(marker);
      expect(mail.text).toContain(renderNotice(kind, variant).title);
    }
    for (const category of NOTIFICATION_CATEGORIES.filter((c) => c !== "account")) {
      await s.send(message({ kind: "order_requested", variant: "", category, linkPath: "/creator" }));
      expect(sendMail.mock.calls.at(-1)![0].subject).toBe(subjectForCategory(category));
    }
  });

  test("unexpected template keys or marker values are refused before SMTP", async () => {
    const { s, sendMail } = sender();
    const base = { kind: "order_messages", variant: "", category: "messages", linkPath: `/commissions/${orderId}` };
    for (const marker of MARKERS) {
      for (const key of ["body", "fileName", "account", "reporter", "reason", "displayName"]) {
        await expect(s.send(message({ ...base, [key]: marker }))).rejects.toThrow("Invalid security email message");
      }
      await expect(s.send(message({ ...base, variant: marker }))).rejects.toThrow("Invalid security email message");
      await expect(s.send(message({ ...base, kind: marker }))).rejects.toThrow("Invalid security email message");
      await expect(s.send(message({ ...base, category: marker }))).rejects.toThrow("Invalid security email message");
      await expect(s.send(message({ ...base, linkPath: `/commissions/${marker}` }))).rejects.toThrow("Invalid security email message");
    }
    expect(sendMail).not.toHaveBeenCalled();
  });
});
