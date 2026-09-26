# Plan: 1712 — Naukri reports its captcha gate as `blocked` and parses its labels correctly

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1712       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

All parsing moves into pure, total functions in a new `naukri.parsers.ts`, so each rule is
table-tested without HTTP. The service keeps its loop shape (sequential pages, 3–7 s delay,
50-page cap, `seenIds` dedup) and calls the parsers.

1. **Block detection.** `detectNaukriBlock` reads what `classifyScrapeError` cannot: the thrown
   error's `response.status` and `response.data.message`, and a 200 body's `message` or challenge
   HTML. It runs before the shared classifier in the `catch`, and after every successful GET.
2. **Transport.** `createHttpClient({ ...input, requestTimeout: input.requestTimeout ?? 20 })`
   always takes the factory's input branch, so the timeout survives `proxies`.
3. **Row mapping.** One location-label call yields `location`, `locations`, `isRemote` and
   `workFromHomeType`; the description is no longer scanned. The shared `parseLocationList` is
   fed the comma-split city list plus a one-word qualifier.
4. **Old behaviour.** The pre-1712 private methods stay verbatim behind `NAUKRI_PARSER=legacy`,
   and the pre-1712 catch-all classification behind `NAUKRI_DIAGNOSTICS=legacy`.

## 2. Phases

### Phase 1 — Parsers and service

- Deliverables: `naukri.types.ts`, `naukri.parsers.ts`, constants, service rewrite.
- Exit criteria: parser and service suites green.

### Phase 2 — Tests and docs

- Deliverables: synthetic fixtures, three suites, this spec folder.
- Exit criteria: full type-check clean for the plugin; e2e passes against the live board.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-naukri` | new `naukri.types.ts`, `naukri.parsers.ts`; constants and service changes; three suites and two fixtures |
| `packages/models`, `packages/common`, `packages/plugin` | (no change) |

## 4. Dependencies

None added.

## 5. Verification

- `npx jest --testPathPatterns "source-naukri" --maxWorkers=4`
- `npx tsc --project tsconfig.typecheck.json --noEmit`
