# Plan: 1678 — Persistent-context identity, and hardening the Spec 5085 landings

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-16   |
| Last updated | 2026-08-16   |

## Approach

Six independent defects found reviewing PR #53 before promotion, all in code that shipped in that
PR. They are grouped into one spec because they share a cause: the new code paths had tests that
mocked every collaborator and asserted only that Playwright/axios was called, so none of the
behaviours below were pinned.

Each fix is local, and each gets a test that fails against the previous implementation.

## Steps

1. **`BrowserPool` launch identity.** Introduce `PersistentIdentity { headful, stealth, proxy }`.
   Key the context cache on `${userDataDir}|${headful}|${stealth}|${proxy}` and derive the profile
   directory as `join(userDataDir, sha1(identity).slice(0,8))`. Chromium locks a profile to one
   process, so distinct identities need distinct directories — this is what makes honouring the
   caller's proxy possible at all.
2. **Liveness by subscription.** Replace `pages().length >= 0` with a `close`-event subscription
   that marks the context in a `WeakSet` and evicts it from the cache. Clear `persistentLaunching`
   in a `.finally()` so a failed launch is retryable.
3. **Once-per-context setup.** Gate `addInitScript` behind a `WeakSet`; hold the auto-created blank
   page in a `WeakMap` and close it only after the caller's first real page exists.
4. **`EVER_JOBS_BROWSER_HEADFUL`.** Downgrade a headful request to headless when set to `false`,
   with one `warn`. Default unchanged.
5. **Correlation id validation.** Bound the inbound `X-Request-Id` to 128 chars of
   `[A-Za-z0-9._:-]`; mint a UUID otherwise.
6. **`Retry-After` as a floor.** `min(retryMaxDelay, max(backoff, retryAfter ?? 0))`, so a
   malformed/negative/past value degrades to the backoff instead of to zero.
7. **Plugin diagnostics accuracy.** SuccessFactors: give the careersection fallback its own
   diagnostics accumulator so the OData routing signal cannot be reported as the outcome.
   Gusto-hosted: exclude the company `About <Company>` block from the description fallback.
   `JobsService`: report a breaker short-circuit as the new `circuit_open` reason.
8. **CI coverage.** `scripts/__tests__` ran only for `docs-lint`; add `test:scripts` and point the
   workflow step at the whole directory so the Spec 5080 allocator tests actually execute.

## Testing

- `packages/common/src/browser/__tests__/browser-pool.spec.ts` — rewritten around a context double
  that models what Playwright actually does: it starts with a blank page open and announces its own
  death through a `close` event. The previous double could not express either, which is why none of
  these defects were catchable.
- `apps/api/src/middleware/__tests__/request-context.middleware.spec.ts` — new.
- `packages/common/__tests__/http-client.spec.ts` — malformed/negative/past `Retry-After`, and the
  never-sooner-than-backoff rule.
- `apps/api/src/jobs/__tests__/jobs.service.spec.ts` — `circuit_open`.
- `packages/plugins/source-ats-gusto-hosted/__tests__/` — description fallback skips the About blurb.

## Rollout

No migration, no new secret, no image change. `EVER_JOBS_BROWSER_HEADFUL` is optional and defaults
to current behaviour. The persistent-profile directory layout changes from `<root>` to
`<root>/<hash>`; existing profiles are abandoned rather than migrated, which is safe because they
are caches and headful has never successfully launched in a deployed environment.
