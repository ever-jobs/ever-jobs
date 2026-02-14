# PRD: Expand Job Source Coverage

**Author:** AI Assistant
**Date:** 2026-02-14
**Status:** Phase 2 Complete
**Epic:** Source Expansion

---

## 1. Overview

Expand ever-jobs from **26 sources** to **39 sources** by adding new job boards and ATS integrations. Phase 1 added 8 public API/RSS sources (Tier 1), Phase 2 added 5 API-key sources (Tier 1.5).

### Current Sources (26)

| Category | Sources |
|----------|---------|
| **Job Boards (9)** | LinkedIn, Indeed, Glassdoor, ZipRecruiter, Google, Bayt, Naukri, BDJobs, Internshala |
| **API/Aggregation (2)** | Exa, Upwork |
| **ATS (7)** | Ashby, Greenhouse, Lever, Workable, SmartRecruiters, Rippling, Workday |
| **Company (7)** | Amazon, Apple, Microsoft, Nvidia, TikTok, Uber, Cursor |

---

## 2. Tier 1 - Public API / RSS (This Phase)

These 8 sources have free, unauthenticated APIs or RSS feeds. They follow existing patterns closely and can be integrated with minimal risk.

### 2.1 RemoteOK

| Field | Value |
|-------|-------|
| **Type** | Job Board (remote-focused) |
| **API** | `GET https://remoteok.com/api` |
| **Auth** | None |
| **Format** | JSON array |
| **Volume** | ~30,000+ remote listings |
| **Package** | `source-remoteok` |
| **Site Enum** | `REMOTEOK` |
| **Notes** | First element is metadata (skip). Fields: `slug`, `company`, `position`, `description`, `location`, `salary_min`, `salary_max`, `url`, `date`. Must attribute back to RemoteOK. |

### 2.2 Remotive

| Field | Value |
|-------|-------|
| **Type** | Job Board (remote-focused) |
| **API** | `GET https://remotive.com/api/remote-jobs` |
| **Auth** | None |
| **Format** | JSON `{ jobs: [...] }` |
| **Volume** | Thousands of remote listings |
| **Package** | `source-remotive` |
| **Site Enum** | `REMOTIVE` |
| **Notes** | Params: `category`, `search`, `limit`. Fields: `id`, `url`, `title`, `company_name`, `category`, `publication_date`, `candidate_required_location`, `salary`, `description`. Jobs delayed 24h. |

### 2.3 Jobicy

| Field | Value |
|-------|-------|
| **Type** | Job Board (remote-focused) |
| **API** | `GET https://jobicy.com/api/v2/remote-jobs` |
| **Auth** | None |
| **Format** | JSON `{ jobs: [...] }` |
| **Volume** | Latest 50 per request |
| **Package** | `source-jobicy` |
| **Site Enum** | `JOBICY` |
| **Notes** | Params: `count` (1-50), `geo` (region filter), `industry`, `tag`. Fields: `id`, `url`, `jobTitle`, `companyName`, `companyLogo`, `jobIndustry`, `jobType`, `jobGeo`, `jobLevel`, `jobExcerpt`, `pubDate`, `annualSalaryMin`, `annualSalaryMax`, `salaryCurrency`. 6h cache. |

### 2.4 Himalayas

| Field | Value |
|-------|-------|
| **Type** | Job Board (remote-focused) |
| **API** | `GET https://himalayas.app/jobs/api` |
| **Auth** | None |
| **Format** | JSON `{ jobs: [...], ... }` |
| **Volume** | Max 20 per request with offset pagination |
| **Package** | `source-himalayas` |
| **Site Enum** | `HIMALAYAS` |
| **Notes** | Params: `limit` (max 20), `offset`. Fields: `id`, `title`, `companyName`, `categories`, `locationRestrictions`, `url`, `description`, `pubDate`, `salary`, `seniority`. Rate limited. |

### 2.5 Arbeitnow

| Field | Value |
|-------|-------|
| **Type** | Job Board (European focus) |
| **API** | `GET https://www.arbeitnow.com/api/job-board-api` |
| **Auth** | None |
| **Format** | JSON `{ data: [...], ... }` |
| **Volume** | Paginated |
| **Package** | `source-arbeitnow` |
| **Site Enum** | `ARBEITNOW` |
| **Notes** | Params: `page`. Fields: `slug`, `company_name`, `title`, `description`, `remote`, `url`, `tags`, `job_types`, `location`, `created_at`. European jobs focus. Cursor pagination via `links.next`. |

### 2.6 We Work Remotely

| Field | Value |
|-------|-------|
| **Type** | Job Board (remote-focused) |
| **API** | RSS `https://weworkremotely.com/remote-jobs.rss` |
| **Auth** | None |
| **Format** | XML/RSS |
| **Volume** | Top listings |
| **Package** | `source-weworkremotely` |
| **Site Enum** | `WEWORKREMOTELY` |
| **Notes** | Category-specific feeds: `/categories/remote-[category]-jobs.rss`. Uses standard RSS items with `title`, `link`, `description`, `pubDate`, `company`. Must attribute. Requires XML parsing (e.g. `fast-xml-parser`). |

### 2.7 Recruitee (ATS)

| Field | Value |
|-------|-------|
| **Type** | ATS |
| **API** | `GET https://{companySlug}.recruitee.com/api/offers` |
| **Auth** | None |
| **Format** | JSON `{ offers: [...] }` |
| **Package** | `source-ats-recruitee` |
| **Site Enum** | `RECRUITEE` |
| **Notes** | Per-company endpoints like existing ATS sources. Fields: `id`, `title`, `slug`, `department`, `location`, `city`, `country`, `state`, `remote`, `description`, `created_at`, `careers_url`, `min_hours`, `max_hours`, `salary_min`, `salary_max`, `salary_currency`. Requires `companySlug`. |

### 2.8 Teamtailor (ATS)

| Field | Value |
|-------|-------|
| **Type** | ATS |
| **API** | `GET https://career.{companyDomain}/connect/jobs` (JSON-API) |
| **Auth** | None (public career site) |
| **Format** | JSON-API |
| **Package** | `source-ats-teamtailor` |
| **Site Enum** | `TEAMTAILOR` |
| **Notes** | Career pages hosted at `career.{company}.com` or custom domains. Job listings available via public career page API. Fields vary by company config. Also supports `/{company}/jobs` pattern on `https://career.teamtailor.com`. Requires `companySlug`. |

---

## 3. Future Tiers (Planned)

### Tier 1.5 - Free API Key Required

| Source | Type | Notes |
|--------|------|-------|
| USAJobs | Job Board | US government jobs, free API key |
| Adzuna | Aggregator | 16+ countries, free API key |
| Reed | Job Board | UK-focused, free API key |
| Jooble | Aggregator | Free developer API |
| CareerJet | Aggregator | Free webmaster API |

### Tier 2 - HTML Scraping (Medium)

| Source | Type | Notes |
|--------|------|-------|
| Wellfound (AngelList) | Job Board | Startups, salary/equity |
| StepStone | Job Board | Major European board |
| Dice | Job Board | Tech-focused, 70K+ jobs |
| SimplyHired | Job Board | Standard HTML |
| JazzHR | ATS | Clean career pages |
| Personio | ATS | European HR platform |
| BambooHR | ATS | Per-company API |
| Comeet | ATS | Clean HTML |
| Pinpoint | ATS | Clean HTML |

### Tier 3 - Heavy Anti-Bot (Hard)

| Source | Type | Notes |
|--------|------|-------|
| Monster | Job Board | DataDome protection |
| CareerBuilder | Job Board | Moderate-heavy protection |
| iCIMS | ATS | Enterprise, JS rendering |
| Oracle Taleo | ATS | Legacy, complex URLs |
| SAP SuccessFactors | ATS | Enterprise |
| Phenom People | ATS | AI-powered, heavy JS |
| Eightfold | ATS | AI-powered, heavy JS |

---

## 4. Technical Design

### Package Structure (per source)

```
packages/source-{name}/
  package.json
  tsconfig.json
  src/
    index.ts
    {name}.module.ts
    {name}.service.ts
    {name}.constants.ts
    {name}.types.ts
```

### Integration Points

1. **`packages/models/src/enums/site.enum.ts`** - Add enum values
2. **`tsconfig.base.json`** - Add path mappings
3. **`apps/api/src/jobs/jobs.module.ts`** - Import modules
4. **`apps/api/src/jobs/jobs.service.ts`** - Wire services into scraperMap
5. **`JobsService.ATS_SITES`** - Add ATS sources (Recruitee, Teamtailor)
6. **`JobsService.COMPANY_SITES`** - No changes for this tier

### Shared Dependencies

All sources use existing shared packages:
- `@ever-jobs/models` - DTOs, enums, interfaces
- `@ever-jobs/common` - HTTP client, utilities

New dependency for RSS parsing:
- `fast-xml-parser` - For WeWorkRemotely RSS feed

### Data Flow

```
API Request
  -> JobsService.searchJobs()
    -> scraperMap.get(site).scrape(input)
      -> Source fetches from external API/RSS
      -> Maps response to JobPostDto[]
    -> Post-process salary
    -> Sort & return
```

---

## 5. Success Criteria

- All 8 new sources return valid `JobPostDto[]` when their APIs are reachable
- Existing sources remain unaffected
- TypeScript compiles without errors
- Each source handles API errors gracefully (returns empty array)
- Sources categorized correctly (job boards vs ATS)

---

## 6. Rollout Plan

| Phase | Sources | Status |
|-------|---------|--------|
| **Phase 1 (Tier 1)** | RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, WeWorkRemotely, Recruitee, Teamtailor | ✅ **Complete** |
| **Phase 2 (Tier 1.5)** | USAJobs, Adzuna, Reed, Jooble, CareerJet | ✅ **Complete** |
| **Phase 3 (Tier 2)** | Wellfound, StepStone, Dice, SimplyHired, JazzHR, Personio, BambooHR | Planned |
| **Phase 4 (Tier 3)** | Monster, CareerBuilder, iCIMS, Taleo, SuccessFactors | Planned |
