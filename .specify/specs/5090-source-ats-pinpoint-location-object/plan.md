# Plan: 5090 — Fix Pinpoint location / remote parsing

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-09-02   |
| Last updated | 2026-09-02   |

## Phases

1. **Add normalization helpers to `PinpointService`.**
   - `normalizeLocationText(location)` — handles string/object shapes.
   - `deriveIsRemote(attrs, locationText)` — priority order per spec.

2. **Update `scrape()` field mapping.**
   - Replace the string-only `locationStr` with the normalized text and
     optional `state`.
   - Replace inline `isRemote` expression with helper call.

3. **Add unit tests.**
   - Create `packages/plugins/source-ats-pinpoint/__tests__/pinpoint.service.spec.ts`.
   - Mock `@ever-jobs/common` `createHttpClient` like the Greenhouse tests.
   - Cover object `location`, string `location`, `workplace_type` values, and
     fallback remote detection.

4. **Docs and Spec Kit.**
   - Update `docs/index.md` and `docs/log.md` with Spec 5090.

5. **Verification.**
   - Run `npx tsc --noEmit -p packages/plugins/source-ats-pinpoint/tsconfig.json`.
   - Run `npx jest --testPathPatterns source-ats-pinpoint`.

## Packages touched

- `packages/plugins/source-ats-pinpoint`
- `packages/models` (no changes; used as-is)

## Risks

- If Pinpoint removes `workplace_type` or changes `location` object fields,
  the fallback path must still not throw.
