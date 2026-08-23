import { Redis } from "ioredis";

export function createQueueConnection(valkeyUrl: string): Redis {
  return new Redis(valkeyUrl, {
    connectTimeout: 500,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

export function createWorkerConnection(valkeyUrl: string): Redis {
  return new Redis(valkeyUrl, { maxRetriesPerRequest: null });
}
