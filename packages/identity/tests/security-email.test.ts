import { describe, expect, test } from "vitest";

import * as identity from "../src/index.js";

type SecurityEmailMessage = {
  handoffId: string;
  purpose: "email_verification" | "password_reset" | "email_change" | "security_notice";
  destination: string;
  secret: string | null;
  templateData: Readonly<Record<string, string>>;
};

type SecurityEmailExports = {
  DisabledSecurityEmailSender: new () => {
    send(message: SecurityEmailMessage): Promise<void>;
  };
  DeterministicLocalSecurityEmailSink: new () => {
    send(message: SecurityEmailMessage): Promise<void>;
    snapshot(): readonly SecurityEmailMessage[];
  };
};

const email = identity as unknown as Partial<SecurityEmailExports>;
const message: SecurityEmailMessage = {
  handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
  purpose: "password_reset",
  destination: "artist@example.com",
  secret: "one-time-secret",
  templateData: { returnPath: "/reset-password" },
};

describe("security email delivery ports", () => {
  test("the local sink captures deterministic copies only at the delivery boundary", async () => {
    expect(typeof email.DeterministicLocalSecurityEmailSink).toBe("function");
    const sink = new email.DeterministicLocalSecurityEmailSink!();
    await sink.send(message);
    const first = sink.snapshot();
    expect(first).toEqual([message]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    await sink.send(message);
    expect(sink.snapshot()).toHaveLength(2);
  });

  test("the deployed disabled adapter fails closed with no secret in its error", async () => {
    expect(typeof email.DisabledSecurityEmailSender).toBe("function");
    const sender = new email.DisabledSecurityEmailSender!();
    await expect(sender.send(message)).rejects.toThrow("Security email delivery is disabled");
    await expect(sender.send(message)).rejects.not.toThrow(message.secret!);
  });
});
