# Tasks: 1701 — LinkedIn guest board: pagination, stable ids, pay, detail fields and company enrichment

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Parsing and helpers

- [x] T01 — Types and constants.
  - **Files:** `packages/plugins/source-linkedin/src/linkedin.types.ts`, `src/linkedin.constants.ts`
  - **Acceptance:** `LinkedInCard`, `LinkedInSearchPage`, `LinkedInJobDetail`, `LinkedInCompanyDetails`, `ApplicantsInfo`, `LinkedInJobExtras`/`LinkedInJobPost`, `LinkedInScraperInput`, `LinkedInLegacyFlags`; `LINKEDIN_MAX_START` 1000, `LINKEDIN_MAX_PAGES_WITHOUT_NEW` 2, `LINKEDIN_LEGACY_PAGE_STEP` 25, `LINKEDIN_MAX_COMPANY_FETCHES` 25, `WORKPLACE_TYPE_CODES`, `LINKEDIN_BLOCK_STATUS`, `LINKEDIN_BLOCK_URL_RE` (anchored at the first path segment), `LINKEDIN_CURRENCY_PREFIXES` (longest first), both env names. `LINKEDIN_HEADERS` and `JOB_TYPE_CODES` unchanged.

- [x] T02 — Utils: fix the two existing helpers, keep the old behaviour behind an option.
  - **Files:** `src/linkedin.utils.ts`
  - **Acceptance:** `parseJobType` reads only "Employment type" (`{ allCriteria: true }` = old); `isJobRemote` delegates to `detectRemoteSignal(title, location)` (`{ legacy: true }` = old substring test); `jobTypeCode`, `parseJobLevel`, `parseCompanyIndustry` unchanged.

- [x] T03 — Utils: new helpers.
  - **Files:** `src/linkedin.utils.ts`, `__tests__/linkedin.utils.spec.ts`
  - **Acceptance:** `parseCriteria`, `extractLinkedInJobId` / `jobIdFromHref`, `canonicalJobUrl`, `normalizeCompanyUrl` / `companySlugFromUrl`, `licdnMediaUrl`, `externalHttpUrl`, `unwrapLinkedInRedirect`, `parseLinkedInPay` (the §8 table incl. CAD regression, INR, SGD monthly, `+`, `up to`, fixed, `K`/`M`, multi-line, executive pay kept, null cases, never throws), `parseLegacyCardPay`, `parseApplicants`, `detectRemoteSignal`, `linkedInBlockReason` / `linkedInBlockDiagnostics`, `resolveLinkedInLegacy`, `resolveFetchCompanyDetails`. 97/97.

- [x] T04 — Pure parser.
  - **Files:** `src/linkedin.parser.ts`, `__tests__/linkedin.parser.spec.ts`, `__tests__/fixtures/*`
  - **Acceptance:** `parseSearchCards` counts every card; `cardToJobPost` builds `li-<digits>`, canonical job and company URLs, media-only logo, pay, remote stamping and posted time (legacy ids/pay/remote honoured); `parseJobDetail` scopes to the posting, drops similar-jobs cards, has no button text in any format, reads criteria by label, company id, applicants, pay block, apply URL, top-card logo (never a face-pile photo) and the JSON-LD instant; `parseCompanyPage` takes the `Organization` node, unwraps the redirect website, ignores a linkedin.com `sameAs`, falls back to the About-us list. 36/36.

## Phase 2 — Service

- [x] T05 — Pagination, pacing and diagnostics.
  - **Files:** `src/linkedin.service.ts`, `__tests__/linkedin.service.spec.ts`
  - **Acceptance:** starts 0/10/20 (not 25); offset honoured; empty page, the 1000 cap, two duplicate pages and `resultsWanted` stop the loop; one pacer, 3–7 s between any two requests; 999 → `blocked` with 0 jobs; an authwall 200 → `blocked`; a 429 on page 2 → page 1 kept + `fetch_error`; an empty board has no diagnostics; `EVER_JOBS_LINKEDIN_LEGACY=pagination` restores the 25 step.

- [x] T06 — Detail merge.
  - **Files:** `src/linkedin.service.ts`
  - **Acceptance:** canonical detail URLs; override for pay, job type, level, function, industry; fill-only for logo, company id, applicants, apply URL; a failed page keeps the card-only job and only the first failure reports; a block (999 or authwall) stops further detail fetches; a search diagnostic is never replaced; `EVER_JOBS_LINKEDIN_LEGACY=detail` restores the old reads.

- [x] T07 — Company enrichment.
  - **Files:** `src/linkedin.service.ts`
  - **Acceptance:** off by default (0 company requests); on via the input or `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS`; one GET per unique slug; failures cached; a 999 or authwall stops all company GETs without diagnostics; capped at 25; fills only empty fields, size band preferred.

- [x] T08 — Spec 1696 posted time.
  - **Files:** `src/linkedin.parser.ts`, `src/linkedin.service.ts`
  - **Acceptance:** the seven-card table (minute/hour instants; day/week/localised/inconsistent labels keep the attribute as `day`/`date`; no `<time>` gives none); `datePosted` equals the attribute on every card; `EVER_JOBS_POSTED_TIME_DETAIL=false` keeps the old shape; JSON-LD within a day upgrades to `exact`/`timestamp`, 5 days away is rejected, no JSON-LD keeps the estimate, a page without a description still upgrades, a card with no date is filled; one debug counter line per scrape. 44/44 in the service suite.

## Phase 3 — Live and docs

- [x] T09 — Gated live cases.
  - **Files:** `__tests__/linkedin.e2e-spec.ts`
  - **Acceptance:** existing ungated smoke case kept; `RUN_NETWORK_E2E=1` runs: ids/URLs/description/job-type shape, more than 10 unique ids for `resultsWanted: 12`, a sub-day instant for `hoursOld: 24`. Each tolerates a throttled (empty) run.

- [x] T10 — Spec folder.
  - **Files:** `.specify/specs/1701-source-linkedin-guest-parsing/{spec,plan,tasks}.md`

- [x] T11 — Declare the DTO fields (owned by the models lane / integrator).
  - **Files:** `packages/models/src/dtos/job-post.dto.ts`, `packages/models/src/dtos/scraper-input.dto.ts`
  - **Acceptance:** `companySourceId?: string | null`, `applicantsCount?: number | null`, `applicantsCountBound?: 'exact' | 'min' | 'max' | null` after `jobFunction`; `linkedinFetchCompanyDetails?: boolean` (`@IsOptional() @IsBoolean()`, default `false`) after `linkedinFetchDescription`. No plugin change needed.

- [x] T12 — CLI flag `--linkedin-fetch-company-details` (owned by the CLI lane / integrator).
  - **Files:** `apps/cli/src/commands/search.command.ts`

- [x] T13 — `docs/index.md`, `docs/log.md` and changelog rows, including the id change (`li-<slug>-<id>` → `li-<id>`, `EVER_JOBS_LINKEDIN_LEGACY=ids` to revert) (integrator).

- [ ] T14 — `@SourcePlugin` `crawl: { maxConcurrentPerHost: 1, minIntervalMs: 3000 }` once that field exists.

## Notes

- Verification: `npx jest --testPathPatterns "source-linkedin/__tests__/linkedin\.(utils|parser|service)\.spec" --maxWorkers=4` → 177/177; `npx tsc --project tsconfig.typecheck.json --noEmit` → no errors in this plugin.
- The three probe samples (search fragment, job view, company page) were parsed in a local, uncommitted check: 10 cards with numeric ids and canonical URLs, criteria by label, company id `961661`, "first 25" applicants, no button text, and the company page's website, address, size band and logo.

Integration 2026-09-25: `companySourceId`, `applicantsCount`, `applicantsCountBound` on `JobPostDto` and `linkedinFetchCompanyDetails` on `ScraperInputDto` (left unset by default so the env var still decides); `--linkedin-fetch-company-details` in `search.command.ts` and `docs/CLI.md`; `docs/index.md` / `docs/log.md` rows. T14 waits for the crawl manifest.
