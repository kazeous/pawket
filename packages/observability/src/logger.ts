import type { ServerEnv } from "@pawket/config";
import {
  REDACTED_VALUE,
  sanitizeStructuredLogValue,
} from "@pawket/security/structured-data";
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
  const configuredSecrets = [
    options.env.DATABASE_URL,
    options.env.VALKEY_URL,
    options.env.METRICS_TOKEN,
    ...options.env.BETTER_AUTH_SECRETS,
    ...Object.values(options.env.PII_KEYRING_JSON),
    options.env.PII_LOOKUP_HMAC_KEY,
    options.env.GOOGLE_CLIENT_SECRET,
    options.env.DISCORD_CLIENT_SECRET,
    options.env.BOOTSTRAP_OWNER_EMAIL,
    options.env.OPERATING_BANK_BIN,
    options.env.OPERATING_BANK_ACCOUNT_NUMBER,
    options.env.OPERATING_BANK_ACCOUNT_NAME,
  ].filter((value): value is string => value !== undefined);

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
        censor: REDACTED_VALUE,
      },
      mixin() {
        return { ...getRequestContext() };
      },
      mixinMergeStrategy(mergeObject, mixinObject) {
        return { ...mergeObject, ...mixinObject };
      },
      hooks: {
        logMethod(args, method) {
          const sanitizedArgs = args.map((argument) =>
            sanitizeStructuredLogValue(argument, configuredSecrets),
          ) as unknown as typeof args;
          method.apply(this, sanitizedArgs);
        },
      },
    },
    options.destination,
  );
}
