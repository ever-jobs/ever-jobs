# Tasks: 5085 — Retry logs that name their request, and `Retry-After`

- [x] T1 — `@ever-jobs/common`: add `context/request-context.ts` (`runWithRequestId`, `getRequestId`) backed by `AsyncLocalStorage`; export from the package barrel. Acceptance: id readable from nested async callees, `undefined` outside any context.
- [x] T2 — `HttpClient`: retry warning names the request (`${method} ${url} failed ${status}, retry n/max in Xms`, `[id]` prefix when in scope). Acceptance: unit test asserts the message content, with and without a context.
- [x] T3 — `HttpClient`: honor `Retry-After` (delta-seconds or HTTP-date) on retryable statuses, clamped to `retryMaxDelay`, falling back to the computed backoff when absent or unparseable. Acceptance: unit tests for honored, clamped and fallback delays.
- [x] T4 — `apps/api`: `requestContextMiddleware` registered in `main.ts` (honors an inbound `X-Request-Id`); `LoggingInterceptor` reuses `getRequestId()` rather than minting a second id. Acceptance: `X-Request-Id`, the access log and outbound retry lines carry the same id.
- [x] T5 — Docs: `docs/index.md` row, `docs/log.md` entry (newest at top); `tsc --noEmit` and `lint:docs` clean.
