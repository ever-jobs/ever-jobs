# Plan: 5054 — source-ats-gusto-hosted

| Field | Value |
| --- | --- |
| Spec ID | 5054 |
| Slug | source-ats-gusto-hosted |
| Status | implemented |

## Phases

### Phase 1 — Registration + scaffold

- `Site.GUSTO_HOSTED = 'gusto_hosted'` in
  `packages/models/src/enums/site.enum.ts` (distinct from `Site.GUSTO`).
- New package `packages/plugins/source-ats-gusto-hosted/` (package.json,
  tsconfig.json,
  `src/{index,gusto-hosted.module,gusto-hosted.service,gusto-hosted.constants,gusto-hosted.types}.ts`).
- Register in `packages/plugins/index.ts` (`ALL_SOURCE_MODULES`),
  `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.

### Phase 2 — Constants and types

- `gusto-hosted.constants.ts`: `GUSTO_HOSTED_ORIGIN`, `gustoHostedBoardUrl(slug)`
  / `gustoHostedPostingUrl(postingSlug)` builders, results/detail/concurrency/
  timeout caps, `GUSTO_HOSTED_POSTING_LINK_RE`, `GUSTO_HOSTED_BOARD_READY_SELECTOR`,
  `GUSTO_HOSTED_UUID_SUFFIX_RE`, `GUSTO_HOSTED_REMOTE_REGEX`.
- `gusto-hosted.types.ts`: `GustoHostedListItem` (board row),
  `GustoHostedDetailData` (merged detail fields).

### Phase 3 — Service (scrape flow)

- `scrape()`: resolve slug → `fetchBoardHtml` (BrowserPool stealth) →
  `parseBoard` → slice to `resultsWanted` → `fetchDetails` (bounded fan-out) →
  map to `JobPostDto[]`; empty/failed → `[]`.
- `fetchBoardHtml` / `fetchPostingHtml`: protected seams over a shared
  `fetchRenderedHtml` (BrowserPool `getPage({ proxy, stealth: true })`, `goto`
  domcontentloaded, `waitForSelector` best-effort, `page.content()`, close in
  `finally`).
- `parseBoard(html)`: Cheerio — collect `/postings/{slug}` anchors, clean the
  slug, de-dupe, anchor text as title fallback.
- `fetchDetails(items)`: `Promise.allSettled` batches, one detail fetch per role,
  `parseJobPostingLd(html)[0]` → `GustoHostedDetailData`.
- `toJobPost(item, companyFallback, detail, format)`: merge board + detail →
  `JobPostDto`.

### Phase 4 — Field enrichment

- `buildLocation()`: detail structured location first (JSON-LD), bare `Remote`
  marker when remote-only, else null.
- `isRemote`: JSON-LD `TELECOMMUTE`, then title text heuristic.
- compensation: `jobPostingLdToCompensation(baseSalary)` (Spec 5022 helper).
- company name: detail `hiringOrganization`, de-slugified tenant (minus UUID)
  fallback.
- `jobType`: `getJobTypeFromString(employmentType)` after mapping `_` → space
  (schema.org emits `FULL_TIME`, which the helper otherwise misses).

### Phase 5 — Tests

- Protected-seam unit tests (`gusto-hosted.service.spec.ts`) covering every path:
  full mapping, slug consumption, empty/malformed board, detail failure, de-dupe,
  `/applicants/new` stripping, resultsWanted, remote-from-title, company
  precedence, no-slug, companyUrl resolution, description formatting.

### Phase 6 — Docs

- Update `docs/index.md` (specs table), `docs/log.md` (newest at top),
  `docs/ATS_INTEGRATIONS.md` (Gusto Hosted entry + Cloudflare note),
  `docs/questions.md` (live-capture ambiguity).

## Risks

- **Cloudflare challenge may not clear from a datacenter IP.** Mitigated: this is
  the accepted `source-company-desktopmetal` pattern (BrowserPool stealth +
  proxy); on failure the scrape returns `[]` and NEVER falls back to another
  board — the whole point of the fix.
- **Board/posting HTML shape unverified live.** Mitigated: detail parsing rests
  on the stable schema.org `JobPosting` JSON-LD contract (Spec 5022); board
  enumeration on the stable `/postings/{slug}` link shape. Logged in
  `questions.md`; a live capture should confirm selectors.
- **Detail JSON-LD absent on some postings.** Mitigated: role still emitted from
  board fields; detail-only fields null.
- **Slug/UUID edge cases.** Mitigated: `GUSTO_HOSTED_UUID_SUFFIX_RE` strips the
  trailing UUID for display only; the raw slug is always preserved in the URL.
