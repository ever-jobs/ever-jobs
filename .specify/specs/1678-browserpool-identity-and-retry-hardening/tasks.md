# Tasks: 1678 — Persistent-context identity, and hardening the Spec 5085 landings

- [x] T1 — `BrowserPool`: key persistent contexts on a `PersistentIdentity` (`headful`, `stealth`, `proxy`) rather than `userDataDir` alone, and give each identity its own profile directory under the configured root. Acceptance: two `getPage()` calls with different proxies launch two contexts, each receiving its own proxy; identical identities reuse one context and resolve to the same directory across restarts.
- [x] T2 — `BrowserPool`: detect a dead context by subscribing to `close` and evicting it, replacing the `pages().length >= 0` tautology; clear the in-flight launch guard in a `.finally()`. Acceptance: a context that emits `close` is relaunched on the next call; a failed launch is retryable rather than cached.
- [x] T3 — `BrowserPool`: register the stealth init script once per context, and dispose the blank page `launchPersistentContext` opens once the caller's first real page exists. Acceptance: three calls against one context register the script once and close the blank page once.
- [x] T4 — `BrowserPool`: `EVER_JOBS_BROWSER_HEADFUL=false` downgrades a headful request to headless with one warning; unset keeps current behaviour. Acceptance: unit tests for both settings, and for an explicit `userDataDir` still taking the persistent path while headful is disabled.
- [x] T5 — `apps/api`: bound and validate the inbound `X-Request-Id` (≤128 chars, `[A-Za-z0-9._:-]`) before adopting it, since it is echoed into a response header and every outbound retry log line. Acceptance: UUID/traceparent/vendor ids honored; overlong, CRLF, space- and semicolon-bearing values replaced with a minted UUID.
- [x] T6 — `HttpClient`: `Retry-After` may only push a retry later — `min(retryMaxDelay, max(backoff, retryAfter ?? 0))`. Acceptance: malformed, negative, past-date and empty values keep the computed backoff; a server asking for less than the backoff does not shorten it; existing honored/clamped cases unchanged.
- [x] T7 — `source-ats-successfactors`: the careersection fallback owns the reported diagnostic, so the step-1 OData routing signal is no longer reported as the outcome. Acceptance: existing suite green; a tenant failing on both surfaces reports the HTML failure.
- [x] T8 — `source-ats-gusto-hosted`: the description fallback skips the company `About <Company>` rich-text block. Acceptance: with the `Description` heading relabelled, the parsed description is the real one and never the company blurb.
- [x] T9 — `apps/api` + `@ever-jobs/models`: add the `circuit_open` `ScrapeReason` and report a breaker short-circuit as that rather than `unknown`. Acceptance: a source rejected with `ERR_SOURCE_CIRCUIT_OPEN` yields `reason: 'circuit_open'` with the site in `detail`.
- [x] T10 — CI: add `npm run test:scripts` and run the whole `scripts/__tests__` directory, not just `docs-lint` — the Spec 5080 reserve-overlaps allocator tests ran in no job. Acceptance: the `docs-lint` job executes `spec-ranges.spec.ts`.
- [x] T12 — `dedup-hybrid`: wire the NFR-1 wall-clock assertion in `dedup-hybrid.service.spec.ts` to `DEDUP_PERF_NFR1_MS`, the budget CI already sets and that `dedup-perf.spec.ts` already reads. It was hardcoded to the local 250 ms default, so the documented CI ceiling never reached it and a contended shared runner failed the gating `Test (Feature Plugins)` job on wall-clock alone (observed: 1 451 ms on `main`). Pre-existing since 2026-04-26, unrelated to Spec 5076–5085. Acceptance: `DEDUP_PERF_NFR1_MS=1` fails the assertion and names the budget in the test title; unset keeps 250 ms.
- [x] T11 — Docs: `docs/index.md` row + corrected footer date (it read `2026-06-28`, ~6 weeks before the change it described), `docs/log.md` entry newest-at-top; `tsc --noEmit` and `lint:docs` clean.

## Deferred

- **Bounding `per_source`.** Confirmed real: the array carries one row per fanned-out source with no
  cap, so a default request (~1650 sources) attaches ~100–200 KB to every fresh response. It is
  response bloat, not the memory driver the review first suspected, and every sensible fix (cap +
  summary, or opt-in) changes an API contract that shipped days ago and that `ever-hust` may already
  read. Left for a decision rather than changed unilaterally.
