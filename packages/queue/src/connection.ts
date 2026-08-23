import { Redis } from "ioredis";

export function createQueueConnection(valkeyUrl: string): Redis {
  return new Redis(valkeyUrl, { maxRetriesPerRequest: null });
}
