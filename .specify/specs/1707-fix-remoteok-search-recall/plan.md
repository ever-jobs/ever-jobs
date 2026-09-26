# Plan: 1707 — RemoteOK search recall, text repair, hoursOld and direct-URL semantics

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1707       |
| Spec         | spec.md    |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

Plugin-local only; no shared package, registration or DTO changes.

1. **Pure helpers** in a new `remoteok.text.ts` (no Nest, no I/O, no clock): `repairMojibake`,
   `collapseWhitespace`, `cleanTitle`, `foldText`, `tokenizeSearchTerm`, `pickTagSeed`,
   `hasToken` (cached whole-word regex per token), `buildMatchFields` / `matchTier`,
   `legacyPhraseMatch`, `tidyLocation`, `normalizeUrl` / `isBoardHost` / `isBoardIndexUrl` /
   `resolveJobUrl` / `resolveApplyUrls`, `plausibleCompensation` / `legacyCompensation`,
   `isJobEntry` / `parseFeedPayload`, and `parseLegacyMode`.
2. **Service** (`remoteok.service.ts`):
   - read the legacy mode, clamp `resultsWanted`, floor `offset`, snapshot `Date.now()`;
   - build the client with every pass-through input, both timeout spellings, the crawl-delay floor
     and a redirect pin to the board hosts; headers = the constants plus a caller User-Agent;
   - feed plan (tag → global) with the §7.2 error handling;
   - prepare each row once (repair, entity decode, whitespace, title separators), filter by
     `hoursOld`, rank by tier (or the legacy phrase filter), slice `offset`/`limit`;
   - map with the new URL, logo, location, salary and posting-time rules; the plain-text
     description is computed at most once per row and reused for `PLAIN` output.
3. **Constants**: base URL, board hosts, crawl delay and default spacing, limits, token cap,
   stopword / generic-token sets, remote aliases, salary thresholds, legacy env name.
4. **Types**: fields the API omits become optional, `id: string | number`, `logo`, `original`,
   `verified`, and `RemoteOkMeta`.

## 2. Files

| File | Change |
| ---- | ------ |
| `packages/plugins/source-remoteok/src/remoteok.text.ts` | new, pure helpers |
| `packages/plugins/source-remoteok/src/remoteok.service.ts` | feed plan, repair, ranking, filters, mapping, diagnostics (BOM and LF kept) |
| `packages/plugins/source-remoteok/src/remoteok.constants.ts` | new constants, `REMOTEOK_LEGACY_ENV` |
| `packages/plugins/source-remoteok/src/remoteok.types.ts` | optional fields, `RemoteOkMeta` |
| `packages/plugins/source-remoteok/__tests__/fixtures/remoteok-feed.fixture.ts` | new, synthetic rows |
| `packages/plugins/source-remoteok/__tests__/remoteok.text.spec.ts` | new |
| `packages/plugins/source-remoteok/__tests__/remoteok.service.spec.ts` | new |
| `packages/plugins/source-remoteok/__tests__/remoteok.e2e-spec.ts` | new, live |

`index.ts`, the module, `package.json`, `tsconfig.json` and the four registration files are
unchanged.

## 3. Risks

- **Unknown-tag cost.** A seed that is not a tag costs one extra request (answered with `[meta]`
  only, or an error) before the global feed. Bounded at two requests per scrape.
- **Redirect pin.** A future move of the API off `remoteok.com`/`remoteok.io` would fail loudly as
  a diagnostic rather than follow silently; `EVER_JOBS_HTTP_PIN_REDIRECTS=false` turns pinning off
  process-wide.
- **Noisy tags.** Tag-only evidence ranks last, and tags never drive `jobType`.

## 4. Verification

- `npx jest --testPathPatterns "source-remoteok/__tests__/remoteok" --testPathIgnorePatterns e2e-spec`
- Mutation checks: one repair pass, no tail strip, no look-behind, always falling back, no
  `hoursOld` filter, no tiering — each turns the suites red.
- Live: the e2e suite once, and a before/after run of the old (legacy `true`) and new code with an
  honest User-Agent, four requests spaced ≥ 2.5 s.
- `npx tsc --project tsconfig.typecheck.json --noEmit`.
