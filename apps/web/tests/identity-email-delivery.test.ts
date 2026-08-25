import { describe, expect, test, vi } from "vitest";

import * as identityRuntime from "../src/auth/runtime.js";

type DeliveryPolicy = {
  isSecurityEmailDeliveryAvailable(adapter: "disabled" | "local" | "smtp"): boolean;
  createRuntimeCompromisedPasswordChecker(
    appEnv: "local" | "test" | "staging" | "production",
    options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
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

  test("checks production passwords through the padded HIBP range protocol", async () => {
    expect(typeof delivery.createRuntimeCompromisedPasswordChecker).toBe("function");
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(
      new Response(
        "1E4C9B93F3F0682250B6CF8331B7EE68FD8:42\r\n00000000000000000000000000000000000:0\r\n",
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    );
    const production = delivery.createRuntimeCompromisedPasswordChecker!("production", {
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(production.isCompromised("password")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.pwnedpasswords.com/range/5BAA6");
    expect(new Headers(init?.headers).get("add-padding")).toBe("true");
    expect(new Headers(init?.headers).get("user-agent")).toBe("Pawket compromised-password checker");
    expect(init?.cache).toBe("no-store");
    expect(url).not.toContain("1E4C9B93F3F0682250B6CF8331B7EE68FD8");
  });

  test("fails closed on malformed provider data and keeps local checks deterministic", async () => {
    const malformedFetch = vi.fn<typeof fetch>();
    malformedFetch.mockResolvedValue(new Response("not-a-range-response", { status: 200 }));
    const production = delivery.createRuntimeCompromisedPasswordChecker!("production", {
      fetchImpl: malformedFetch as typeof fetch,
    });
    await expect(production.isCompromised("unique candidate password")).rejects.toThrow(
      "Compromised password response malformed",
    );

    const localFetch = vi.fn<typeof fetch>();
    localFetch.mockResolvedValue(new Response());
    const local = delivery.createRuntimeCompromisedPasswordChecker!("local", {
      fetchImpl: localFetch as typeof fetch,
    });
    await expect(local.isCompromised("unique candidate password")).resolves.toBe(false);
    expect(localFetch).not.toHaveBeenCalled();
  });
});
