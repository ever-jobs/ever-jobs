# Plan 5161

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5161-raw-http-capture/spec.md` |
| Package | `packages/models`, `packages/common`, `apps/api` |

## Phase 1 — types & context

- `packages/models/src/interfaces/raw-capture.interface.ts`: `RawHttpEntry`,
  `RawCaptureSink`; export from `interfaces/index.ts`.
- `request-context.ts`: optional `rawCapture` on `RequestContext`,
  `runWithRawCapture(sink, fn)` spreading the existing store, `getRawCapture()`.
- `packages/common/src/http/raw-capture.ts`: `createRawCaptureSink`,
  body-budget accounting, UTF-8-boundary truncation, recursive
  sensitive-key redaction, URL redaction shared with `http-client.ts`,
  `drainRawCapture(sink, capMs)`.

## Phase 2 — instrumentation

- `http-client.ts`: per-attempt `RawHttpEntry` inside the retry loop;
  closed-sink skip; non-2xx bodies; `final_url` from the axios response's
  redirect target.
- `browser-pool.ts`: `attachRawCapture(page)` — `request` / `response` /
  `requestfinished` / `requestfailed` listeners, resourceType filter,
  pending body-read tracking, redirect-chain coalescing; `getPage()` calls
  it on every page.
- `source-tesla-playwright`, `source-ats-kula_ai`: one
  `attachRawCapture(page)` call each after `browser.newPage()`.

## Phase 3 — service & controller

- `jobs.service.ts`: `{ captureRaw }` options param; 400 gate before the
  zero-source early return; per-source sinks in the worker loop;
  `scrapeOne` wraps `scraper.scrape` inside the breaker lambda; drain →
  close → snapshot; `rawBySource` return field.
- `jobs.controller.ts`: `include_raw` query param, cache-read skip,
  `raw_by_source` emission.

## Phase 4 — tests, verify, docs

- New specs: `packages/common/__tests__/raw-capture.spec.ts`,
  `packages/common/src/browser/__tests__/browser-pool-capture.spec.ts`,
  additions to `jobs.service.spec.ts` / `jobs.controller.spec.ts`.
- Live-run one REST source and one browser source with `include_raw`.
- `docs/index.md` row + footer, `docs/log.md` prepend.

## Risks

- AsyncLocalStorage gaps inside Playwright's message loop — mitigated by
  capturing the sink at attach time (spec).
- Sink memory on pathological boards — bounded by the two byte budgets.
