import { describe, expect, test } from "vitest";

import * as identityRuntime from "../src/auth/runtime.js";

type DeliveryPolicy = {
  isSecurityEmailDeliveryAvailable(adapter: "disabled" | "local" | "smtp"): boolean;
  createRuntimeCompromisedPasswordChecker(
    appEnv: "local" | "test" | "staging" | "production",
  ): { isCompromised(password: string): Promise<boolean> };
};

const delivery = identityRuntime as unknown as Partial<DeliveryPolicy>;

describe("identity email delivery availability", () => {
  test("opens email-dependent flows for SMTP while disabled remains fail-closed", () => {
    // Catches production SMTP being configured in the worker but rejected by web routes.
    expect(typeof delivery.isSecurityEmailDeliveryAvailable).toBe("function");
    expect(delivery.isSecurityEmailDeliveryAvailable!("smtp")).toBe(true);
    expect(delivery.isSecurityEmailDeliveryAvailable!("local")).toBe(true);
    expect(delivery.isSecurityEmailDeliveryAvailable!("disabled")).toBe(false);
  });

  test("does not mistake SMTP availability for a deployed compromised-password source", async () => {
    // Catches silently accepting leaked passwords after SMTP is enabled in production.
    expect(typeof delivery.createRuntimeCompromisedPasswordChecker).toBe("function");
    const production = delivery.createRuntimeCompromisedPasswordChecker!("production");
    await expect(production.isCompromised("unique candidate password")).rejects.toThrow(
      "Compromised password check is unavailable",
    );

    const local = delivery.createRuntimeCompromisedPasswordChecker!("local");
    await expect(local.isCompromised("unique candidate password")).resolves.toBe(false);
  });
});
