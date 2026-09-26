import { AsyncLocalStorage } from 'node:async_hooks';

import type { ScrapeContext } from '../http/crawl/types';

export interface RequestContext {
  /**
   * Correlation id for the inbound API request that caused this work. Absent
   * only when a scrape context is opened outside any inbound request (CLI,
   * scheduled runs) — `getRequestId()` then returns `undefined`, as before.
   */
  requestId?: string;
  /** Per-scrape crawl-policy context (Spec 1690), set by `runWithScrapeContext`. */
  scrape?: ScrapeContext;
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

/**
 * Run `fn` with `patch` merged over the context in scope: fields `patch` leaves
 * out are inherited from the parent (so a nested scope keeps the request id),
 * fields it sets — even to `undefined` — replace the parent's.
 */
export function runWithRequestContext<T>(patch: Partial<RequestContext>, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...patch }, fn);
}

/** The whole context in scope, or `undefined` outside any. Treat it as read-only. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
