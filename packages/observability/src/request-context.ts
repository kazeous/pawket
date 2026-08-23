import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  actorId?: string;
  orderId?: string;
  paymentIntentId?: string;
  outboxEventId?: string;
  jobId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(context: RequestContext, operation: () => T): T {
  return storage.run(context, operation);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
