import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** Correlation id for the inbound API request that caused this work. */
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with a request-scoped correlation id. Everything the callback starts —
 * including asynchronous fan-out such as scraper HTTP calls — inherits the id, so
 * outbound-request logs can be attributed to the inbound request that caused them.
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** The correlation id in scope, or `undefined` outside any request (CLI, scheduled runs). */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
