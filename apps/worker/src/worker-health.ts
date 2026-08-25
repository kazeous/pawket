import type { RevisionAttestation } from "@pawket/config";

export type WorkerHealthState = {
  initializedAt: number | null;
  lastPollSucceededAt: number | null;
  lastRefundScanSucceededAt: number | null;
  stopping: boolean;
};

export function createWorkerHealthState(): WorkerHealthState {
  return {
    initializedAt: null,
    lastPollSucceededAt: null,
    lastRefundScanSucceededAt: null,
    stopping: false,
  };
}

export type WorkerReadinessResult = RevisionAttestation & {
  status: "ready" | "not_ready";
  initialized: boolean;
  poll: "up" | "down";
  refundScan: "up" | "down";
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
  const ready =
    initialized && poll === "up" && refundScan === "up" && input.revision.revisionMatch;

  return {
    status: ready ? "ready" : "not_ready",
    initialized,
    poll,
    refundScan,
    ...input.revision,
  };
}
