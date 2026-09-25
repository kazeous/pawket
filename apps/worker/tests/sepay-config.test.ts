import { expect, test } from "vitest";
import { createEncryptionKeyring } from "@pawket/security";
import { createWorkerSePayConfiguration } from "../src/sepay-config.js";

const keyring = createEncryptionKeyring({ activeKeyId: "synthetic", keys: { synthetic: new Uint8Array(32).fill(18) } });
const env = { TIP_PAYMENTS_MODE: "disabled" as const, SEPAY_ENVIRONMENT: undefined, SEPAY_PROCESSING_BATCH_SIZE: 25, SEPAY_PROCESSING_SCAN_INTERVAL_MS: 30_000,
  SEPAY_PROCESSING_MAX_ATTEMPTS: 5, APP_BASE_URL: "https://pawket.example.invalid", APP_REVISION: "synthetic", SEPAY_OAUTH_REDIRECT_URI: undefined,
  PII_LOOKUP_HMAC_KEY: Buffer.from(new Uint8Array(32).fill(19)).toString("base64") };

test("absent optional SePay configuration does not construct an integration", () => {
  expect(createWorkerSePayConfiguration(env, keyring)).toBeUndefined();
});
test.each(["test", "live"] as const)("%s environment cannot assert provider contract readiness", (environment) => {
  const config = createWorkerSePayConfiguration({ ...env, TIP_PAYMENTS_MODE: "sepay_optional", SEPAY_ENVIRONMENT: environment }, keyring);
  expect(config).toMatchObject({ environment, mode: "sepay_optional", providerContractReady: false, batchSize: 25, scanIntervalMs: 30_000 });
});
