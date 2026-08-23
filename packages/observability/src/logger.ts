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

const redactedValue = "[Redacted]";
const sensitiveKeyPattern = /password|secret|token/i;

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shouldRedact(key: string, parentKey: string | undefined): boolean {
  const normalizedKey = key.toLowerCase();
  const normalizedParentKey = parentKey?.toLowerCase();

  return (
    normalizedKey === "authorization" ||
    normalizedKey === "cookie" ||
    normalizedKey === "database_url" ||
    normalizedKey === "valkey_url" ||
    sensitiveKeyPattern.test(key) ||
    (normalizedKey === "body" &&
      (normalizedParentKey === "request" || normalizedParentKey === "req"))
  );
}

function sanitizeLogValue(
  value: unknown,
  key?: string,
  parentKey?: string,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (key !== undefined && shouldRedact(key, parentKey)) {
    return redactedValue;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return seen.get(value);
    }

    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const item of value) {
      sanitized.push(sanitizeLogValue(item, undefined, key, seen));
    }
    return sanitized;
  }

  if (typeof value === "object" && value !== null && isPlainRecord(value)) {
    if (seen.has(value)) {
      return seen.get(value);
    }

    const sanitized: Record<string, unknown> = {};
    seen.set(value, sanitized);
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeLogValue(childValue, childKey, key, seen);
    }
    return sanitized;
  }

  return value;
}

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
        censor: redactedValue,
      },
      mixin() {
        return { ...getRequestContext() };
      },
      mixinMergeStrategy(mergeObject, mixinObject) {
        return { ...mergeObject, ...mixinObject };
      },
      hooks: {
        logMethod(args, method) {
          const [firstArgument, ...remainingArguments] = args;

          if (typeof firstArgument === "object" && firstArgument !== null) {
            method.apply(this, [sanitizeLogValue(firstArgument), ...remainingArguments]);
            return;
          }

          method.apply(this, args);
        },
      },
    },
    options.destination,
  );
}
