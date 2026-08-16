# Plan: 5077 — Gusto-hosted headful browser + HTML parser fixes

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-08-04                         |
| Last updated | 2026-08-04                         |

## 1. Approach

Update `GustoHostedService` to use the `BrowserPool` `headful` opt-in and repair the board/detail parsing so it works with live rendered Gusto pages.

Keep the changes inside `packages/plugins/source-ats-gusto-hosted` and its tests; the generic `BrowserPool` change is in Spec 5076.

## 2. Phases

### Phase 1 — Browser and board fixes

- Goal: `fetchRenderedHtml` passes `headful: true` to `BrowserPool.getPage`.
- Goal: `parseBoard` extracts title from a heading child of the posting anchor.
- Deliverables: `gusto-hosted.service.ts` updated.
- Exit criteria: existing tests still pass.

### Phase 2 — Detail HTML fallback

- Goal: `parseDetail` returns fields from the rendered HTML when JSON-LD is missing.
- Deliverables: `gusto-hosted.service.ts` HTML fallback, location parsing via `parseLocationList` from `@ever-jobs/common`.
- Exit criteria: fixture detail pages parse with company, title, location, employment type, and description.

### Phase 3 — Fixtures and tests

- Goal: add real-ish board/detail HTML fixtures for `material.inc` and `naturaresources.com`.
- Deliverables: `__tests__/fixtures/*.html`, new test cases in `gusto-hosted.service.spec.ts`.
- Exit criteria: both new tests assert the expected job count and at least one posting's title/company/location/description.

### Phase 4 — Docs

- Goal: update `docs/index.md` and `docs/log.md` with Spec 5077.
- Exit criteria: `docs/index.md` renders the new spec, `docs/log.md` has a new entry.
