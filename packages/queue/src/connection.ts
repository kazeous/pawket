import { Redis } from "ioredis";

export const PRODUCER_OPERATION_TIMEOUT_MS = 5_000;

export async function withProducerOperationDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs = PRODUCER_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error) {
    throw error;
  }
  operationPromise.catch(() => undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Producer operation timed out")), timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function createQueueConnection(valkeyUrl: string): Redis {
  return new Redis(valkeyUrl, {
    commandTimeout: PRODUCER_OPERATION_TIMEOUT_MS,
    connectTimeout: 500,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

export function connectQueueProducer(
  connection: Redis,
  timeoutMs = PRODUCER_OPERATION_TIMEOUT_MS,
): Promise<void> {
  return withProducerOperationDeadline(() => connection.connect(), timeoutMs);
}

export function connectQueueWorker(
  connection: Redis,
  timeoutMs = PRODUCER_OPERATION_TIMEOUT_MS,
): Promise<void> {
  return withProducerOperationDeadline(() => connection.connect(), timeoutMs);
}

export function createWorkerConnection(valkeyUrl: string): Redis {
  return new Redis(valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: null });
}
