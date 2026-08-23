import type { ServerEnv } from "@pawket/config";
import pino, { type DestinationStream, type Logger } from "pino";

import { getRequestContext } from "./request-context.js";

const redactedPaths = [
  "authorization",
  "cookie",
  "DATABASE_URL",
  "VALKEY_URL",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.authorization",
  "request.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "config.DATABASE_URL",
  "config.VALKEY_URL",
  "*.password",
  "*.secret",
  "*.token",
];

export function createLogger(options: {
  service: "web" | "worker" | "migrate";
  env: ServerEnv;
  destination?: DestinationStream;
}): Logger {
  return pino(
    {
      level: options.env.LOG_LEVEL,
      base: {
        service: options.service,
        environment: options.env.APP_ENV,
        revision: options.env.APP_REVISION,
      },
      redact: {
        paths: redactedPaths,
        censor: "[Redacted]",
      },
      mixin() {
        return getRequestContext() ?? {};
      },
    },
    options.destination,
  );
}
