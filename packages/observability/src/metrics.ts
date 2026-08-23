import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();

export const httpRequestsTotal = new Counter({
  name: "pawket_http_requests_total",
  help: "Total HTTP requests handled by Pawket.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "pawket_http_request_duration_seconds",
  help: "Duration of HTTP requests handled by Pawket in seconds.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

export const outboxPendingTotal = new Gauge({
  name: "pawket_outbox_pending_total",
  help: "Current number of pending outbox events.",
  registers: [metricsRegistry],
});

export const outboxOldestAgeSeconds = new Gauge({
  name: "pawket_outbox_oldest_age_seconds",
  help: "Age of the oldest pending outbox event in seconds.",
  registers: [metricsRegistry],
});

export const workerJobsTotal = new Counter({
  name: "pawket_worker_jobs_total",
  help: "Total worker jobs processed by Pawket.",
  labelNames: ["queue", "name", "outcome"],
  registers: [metricsRegistry],
});

export const workerJobDurationSeconds = new Histogram({
  name: "pawket_worker_job_duration_seconds",
  help: "Duration of worker jobs processed by Pawket in seconds.",
  labelNames: ["queue", "name", "outcome"],
  registers: [metricsRegistry],
});
