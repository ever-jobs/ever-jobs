import { AsyncLocalStorage } from 'node:async_hooks';
import { AxiosHeaders, type AxiosRequestConfig, type AxiosResponse } from 'axios';

import { abortReasonOf } from './crawl/host-limiter';

/**
 * Scoped response memo for the shared {@link HttpClient} (Spec 1700, T13).
 *
 * A multi-location search calls one source once per location. Most company
 * and ATS plugins fetch their whole board and filter by location locally, so
 * without a memo N locations send the same request N times. Inside a
 * {@link runWithHttpMemo} scope, a request identical to one already answered
 * in that scope (same method, URL, query, body and headers) is served from the
 * memo instead of the network. A source that sends the location to its server
 * builds a different request per location, so it still gets one real request
 * per location, which is what the caller asked for.
 *
 * - Scoped, never global: the jobs service opens one scope per (search,
 *   source) location loop and drops it when the loop ends. Nothing outlives a
 *   search, and two sources never share entries.
 * - Only successful responses are kept. A failed request is forgotten, so the
 *   next location retries it exactly as it did before the memo.
 * - Every caller gets its own deep copy of the body, so a plugin that mutates
 *   `response.data` cannot change what the next location sees.
 * - Streams, form data and other bodies that cannot be copied or keyed are
 *   never memoised.
 * - Crawl policy (Spec 1690): the client consults the memo after it resolved
 *   the request's policy and ran the literal egress check, and before
 *   robots.txt, the host limiter and the network. A hit sends nothing and takes
 *   no rate-limit slot; a miss goes through the whole policy (pacing, retries,
 *   egress guard, redirect pin). The client adds the wire identity and the
 *   refusal regime to the key (`keyExtra`), so a hit only answers a request
 *   that would have been sent the same way.
 */

/** Env var: `off` disables the memo, `get` limits it to GET; default GET and POST. */
export const HTTP_MEMO_ENV = 'EVER_JOBS_SEARCH_LOCATION_MEMO';

/** Default bound on the number of responses one scope keeps. */
export const HTTP_MEMO_MAX_ENTRIES = 500;

/** Bodies larger than this (characters, or `content-length` bytes) are not kept. */
export const HTTP_MEMO_MAX_BODY = 8 * 1024 * 1024;

/** Methods memoised when {@link HTTP_MEMO_ENV} is unset. */
const DEFAULT_MEMO_METHODS: readonly string[] = ['GET', 'POST'];

/** Options of one memo scope. */
export interface HttpMemoOptions {
  /** Upper-case HTTP methods to memoise. Default GET and POST. */
  methods?: readonly string[];
  /** Responses kept per scope; later ones are fetched but not kept. */
  maxEntries?: number;
}

/** Counters of one scope, for the caller's log line. */
export interface HttpMemoStats {
  /** Requests answered from the memo. */
  hits: number;
  /** Requests that went to the network while the scope was open. */
  misses: number;
}

interface MemoSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, unknown>;
  data: unknown;
  responseUrl: string | undefined;
}

interface MemoScope {
  readonly methods: ReadonlySet<string>;
  readonly maxEntries: number;
  readonly entries: Map<string, Promise<MemoSnapshot>>;
  readonly stats: HttpMemoStats;
}

const storage = new AsyncLocalStorage<MemoScope>();

/**
 * The memo methods an operator configured through {@link HTTP_MEMO_ENV}:
 * `off` / `false` / `0` → none (the memo is disabled), `get` → GET only,
 * anything else (unset, `on`, `all`) → GET and POST.
 */
export function httpMemoMethodsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[HTTP_MEMO_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'none') return [];
  if (raw === 'get') return ['GET'];
  return DEFAULT_MEMO_METHODS;
}

/**
 * Run `fn` inside a fresh memo scope. With an empty method list the memo is
 * off and `fn` runs as it would without a scope. Returns `fn`'s result and
 * the scope's counters.
 */
export async function runWithHttpMemo<T>(
  fn: () => Promise<T>,
  options: HttpMemoOptions = {},
): Promise<{ result: T; stats: HttpMemoStats }> {
  const methods = new Set((options.methods ?? DEFAULT_MEMO_METHODS).map((m) => m.toUpperCase()));
  const stats: HttpMemoStats = { hits: 0, misses: 0 };
  if (methods.size === 0) return { result: await fn(), stats };
  const scope: MemoScope = {
    methods,
    maxEntries: Math.max(0, options.maxEntries ?? HTTP_MEMO_MAX_ENTRIES),
    entries: new Map(),
    stats,
  };
  const result = await storage.run(scope, fn);
  scope.entries.clear();
  return { result, stats };
}

/**
 * Called by {@link HttpClient.request}: answer `config` from the memo in
 * scope, or send it with `send` and keep the answer for the rest of the scope.
 * Outside a scope, or for a request that cannot be keyed, this is just
 * `send()`. `onHit` sees every answer served from the memo, so the client can
 * replay what its response interceptors would have done (the cookie jar).
 * `keyExtra` is further key material the caller vouches for (plain data; a
 * value that cannot be keyed makes the request unmemoisable). `signal` is this
 * request's own cancellation (its signal combined with the scrape's): a request
 * parked on an identical one still in flight stops waiting when it fires and
 * rejects with its reason, as a queued request would (Spec 1690 §4.6); the
 * first request keeps the entry.
 */
export async function memoisedRequest<T>(
  config: AxiosRequestConfig,
  defaultHeaders: unknown,
  send: () => Promise<AxiosResponse<T>>,
  onHit?: (response: AxiosResponse<T>) => void,
  keyExtra?: unknown,
  signal?: AbortSignal,
): Promise<AxiosResponse<T>> {
  const scope = storage.getStore();
  const key = scope ? memoKey(scope, config, defaultHeaders, keyExtra) : undefined;
  if (!scope || key === undefined) return send();

  const cached = scope.entries.get(key);
  if (cached) {
    try {
      const snapshot = await untilAborted(cached, signal);
      scope.stats.hits++;
      const restored = restore<T>(snapshot, config);
      onHit?.(restored);
      return restored;
    } catch {
      // Cancelled while waiting: this request is abandoned, not re-sent.
      if (signal?.aborted) throw abortReasonOf(signal);
      // The first request failed after this one looked it up: fall through
      // and send it, as the loop did before the memo.
    }
  }

  scope.stats.misses++;
  if (scope.entries.size >= scope.maxEntries) return send();

  let settle!: { resolve: (s: MemoSnapshot) => void; reject: (e: unknown) => void };
  const pending = new Promise<MemoSnapshot>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A waiting duplicate handles a rejection; nobody else may see it unhandled.
  pending.catch(() => undefined);
  scope.entries.set(key, pending);
  try {
    const response = await send();
    const snapshot = takeSnapshot(response);
    if (snapshot) settle.resolve(snapshot);
    else {
      scope.entries.delete(key);
      settle.reject(new Error('response not memoisable'));
    }
    return response;
  } catch (error) {
    scope.entries.delete(key);
    settle.reject(error);
    throw error;
  }
}

/**
 * `pending`, unless `signal` fires first: then a rejection with its reason.
 * The listener is removed once either settles.
 */
function untilAborted<V>(pending: Promise<V>, signal: AbortSignal | undefined): Promise<V> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortReasonOf(signal));
  return new Promise<V>((resolve, reject) => {
    const onAbort = (): void => reject(abortReasonOf(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The memo key: method, base URL, URL, query, body, both header sets and the
 * caller's extra key material. `undefined` when the method is not memoised or
 * any part cannot be keyed.
 */
function memoKey(
  scope: MemoScope,
  config: AxiosRequestConfig,
  defaultHeaders: unknown,
  keyExtra: unknown,
): string | undefined {
  const method = (config.method ?? 'GET').toUpperCase();
  if (!scope.methods.has(method)) return undefined;
  if (config.responseType === 'stream') return undefined;
  const params = stableValue(config.params);
  const body = stableValue(config.data);
  const headers = headerSignature(config.headers);
  const defaults = headerSignature(defaultHeaders);
  const extra = stableValue(keyExtra);
  if (
    params === undefined ||
    body === undefined ||
    headers === undefined ||
    defaults === undefined ||
    extra === undefined
  ) {
    return undefined;
  }
  return JSON.stringify([
    method,
    config.baseURL ?? '',
    config.url ?? '',
    params,
    body,
    headers,
    defaults,
    config.responseType ?? '',
    extra,
  ]);
}

/**
 * A key-stable string for a query or body: primitives, plain objects (keys
 * sorted), arrays and `URLSearchParams`. Anything else (form data, buffers,
 * streams, class instances) returns `undefined`, so the request is sent
 * without the memo.
 */
function stableValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `p:${String(value)}`;
  if (value instanceof URLSearchParams) return `q:${value.toString()}`;
  const normalised = normalise(value, 0);
  return normalised === undefined ? undefined : `j:${JSON.stringify(normalised)}`;
}

function normalise(value: unknown, depth: number): unknown {
  if (depth > 20) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const n = normalise(item, depth + 1);
      if (n === undefined) return undefined;
      out.push(n);
    }
    return out;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const n = normalise((value as Record<string, unknown>)[k], depth + 1);
      if (n === undefined) return undefined;
      out[k] = n;
    }
    return out;
  }
  return undefined;
}

/** Lower-cased, sorted `name:value` pairs of a plain or axios header object. */
function headerSignature(headers: unknown): string | undefined {
  if (headers === undefined || headers === null) return '';
  const source =
    typeof (headers as { toJSON?: unknown }).toJSON === 'function'
      ? (headers as { toJSON: () => unknown }).toJSON()
      : headers;
  if (typeof source !== 'object' || source === null) return undefined;
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      // axios keeps per-method defaults as nested objects (`common`, `get`, ...).
      const nested = headerSignature(value);
      if (nested === undefined) return undefined;
      pairs.push(`${name.toLowerCase()}{${nested}}`);
      continue;
    }
    if (typeof value === 'function') continue;
    pairs.push(`${name.toLowerCase()}:${String(value)}`);
  }
  return pairs.sort().join('\n');
}

/** A copy of what a later caller needs, or `undefined` when the body cannot be kept. */
function takeSnapshot(response: AxiosResponse): MemoSnapshot | undefined {
  if (response.status < 200 || response.status >= 300) return undefined;
  const length = Number(response.headers?.['content-length']);
  if (Number.isFinite(length) && length > HTTP_MEMO_MAX_BODY) return undefined;
  if (typeof response.data === 'string' && response.data.length > HTTP_MEMO_MAX_BODY) return undefined;
  let data: unknown;
  try {
    data = structuredClone(response.data);
  } catch {
    return undefined;
  }
  const request = response.request as
    | { res?: { responseUrl?: unknown }; responseURL?: unknown }
    | undefined;
  const responseUrl = request?.res?.responseUrl ?? request?.responseURL;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { ...(response.headers as Record<string, unknown>) },
    data,
    responseUrl: typeof responseUrl === 'string' ? responseUrl : undefined,
  };
}

/** Axios header object when axios provides one (a test double may not). */
function restoreHeaders(headers: Record<string, unknown>): AxiosResponse['headers'] {
  const copy = { ...headers };
  return (
    typeof AxiosHeaders === 'function'
      ? new AxiosHeaders(copy as ConstructorParameters<typeof AxiosHeaders>[0])
      : copy
  ) as AxiosResponse['headers'];
}

function restore<T>(snapshot: MemoSnapshot, config: AxiosRequestConfig): AxiosResponse<T> {
  return {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: restoreHeaders(snapshot.headers),
    data: structuredClone(snapshot.data) as T,
    config: config as AxiosResponse<T>['config'],
    request: snapshot.responseUrl
      ? { res: { responseUrl: snapshot.responseUrl }, responseURL: snapshot.responseUrl }
      : undefined,
  } as AxiosResponse<T>;
}
