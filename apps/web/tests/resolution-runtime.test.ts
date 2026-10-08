import { afterEach, expect, test, vi } from "vitest";
import * as config from "@pawket/config";
import * as orders from "@pawket/orders";
import * as payments from "@pawket/payments";
import * as catalog from "@pawket/catalog";
import * as files from "@pawket/commission-files";
import * as resolutions from "@pawket/resolutions";
import * as identity from "@pawket/identity";
import * as trust from "@pawket/trust";
import type { PawketTransaction } from "@pawket/database";
import { getPlatformRuntime } from "../src/platform/runtime.js";
import { syntheticOidcProvider } from "./oidc-test-support.js";

afterEach(() => vi.restoreAllMocks());
test("runtime uses the real resolution holds, intake fence, refund creator lock and evidence ports", async () => {
  const env = config.parseServerEnv({ NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic-i8", DATABASE_URL: "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_test",
    VALKEY_URL: "redis://127.0.0.1:6379/0", METRICS_TOKEN: "synthetic-metrics-token-0000000000", APP_BASE_URL: "https://pawket.example.invalid", AUTH_TRUSTED_ORIGINS: "https://pawket.example.invalid" });
  vi.spyOn(config, "loadServerEnv").mockReturnValue({ ...env, COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "enabled" });
  vi.spyOn(config, "parseOidcEnv").mockReturnValue({ ...syntheticOidcProvider, clientSecret: "synthetic-client-secret-0000000000",
    redirectUri: "https://pawket.example.invalid/api/v1/auth/oidc/callback", accountPortalUrl: "https://idp.example.invalid/if/user/" });
  const hold = vi.spyOn(resolutions, "createResolutionHoldPort"); const fence = vi.spyOn(resolutions, "createCommissionIntakeFencePort");
  const order = vi.spyOn(orders, "createCommissionOrderService"); const packages = vi.spyOn(catalog, "createCommissionPackageService");
  const refund = vi.spyOn(payments, "createCommissionRefundService"); const refundPort = vi.spyOn(payments, "createCommissionRefundPort");
  const attachment = vi.spyOn(files, "createCommissionEvidenceAttachmentPort"); const upload = vi.spyOn(resolutions, "createCommissionEvidenceUploadPort");
  const fileService = vi.spyOn(files, "createCommissionFileService"); const lateClaim = vi.spyOn(resolutions, "createLateClaimService");
  const view = vi.spyOn(resolutions, "createResolutionViewService"); const standing = vi.spyOn(identity, "createCreatorStandingPort");
  const context = vi.spyOn(identity, "createOidcCommandContext"); const kits = vi.spyOn(resolutions, "createResolutionCommandKit");
  const owner = vi.spyOn(resolutions, "createOwnerResolutionService"); const cases = vi.spyOn(trust, "createTrustCaseService");
  const assurance = vi.spyOn(identity, "createOidcAssurancePort");
  const runtime = getPlatformRuntime();
  expect(hold).toHaveBeenCalledOnce(); expect(order.mock.calls[0]?.[0].holds).toBe(hold.mock.results[0]?.value);
  expect(fence).toHaveBeenCalledOnce(); expect(packages.mock.calls[0]?.[0].intakeFence).toBe(fence.mock.results[0]?.value);
  expect(fence.mock.calls[0]?.[0]).toEqual({ mode: "enabled", refunds: refundPort.mock.results[0]?.value });
  expect(refund).toHaveBeenCalledOnce(); expect(refund.mock.calls[0]?.[0].lockCreator).toBe(orders.lockCommissionCreator);
  expect(refund.mock.calls[0]?.[0]).toMatchObject({ mode: "enabled", calendarVersion: env.VN_BUSINESS_CALENDAR_VERSION, recentAuthMs: env.COMMISSION_RECENT_AUTH_SECONDS * 1000, mfaAuthMs: env.COMMISSION_TOTP_AUTH_SECONDS * 1000 });
  expect(refund.mock.calls[0]?.[0].files).toBe(attachment.mock.results[0]?.value); expect(lateClaim.mock.calls[0]?.[1].files).toBe(attachment.mock.results[0]?.value);
  expect(fileService.mock.calls[0]?.[0].evidenceUploads).toBe(upload.mock.results[0]?.value);
  expect(view.mock.calls[0]?.[0].standing).toBe(standing.mock.results[0]?.value); expect(view.mock.calls[0]?.[0].lateClaims).toBe(lateClaim.mock.results[0]?.value);
  expect(typeof runtime.resolutionHandlers.propose).toBe("function");
  expect(typeof runtime.caseHandlers.evidence).toBe("function");
  expect(owner.mock.calls[0]?.[1].standing).toBe(standing.mock.results[0]?.value);
  expect(owner.mock.calls[0]?.[1].applicationRevision).toBe("synthetic-i8");
  const ownerInput = kits.mock.calls.find(([input]) => input.consumeStepUpProof !== undefined)![0];
  expect(ownerInput.consumeStepUpProof).toBe(context.mock.results[0]?.value.consumeOwnerProof);
  expect(cases.mock.calls[0]?.[0].consumeStepUpProof).toBe(context.mock.results[0]?.value.consumeOwnerProof);
  // The replay authorization hook refuses an active non-owner before asking the command context.
  for (const result of assurance.mock.results) vi.spyOn(result.value, "authorizeOwner").mockResolvedValue(false);
  const commandAuthorize = vi.spyOn(context.mock.results[0]!.value, "authorize");
  const tx = { transaction: (run: (tx: unknown) => unknown) => run(tx) } as unknown as PawketTransaction;
  await expect(ownerInput.authorizeCommand!(tx, { userId: "synthetic-non-owner", sessionId: "synthetic-active-session" })).rejects.toMatchObject({ code: "not_authorized" });
  expect(commandAuthorize).not.toHaveBeenCalled();
});
