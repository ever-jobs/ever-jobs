# Plan: 5085 — Retry logs that name their request, and `Retry-After`

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-06-28   |
| Last updated | 2026-06-28   |

## Phases

1. **Request context (`@ever-jobs/common`).** `AsyncLocalStorage`-based `runWithRequestId` /
   `getRequestId`, exported from the package barrel. Leaf addition, no consumer yet.
2. **`HttpClient`.** `describeRequest` (method + URL, `[id]` prefix when in scope) and `retryAfterMs`
   (delta-seconds or HTTP-date), clamped to `retryMaxDelay`; retryable statuses hoisted to a constant.
3. **API wiring.** `requestContextMiddleware` establishes the context per request (honoring an inbound
   `X-Request-Id`); `LoggingInterceptor` reuses that id instead of minting an unrelated second one.
4. **Tests + docs.** `packages/common/__tests__/http-client.spec.ts` with a mocked axios instance;
   `docs/index.md`, `docs/log.md`.

## Packages touched

- `packages/common`
- `apps/api`

## Risks

- **Blast radius.** This is the shared client: 1,127 plugin packages inherit the new behavior. The log
  change is additive, but `Retry-After` is a live behavior change — a tenant sending a long
  `Retry-After` on any retryable status now pauses that request where it previously retried on the
  configured backoff. Bounded by the `retryMaxDelay` clamp, which is the existing ceiling for retry
  waits, so no request can wait longer than it already could.
- **URL in logs.** Scraper URLs are public career-board endpoints and carry no credentials; auth lives
  in headers, which are not logged. No redaction change needed.
- **`AsyncLocalStorage` overhead / context loss.** One store, established in Express middleware so the
  whole downstream async tree inherits it. `getRequestId()` returns `undefined` outside a request (CLI,
  MCP, tests) and the line simply omits the prefix.
- **Log volume.** Lines get longer, and none are collapsed. Deliberate (see spec §3); callers that can
  emit hundreds of failures should add a per-scrape summary instead.
