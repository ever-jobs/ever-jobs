# Spec: 5085 — Retry logs that name their request, and `Retry-After`

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 5085                                       |
| Slug           | http-retry-attribution-and-retry-after     |
| Status         | done                                       |
| Owner          | agent                                      |
| Created        | 2026-06-28                                 |
| Last updated   | 2026-06-28                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5082, 5084                                 |

## 1. Problem Statement

`HttpClient` is the shared outbound client: **1,127** plugin packages under `packages/plugins/`
call `createHttpClient`. Its only retry log line is:

```
WARN [HttpClient] Request failed with 429, retrying (1/3) in 1000ms...
```

It names no method, no URL, no host, no plugin. `JobsService` fans scrapers out at concurrency 64
and individual plugins fan their own detail requests out inside that, so hundreds of these lines
interleave from unrelated requests. Nothing in the line distinguishes one failing tenant from
another, and the repeated `(1/3)` is not one request escalating — it is many different requests each
making a first retry. During a real incident (a plugin issuing thousands of duplicate detail requests
until the host rate-limited it, Spec 5084) the log said only that *something* was being throttled.

Two further gaps in the same code path:

- **The API's correlation id never reaches outbound calls.** `LoggingInterceptor` mints a `uuid` per
  request for `X-Request-Id` and the `→`/`←` access lines, but it lives only in that interceptor, so
  there is no way to tell which inbound request caused which outbound retry — the thing you need when
  two searches run concurrently.
- **429 is retried exactly like 500.** `[500, 502, 503, 504, 429]` all take the computed backoff
  (linear 1 s × attempt by default, max 3), and `Retry-After` is never read. A 429 is the server
  stating how long to wait; retrying 1 s later against that instruction prolongs the block.

## 2. Goals

- Every retry log line identifies its own request: method, URL, status, attempt, max, delay.
- An inbound API request id, when one exists, appears on the outbound retry lines it caused.
- `Retry-After` is honored when the server sends it.
- No change in retry counts, backoff policy, or which statuses are retried.

## 3. Non-Goals

- **No repeat suppression / line collapsing** (e.g. `… x137`). With concurrent fan-out, "identical
  consecutive lines" is not a real grouping — adjacency is an accident of interleaving — so collapsing
  would destroy attribution rather than compress it. Volume is a caller concern: a plugin that emits
  hundreds of failures should log a per-scrape summary (Spec 5084 does this for Workday).
- No structured/JSON logging migration; this stays a `Logger.warn` string.
- No change to retry counts, backoff curve, jitter, or the retryable status set.
- No request-context wiring for `apps/cli` or `apps/mcp`. Those have no HTTP request to correlate
  with, so their lines degrade to `${method} ${url}` with no id prefix — the part that matters is
  still there.
- Requests issued through Playwright/`BrowserPool` do not pass through `HttpClient` and are out of
  scope.

## 4. Design

### 4.1 Request context (`@ever-jobs/common`)

An `AsyncLocalStorage`-based store, so the id follows the async call tree without threading a
parameter through every plugin signature:

```ts
export function runWithRequestId<T>(requestId: string, fn: () => T): T;
export function getRequestId(): string | undefined;
```

`getRequestId()` returns `undefined` outside a context (CLI, MCP, tests), which is the degradation
path, not an error.

### 4.2 Attribution in `HttpClient`

```ts
private describeRequest(config: AxiosRequestConfig): string {
  const method = (config.method ?? 'GET').toUpperCase();
  const url = config.url ?? '(no url)';
  const requestId = getRequestId();
  return requestId ? `[${requestId}] ${method} ${url}` : `${method} ${url}`;
}
```

Retry warning becomes:

```
[3a4e54f2-…] GET https://acme.wd108.myworkdayjobs.com/wday/cxs/acme/Careers/job/R-1 failed 429, retry 1/3 in 5000ms
```

### 4.3 `Retry-After`

On a retryable status, `Retry-After` (delta-seconds or HTTP-date) replaces the computed backoff,
clamped to `retryMaxDelay` so a hostile or absurd value cannot stall a scrape:

```ts
const backoff = /* existing exponential|linear computation */;
const delay = Math.min(this.retryMaxDelay, this.retryAfterMs(error.response?.headers) ?? backoff);
```

An unparseable value is ignored (falls back to the backoff); an HTTP-date in the past yields 0.

### 4.4 API wiring

`requestContextMiddleware` runs before everything else in `apps/api`, honoring an inbound
`X-Request-Id` when the caller supplies one so a client can correlate end-to-end, and minting a
`uuid` otherwise. `LoggingInterceptor` then reads `getRequestId() ?? uuidv4()` instead of always
minting, so `X-Request-Id`, the access log and the outbound retry lines carry **one** id.

## 5. Changes

1. `packages/common/src/context/request-context.ts` (new) — `runWithRequestId`, `getRequestId`.
2. `packages/common/src/context/index.ts`, `packages/common/src/index.ts` — barrel exports.
3. `packages/common/src/http/http-client.ts` — `describeRequest`, `retryAfterMs`, `RETRYABLE_STATUSES`,
   attributed warning, clamped `Retry-After` delay.
4. `apps/api/src/middleware/request-context.middleware.ts` (new) + `main.ts` — establish the context.
5. `apps/api/src/interceptors/logging.interceptor.ts` — reuse the context id.

## 6. Test Plan

- Retry warning contains `${METHOD} ${url} failed ${status}, retry n/max`.
- Inside `runWithRequestId('req-abc', …)` the line is prefixed `[req-abc]`.
- `Retry-After: 5` on a 429 → the line reports a 5000 ms delay, not the configured backoff.
- `Retry-After: 600` with `retryMaxDelay: 3000` → clamped to 3000 ms.
- No `Retry-After` → the computed backoff is used unchanged.
- `npx tsc --noEmit` clean; `npm run lint:docs` clean.
