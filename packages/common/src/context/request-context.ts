import { AsyncLocalStorage } from 'node:async_hooks';

import type { RawCaptureSink } from '@ever-jobs/models';
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
  /**
   * Spec 5161 — per-source HTTP capture sink. Present only while a scraper
   * runs under `runWithRawCapture` (single-source `include_raw` requests).
   */
  rawCapture?: RawCaptureSink;
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

/**
 * Run `fn` with a raw-capture sink in scope (Spec 5161). The existing store is
 * spread rather than replaced, so `requestId` survives the child context.
 */
export function runWithRawCapture<T>(sink: RawCaptureSink, fn: () => T): T {
  const parent = storage.getStore() ?? { requestId: '' };
  return storage.run({ ...parent, rawCapture: sink }, fn);
}

/** The capture sink in scope, or `undefined` when `include_raw` is off. */
export function getRawCapture(): RawCaptureSink | undefined {
  return storage.getStore()?.rawCapture;
}
