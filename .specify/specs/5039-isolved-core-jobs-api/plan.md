# Plan: 5039 — isolved-core-jobs-api

| Field | Value |
| --- | --- |
| Spec ID | 5039 |
| Slug | isolved-core-jobs-api |
| Status | implementing |

## Phases

### Phase 1 — Constants and types

- Add `ISOLVED_CORE_JOBS_PATH`, `ISOLVED_BOARD_PATH`, `ISOLVED_DOMAIN_ID_REGEX`,
  `ISOLVED_DOMAIN_TITLE_REGEX`, `ISOLVED_GET_PARAMS` to `isolved.constants.ts`.
- Add `ISOLVED_WORKPLACE_REMOTE_REGEX` for workplaceType → isRemote mapping.
- Add `ISO3_TO_ISO2` small lookup map for country-code normalisation.
- Define `IsolvedApiJob` interface (mirrors the `/core/jobs` response shape).
- Define `IsolvedBoardMeta` interface (`domainId`, `companyName`).
- Remove sitemap-only types/constants that are no longer needed.

### Phase 2 — Service rewrite (scrape flow)

- `scrape()`: resolve tenant → `fetchBoardMeta()` → `fetchCoreJobs()` →
  slice to `resultsWanted` → fan out `fetchDetailDescriptions()` → join →
  map to `JobPostDto[]`.
- `fetchBoardMeta(client, tenant)`: GET `/jobs/`, extract `domainId` and
  `domainTitle` via regex from the componentData script block.
- `fetchCoreJobs(client, tenant, domainId)`: GET `/core/jobs/{domainId}`,
  parse JSON response, return `IsolvedApiJob[]`.
- `fetchDetailDescriptions(client, tenant, jobs)`: fan out to detail pages
  in bounded `Promise.allSettled` batches, extract JSON-LD `description` +
  `datePosted`. Returns a `Map<string, { description, datePosted }>`.
- `processApiJob(apiJob, detailData, tenant, companyName, format)`:
  merge API fields + detail description → `JobPostDto`.
- Remove sitemap-specific methods (`fetchJobRefs`, `parseSitemap`,
  `lastmodAfter`).

### Phase 3 — Field enrichment

- `buildCompensation(apiJob)`: parse `minSalary`/`maxSalary` (strip commas),
  `payTypeFrame` → `getCompensationInterval`, return `CompensationDto | null`.
- `resolveDepartment(apiJob)`: `classification ?? orgTitle ?? null`.
- `resolveIsRemote(workplaceType, title, location)`: structured first
  (`ISOLVED_WORKPLACE_REMOTE_REGEX`), text heuristic fallback.
- `normaliseCountry(iso3)`: `ISO3_TO_ISO2[iso3] ?? iso3`.

### Phase 4 — Tests

- Replace the E2E spec with mocked-HTTP unit tests covering all new paths.
- HTML fixtures for board metadata, JSON API responses, detail JSON-LD.

### Phase 5 — Docs

- Update `docs/index.md`, `docs/log.md`, `docs/questions.md`.

## Risks

- **Board HTML structure change**: domainId extraction relies on the
  componentData script block. Mitigated: regex is lenient; if domainId is
  not found, graceful degradation to `[]`.
- **List API removed / gated**: the `/core/jobs` endpoint is unauthenticated
  today. If it becomes gated, the plugin degrades to `[]` with a logged
  warning. A sitemap fallback could be re-added later.
- **Large boards**: the list API returns all jobs in one response (no
  pagination observed). If a board has thousands, the response may be large.
  Mitigated: slice to `resultsWanted` before the detail fan-out.
