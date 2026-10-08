import type { RevisionAttestation } from "@pawket/config";

export type WorkerHealthState = {
  oidcCleanupConfigured?: boolean;
  lastOidcCleanupSucceededAt?: number | null;
  initializedAt: number | null;
  lastPollSucceededAt: number | null;
  lastRefundScanSucceededAt: number | null;
  tipExpiryConfigured: boolean;
  tipExpiryMaximumAgeMs: number | null;
  lastTipExpiryScanSucceededAt: number | null;
  commissionCleanupConfigured: boolean;
  commissionCleanupMaximumAgeMs: number | null;
  lastCommissionCleanupSucceededAt: number | null;
  commissionFulfillmentConfigured: boolean;
  commissionFulfillmentMaximumAgeMs: number | null;
  lastCommissionFulfillmentSucceededAt: number | null;
  commissionResolutionConfigured: boolean;
  commissionResolutionMaximumAgeMs: number | null;
  lastCommissionResolutionSucceededAt: number | null;
  sepayStatus: "disabled" | "not_configured" | "contract_pending" | "configured";
  sepayRecoveryConfigured: boolean;
  sepayRecoveryMaximumAgeMs: number | null;
  lastSePayRecoverySucceededAt: number | null;
  publicMediaCleanupConfigured: boolean;
  publicMediaCleanupMaximumAgeMs: number | null;
  lastPublicMediaCleanupScanSucceededAt: number | null;
  oldestPublicMediaCleanupCandidateAt: number | null;
  commissionFilesConfigured: boolean;
  commissionFilesMaximumAgeMs: number | null;
  lastCommissionFilesMaintenanceSucceededAt: number | null;
  commissionFileScanner: "not_configured" | "down" | "stale" | "up";
  stopping: boolean;
};

export function createWorkerHealthState(): WorkerHealthState {
  return {
    oidcCleanupConfigured: false,
    lastOidcCleanupSucceededAt: null,
    initializedAt: null,
    lastPollSucceededAt: null,
    lastRefundScanSucceededAt: null,
    tipExpiryConfigured: false,
    tipExpiryMaximumAgeMs: null,
    lastTipExpiryScanSucceededAt: null,
    commissionCleanupConfigured: false,
    commissionCleanupMaximumAgeMs: null,
    lastCommissionCleanupSucceededAt: null,
    commissionFulfillmentConfigured: false,
    commissionFulfillmentMaximumAgeMs: null,
    lastCommissionFulfillmentSucceededAt: null,
    commissionResolutionConfigured: false,
    commissionResolutionMaximumAgeMs: null,
    lastCommissionResolutionSucceededAt: null,
    sepayStatus: "disabled",
    sepayRecoveryConfigured: false,
    sepayRecoveryMaximumAgeMs: null,
    lastSePayRecoverySucceededAt: null,
    publicMediaCleanupConfigured: false,
    publicMediaCleanupMaximumAgeMs: null,
    lastPublicMediaCleanupScanSucceededAt: null,
    oldestPublicMediaCleanupCandidateAt: null,
    commissionFilesConfigured: false,
    commissionFilesMaximumAgeMs: null,
    lastCommissionFilesMaintenanceSucceededAt: null,
    commissionFileScanner: "not_configured",
    stopping: false,
  };
}

export type WorkerReadinessResult = RevisionAttestation & {
  oidcCleanupScan: "up" | "down" | "not_configured";
  status: "ready" | "not_ready";
  initialized: boolean;
  poll: "up" | "down";
  refundScan: "up" | "down";
  tipExpiryScan: "up" | "down" | "not_configured";
  commissionCleanupScan: "up" | "down" | "not_configured";
  commissionFulfillmentScan: "up" | "down" | "not_configured";
  commissionResolutionScan: "up" | "down" | "not_configured";
  sepay: WorkerHealthState["sepayStatus"];
  sepayRecoveryScan: "up" | "down" | "not_configured";
  publicMediaCleanupScan: "up" | "down" | "not_configured";
  commissionFilesScan: "up" | "down" | "not_configured";
  commissionFileScanner: WorkerHealthState["commissionFileScanner"];
};

function isFresh(value: number | null, now: number, maximumAgeMs: number): boolean {
  return value !== null && value <= now && now - value <= maximumAgeMs;
}

export function workerReadiness(input: {
  state: WorkerHealthState;
  revision: RevisionAttestation;
  now?: number;
  maximumPollAgeMs?: number;
  maximumRefundScanAgeMs?: number;
  maximumPublicMediaCleanupScanAgeMs?: number;
}): WorkerReadinessResult {
  const now = input.now ?? Date.now();
  const initialized = input.state.initializedAt !== null && !input.state.stopping;
  const poll = isFresh(
    input.state.lastPollSucceededAt,
    now,
    input.maximumPollAgeMs ?? 10_000,
  )
    ? "up"
    : "down";
  const refundScan = isFresh(
    input.state.lastRefundScanSucceededAt,
    now,
    input.maximumRefundScanAgeMs ?? 180_000,
  )
    ? "up"
    : "down";
  const publicMediaCleanupScan = !input.state.publicMediaCleanupConfigured
    ? "not_configured"
    : isFresh(
          input.state.lastPublicMediaCleanupScanSucceededAt,
          now,
          input.maximumPublicMediaCleanupScanAgeMs ??
            input.state.publicMediaCleanupMaximumAgeMs ??
            180_000,
        )
      ? "up"
      : "down";
  const tipExpiryScan = !input.state.tipExpiryConfigured ? "not_configured" : isFresh(input.state.lastTipExpiryScanSucceededAt, now, input.state.tipExpiryMaximumAgeMs ?? 180_000) ? "up" : "down";
  const commissionCleanupScan = !input.state.commissionCleanupConfigured ? "not_configured" : isFresh(input.state.lastCommissionCleanupSucceededAt, now, input.state.commissionCleanupMaximumAgeMs ?? 180_000) ? "up" : "down";
  const commissionFulfillmentScan = !input.state.commissionFulfillmentConfigured ? "not_configured" : isFresh(input.state.lastCommissionFulfillmentSucceededAt, now, input.state.commissionFulfillmentMaximumAgeMs ?? 180_000) ? "up" : "down";
  const commissionResolutionScan = !input.state.commissionResolutionConfigured ? "not_configured" : isFresh(input.state.lastCommissionResolutionSucceededAt, now, input.state.commissionResolutionMaximumAgeMs ?? 180_000) ? "up" : "down";
  const sepayRecoveryScan = !input.state.sepayRecoveryConfigured ? "not_configured" : isFresh(input.state.lastSePayRecoverySucceededAt, now, input.state.sepayRecoveryMaximumAgeMs ?? 180_000) ? "up" : "down";
  const commissionFilesScan = !input.state.commissionFilesConfigured ? "not_configured" : isFresh(input.state.lastCommissionFilesMaintenanceSucceededAt, now, input.state.commissionFilesMaximumAgeMs ?? 300_000) ? "up" : "down";
  const ready =
    initialized &&
    poll === "up" &&
    refundScan === "up" &&
    tipExpiryScan !== "down" &&
    commissionCleanupScan !== "down" &&
    commissionFulfillmentScan !== "down" &&
    commissionResolutionScan !== "down" &&
    sepayRecoveryScan !== "down" &&
    (!input.state.oidcCleanupConfigured || isFresh(input.state.lastOidcCleanupSucceededAt ?? null, now, 180_000)) &&
    publicMediaCleanupScan === "up" &&
    commissionFilesScan !== "down" &&
    input.revision.revisionMatch;

  return {
    oidcCleanupScan: !input.state.oidcCleanupConfigured ? "not_configured" : isFresh(input.state.lastOidcCleanupSucceededAt ?? null, now, 180_000) ? "up" : "down",
    status: ready ? "ready" : "not_ready",
    initialized,
    poll,
    refundScan,
    tipExpiryScan,
    commissionCleanupScan,
    commissionFulfillmentScan,
    commissionResolutionScan,
    sepay: input.state.sepayStatus,
    sepayRecoveryScan,
    publicMediaCleanupScan,
    commissionFilesScan,
    commissionFileScanner: input.state.commissionFileScanner,
    ...input.revision,
  };
}
