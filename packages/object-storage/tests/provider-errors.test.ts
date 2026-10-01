import { describe, expect, test } from "vitest";
import { isProviderCreateOnlyConflict, isProviderNotFound } from "../src/index.js";

function providerError(fields: Record<string, unknown>): Error {
  const error = new Error("provider");
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(error, key, { value, enumerable: true, writable: true, configurable: true });
  return error;
}

describe("provider error classification", () => {
  test.each(["NotFound", "NoSuchKey", "NoSuchVersion"])("recognises %s by name", (name) => {
    expect(isProviderNotFound(providerError({ name }))).toBe(true);
  });
  test("recognises a 404 status and a nested cause", () => {
    expect(isProviderNotFound(providerError({ $metadata: { httpStatusCode: 404 } }))).toBe(true);
    expect(isProviderNotFound(providerError({ cause: providerError({ name: "NoSuchKey" }) }))).toBe(true);
  });
  test("refuses proxies, accessors and unrelated errors", () => {
    expect(isProviderNotFound(new Proxy(providerError({ name: "NotFound" }), {}))).toBe(false);
    const accessor = new Error("provider");
    Object.defineProperty(accessor, "name", { get: () => "NotFound", enumerable: true });
    expect(isProviderNotFound(accessor)).toBe(false);
    expect(isProviderNotFound(providerError({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }))).toBe(false);
    expect(isProviderNotFound("NotFound")).toBe(false);
  });
  test("recognises create-only conflicts", () => {
    expect(isProviderCreateOnlyConflict(providerError({ name: "PreconditionFailed" }))).toBe(true);
    expect(isProviderCreateOnlyConflict(providerError({ $metadata: { httpStatusCode: 409 } }))).toBe(true);
    expect(isProviderCreateOnlyConflict(providerError({ $metadata: { httpStatusCode: 500 } }))).toBe(false);
  });
});
