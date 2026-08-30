import type { RevisionAttestation } from "@pawket/config";

export type WorkerHealthState = {
  initializedAt: number | null;
  lastPollSucceededAt: number | null;
  lastRefundScanSucceededAt: number | null;
  publicMediaCleanupConfigured: boolean;
  publicMediaCleanupMaximumAgeMs: number | null;
  lastPublicMediaCleanupScanSucceededAt: number | null;
  oldestPublicMediaCleanupCandidateAt: number | null;
  stopping: boolean;
};

export function createWorkerHealthState(): WorkerHealthState {
  return {
    initializedAt: null,
    lastPollSucceededAt: null,
    lastRefundScanSucceededAt: null,
    publicMediaCleanupConfigured: false,
    publicMediaCleanupMaximumAgeMs: null,
    lastPublicMediaCleanupScanSucceededAt: null,
    oldestPublicMediaCleanupCandidateAt: null,
    stopping: false,
  };
}

export type WorkerReadinessResult = RevisionAttestation & {
  status: "ready" | "not_ready";
  initialized: boolean;
  poll: "up" | "down";
  refundScan: "up" | "down";
  publicMediaCleanupScan: "up" | "down" | "not_configured";
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
  const ready =
    initialized &&
    poll === "up" &&
    refundScan === "up" &&
    publicMediaCleanupScan !== "down" &&
    input.revision.revisionMatch;

  return {
    status: ready ? "ready" : "not_ready",
    initialized,
    poll,
    refundScan,
    publicMediaCleanupScan,
    ...input.revision,
  };
}
