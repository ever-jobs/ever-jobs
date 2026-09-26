# API Changelog

### [Unreleased] - 2026-09-25 (Specs 1690, 1691)

#### Added

- **`crawl` on `POST /api/jobs/search` and `POST /api/jobs/analyze`** (`ScraperInputDto.crawl`, `CrawlPolicyDto`): an optional per-request crawl policy — `userAgent`, `userAgentMode`, `from`, `stripClientHints`, `proxyRotation`, `rateLimitScope`, `maxConcurrentPerHost`, `minIntervalMs`, `jitterMs`, `maxQueueWaitMs`, `adaptiveThrottle`, `retries` (0–10), `retryStatuses`, `retryBackoff`, `retryBaseDelayMs`, `retryMaxDelayMs`, `retryJitter`, `retryOnNetworkError`, `respectRetryAfter`, `maxRetryAfterMs`, `retryAfterOverMax`, `throttleRetryDelayMs`, `robotsTxt`, `blockPrivateNetworks`, `discovery`. Every field optional and validated; the operator decides how much a caller may change (`EVER_JOBS_CRAWL_CALLER_OVERRIDES` = `any` | `stricter` | `none`); `blockPrivateNetworks` can only be turned on by a caller. See [CRAWL_POLICY.md](./CRAWL_POLICY.md).
- **GraphQL:** `SearchJobsInput.crawl` of the new input type `CrawlPolicyInput` (same fields; enum-like fields are `String`s).
- **MCP:** `search_jobs` accepts `crawl` (object or JSON-object string).
- **CLI:** `search` and `compare` accept `--crawl <json>`, `--user-agent-mode`, `--proxy-rotation`, `--max-per-host`, `--min-interval-ms`, `--crawl-retries`, `--robots-txt`, `--discovery`, and the process-wide `--crawl-preset`, `--caller-overrides`.
- **`GET /api/sources/:site/crawl-policy?host=&crawl=`**: the resolved crawl policy of a source (optionally for one host, optionally previewing a caller override) with the layer that set each field (`provenance`), the plugin's `userAgentReason`, operator-policy matches and configuration warnings (credentials redacted). 404 for an unknown site, 400 for an unparseable `host`/`crawl`.
- **Diagnostics:** new per-source reason **`rate_limited`** (actionable): our own crawl policy held the source back — no slot within `maxQueueWaitMs`, or the host asked us to back off (`Retry-After`) for longer than we wait. robots.txt refusals report `blocked`; private/internal destinations report `bad_input`.
- **Environment:** 47 `EVER_JOBS_CRAWL_*` variables (preset, identity, proxies, pacing, retries, robots.txt, egress guard, discovery, operator per-site/per-host JSON policies, caller rules), `EVER_JOBS_CIRCUIT_MAX_SITES`, `EVER_JOBS_LIVENESS_DEADLINE_MS`, and `SOFTY_*` knobs — all listed in [CRAWL_POLICY.md §5](./CRAWL_POLICY.md#5-environment-variables) and `.env.example`.

#### Changed

- **Outbound identity:** by default every request carries `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)` instead of a desktop Chrome UA; plugins send their own UA only with a stated reason (USAJobs, HeadHunter). `EVER_JOBS_CRAWL_PRESET=legacy` (or `EVER_JOBS_CRAWL_USER_AGENT=browser`) restores the old identity.
- **Pacing:** requests are paced per host process-wide (default 4 in flight, 100 ms between starts; higher builtin limits for the Greenhouse, Lever, Ashby and SmartRecruiters APIs). `rateDelayMin`/`rateDelayMax` now space concurrent requests too (per host bucket).
- **Proxies:** default rotation is one stable proxy per host (`per-host`) instead of round-robin per request; `DEFAULT_PROXIES` is now used as the fallback list.
- **Retries:** default 2 retries on `429,502,503,504` with exponential back-off and jitter (was 3 linear on `429,500,502,503,504`); never earlier than `Retry-After`; a `Retry-After` over 60 s gives up and cools the whole host instead of being cut to 30 s.
- **Legacy flat fields** (`userAgent`, `rateDelayMin`/`Max`, `retries`, `retryDelay`, `retryBackoff`, `retryMaxDelay`) map into the caller layer only when sent; a sent `userAgent` implies `userAgentMode: "strict"`. `crawl` wins over them.
- **Search deadline:** an abandoned source's queued and in-flight requests are cancelled (`EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` restores the old behaviour); such aborts no longer count against the source's circuit breaker, which now tracks up to 4,096 sites (was 250).
- **Egress guard:** requests to loopback / private / link-local / cluster-internal destinations are refused by default (`EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false` or `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS` for local mocks).
- **Softy (`softy`):** works on the current `/offers` markup again, discovers offers from `/sitemap.xml` (`crawl.discovery` = `auto` | `sitemap` | `listing`), reads paginated listings, fetches detail pages one at a time at ~1 req/s across `softy.pro`.

#### Fixed

- **MCP `search_jobs`** posted snake_case keys that the API's validation whitelist stripped, so every MCP search ran as an unfiltered whole-catalogue fan-out; it now posts the camelCase fields the API accepts.
- **Plugin-declared User-Agents** (e.g. USAJobs' required registered e-mail) were silently replaced by the client's default UA; they now reach the wire where the resolved mode allows.
- `createHttpClient` no longer drops a plugin's own `timeout` when proxies are set.

---

### [v0.7.0-alpha] - 2026-07-27

#### Added

- **`companyDomain` parameter on `POST /api/jobs/search` and `POST /api/jobs/analyze`**: optional array of company domains that are resolved to registered `Site` tokens using the Spec 5069 domain-to-token rule. Unresolved domains now return HTTP 400 with the domain and derived token in the error message.

#### Changed

- `siteType` no longer defaults to all registered sources in `ScraperInputDto`; omitting both `siteType` and `companyDomain` still falls back to search + company scrapers (ATS scrapers skipped unless `companySlug` is provided).

---

### [v0.6.0-alpha] - 2026-02-25

#### Added

- **Redis-Backed Caching**: Optional Redis support via `REDIS_URL`. Falls back to in-memory if not configured.
- **GraphQL API**: New endpoint at `/graphql` (configurable path) with Apollo Playground.
- **Prometheus Metrics**: Export application metrics at `/metrics` for Prometheus scraping.
- **Retry Policies**: Configurable retries with linear and exponential backoff strategies for all job scrapers.
- **Plugin Architecture**: Runtime loading of community scrapers from a `plugins/` directory.
- **Expanded Sources**: Integrated JobsDB and Techcareers sources.

#### Changed

- `AppCacheModule` now uses `registerAsync` for dynamic configuration.
- `JobsService` now supports dynamic scraper registration.
- `HttpClient` standardizes request handling with built-in retries.

New environment variables: `REDIS_URL`, `CACHE_MAX_ITEMS`.

A full GraphQL API is now available alongside REST at `/graphql`:

- **Queries:** `searchJobs`, `listSources`
- **Apollo Playground** enabled by default (configurable via `ENABLE_GRAPHQL`, `GRAPHQL_PLAYGROUND`, `GRAPHQL_PATH`)
- Code-first schema generation with auto-introspection

New dependencies: `@nestjs/graphql`, `@nestjs/apollo`, `@apollo/server`, `graphql`, `cache-manager`, `cache-manager-redis-yet`, `prom-client`.

---

## [1.1.0] — 2026-02-25

### Phase 27: Asia-Pacific & US Tech Expansion (2 sources)

**JobsDB** (Asia-Pacific — SG, HK, TH) and **TechCareers** (US tech niche)

Total sources expanded from 158 to 160.

### New `siteType` Values

`jobsdb`, `techcareers`

---

## [1.0.0] — 2026-02-25

### Phases 23–26: Global & Niche Expansion (14 sources)

**Phase 23 — Japan, Nordic & Swiss (3):** Jobs in Japan, Duunitori (Finland), Jobs.ch (Switzerland)
**Phase 24 — UK & Mobile Dev (3):** Guardian Jobs, AndroidJobs, iOSDevJobs
**Phase 25 — DevOps, FP & Diversity (4):** DevOpsJobs, FunctionalWorks, PowerToFly, ClojureJobs
**Phase 26 — Sustainability (1):** EcoJobs

Total sources expanded from 144 to 158.

### New `siteType` Values

`jobsinjapan`, `duunitori`, `jobsch`, `guardianjobs`, `androidjobs`, `iosdevjobs`, `devopsjobs`, `functionalworks`, `powertofly`, `clojurejobs`, `ecojobs`

## [0.9.0] — 2026-02-22

### Phases 19–22: European & CIS Expansion (18 sources)

**Phase 19 — Tech niche & crypto (5):** RailsJobs, ElixirJobs, Crunchboard, CryptocurrencyJobs, HasJob
**Phase 20 — European regional (5):** iCrunchdata, SwissDevJobs, GermanTechJobs, VirtualVocations, NoFluffJobs
**Phase 21 — Niche & academic (5):** GreenJobsBoard, EuroJobs, OpenSourceDesignJobs, AcademicCareers, RemoteFirstJobs
**Phase 22 — Eastern European, CIS & Singapore (4):** Djinni (Ukraine), HeadHunter (Russia/CIS), HabrCareer (Russia), MyCareersFuture (Singapore)

Total sources expanded from 126 to 144.

## [0.8.0] — 2026-02-20

### Phases 15–18: European Government & RSS Expansion (19 sources)

**Phase 15 — European government & regional (5):** JobTechDev (Sweden), France Travail, NAV Jobs (Norway), Jobs.ac.uk, Jobindex (Denmark)
**Phase 16 — Global expansion (4):** GetOnBoard (LatAm), Freelancer.com, JoinRise, Canada Job Bank
**Phase 17 — NGO & international (3):** ReliefWeb, UNDP Jobs, DevITJobs
**Phase 18 — Niche RSS (5):** PyJobs, VueJobs, ConservationJobs, Coroflot, BerlinStartupJobs

Total sources expanded from 107 to 126.

### New Environment Variables

| Variable                         | Purpose                               |
| -------------------------------- | ------------------------------------- |
| `JOBTECHDEV_API_KEY`             | Swedish Employment Service API key    |
| `FRANCETRAVAIL_CLIENT_ID/SECRET` | France Travail OAuth2 credentials     |
| `NAVJOBS_TOKEN`                  | Norwegian NAV bearer token (optional) |

## [0.7.0] — 2026-02-19

### Phases 12–14: ATS & API-Key Expansion (13 sources)

**Phase 12 — ATS & niche board (3):** AuthenticJobs, JobScore (ATS), TalentLyft (ATS)
**Phase 13 — RSS niche boards (10):** CryptoJobsList, Jobspresso, HigherEdJobs, FOSSJobs, LaraJobs, PythonJobs, DrupalJobs, RealWorkFromAnywhere, GolangJobs, WordPressJobs
**Phase 14 — API-key sources & ATS (5):** Talroo, InfoJobs, Crelate (ATS), iSmartRecruit (ATS), Recruiterflow (ATS)

Total sources expanded from 89 to 107 (ATS count: 28 → 38).

### New Environment Variables

| Variable                    | Purpose                      |
| --------------------------- | ---------------------------- |
| `AUTHENTICJOBS_API_KEY`     | Authentic Jobs API key       |
| `TALENTLYFT_API_KEY`        | TalentLyft Bearer token      |
| `TALROO_PUBLISHER_ID/PASS`  | Talroo publisher credentials |
| `INFOJOBS_CLIENT_ID/SECRET` | InfoJobs OAuth credentials   |

## [0.6.0] — 2026-02-17

### Phases 9–11: Job Board & Government Expansion (16 sources)

**Phase 9 — Job board expansion (8):** The Muse, Working Nomads, 4 Day Week, StartupJobs, NoDesk, Web3Career, EchoJobs, JobStreet
**Phase 10 — Government boards & ATS (4):** CareerOneStop (US), Arbeitsagentur (Germany), Jobylon (ATS), Homerun (ATS)
**Phase 11 — Niche boards & developer APIs (4):** Hacker News, Landing.jobs, FindWork, JobDataAPI

Total sources expanded from 73 to 89.

### New Environment Variables

| Variable                 | Purpose                       |
| ------------------------ | ----------------------------- |
| `CAREERONESTOP_API_KEY`  | CareerOneStop Bearer token    |
| `ARBEITSAGENTUR_API_KEY` | German Arbeitsagentur API key |
| `FINDWORK_API_KEY`       | FindWork.dev API token        |
| `JOBDATAAPI_API_KEY`     | JobDataAPI key (optional)     |

## [0.5.0] — 2026-02-16

### Phases 6–8: ATS, Company & Board Expansion (22 sources)

**Phase 6 — New company scrapers (5):** Google Careers, Meta, Netflix, Stripe, OpenAI
**Phase 6 — New ATS integrations (3):** BreezyHR, Comeet, Pinpoint
**Phase 7 — Additional job boards (3):** BuiltIn, Snagajob, Dribbble
**Phase 8 — ATS expansion (10):** Manatal, Paylocity, Freshteam, Bullhorn, Trakstar, HiringThing, Loxo, Fountain, Deel, Phenom
**Phase 8 — Company scrapers (3):** IBM, Boeing, Zoom

Total sources expanded from 51 to 73.

### New Environment Variables

| Variable              | Purpose                   |
| --------------------- | ------------------------- |
| `FRESHTEAM_API_KEY`   | Freshteam API key         |
| `BULLHORN_CORP_TOKEN` | Bullhorn corp token       |
| `TRAKSTAR_API_KEY`    | Trakstar Hire API key     |
| `HIRINGTHING_API_KEY` | HiringThing API key       |
| `LOXO_API_TOKEN`      | Loxo API token (optional) |
| `FOUNTAIN_API_KEY`    | Fountain API key          |
| `DEEL_API_TOKEN`      | Deel API token            |

## [0.4.0] — 2026-02-15

### New Sources (5)

Added 5 new job source integrations (Tier 3 — heavy anti-bot / enterprise ATS):

**ATS (3):**

- **Oracle Taleo** — REST API (JSON), `{company}:{careerSection}` slug format
- **iCIMS** _(WIP)_ — JSON gateway + Playwright fallback with stealth mode
- **SAP SuccessFactors** _(WIP)_ — OData API + HTML fallback, `{instance}:{companyId}` slug format

**Job Boards (2):**

- **Monster** _(WIP)_ — `appsapi.monster.io` JSON API + Playwright stealth fallback (DataDome protected)
- **CareerBuilder** _(WIP)_ — Cheerio + Playwright stealth fallback (Cloudflare protected)

Total sources expanded from 46 to 51.

### New `siteType` Values

- `taleo`, `icims`, `successfactors` — ATS sources (require `companySlug` parameter)
- `monster`, `careerbuilder` — search-based job boards (included in default searches)

### BrowserPool Stealth Mode

New `stealth: true` option for `BrowserPool.getPage()` enables anti-bot evasion:

- User-Agent rotation (6 recent Chrome UAs across Mac/Win/Linux)
- Viewport randomization (5 common resolutions)
- JavaScript injection to mask `navigator.webdriver`, fake `window.chrome.runtime`, override `navigator.plugins`, patch canvas fingerprinting, and spoof WebGL renderer info

### Proxy Support

All 5 sources wire proxies through:

- HTTP sources: via `createHttpClient({ proxies })`
- Playwright sources: via `BrowserPool.getPage({ proxy, stealth: true })`

### WIP Sources Note

4 of 5 sources are marked WIP — Monster and CareerBuilder will likely need residential proxies for reliable operation. iCIMS layouts vary per company deployment. SuccessFactors OData access varies per company configuration.

## [0.3.0] — 2026-02-15

### New Sources (7)

Added 7 new job source integrations (Tier 2 — HTML scraping / Playwright):

**ATS (3):**

- **BambooHR** — Public JSON API, `{companySlug}.bamboohr.com/careers/list`
- **Personio** — Public XML feed, `{companySlug}.jobs.personio.de/xml`
- **JazzHR** _(WIP)_ — HTML scraping, `{companySlug}.applytojob.com/apply/jobs/`

**Job Boards (4):**

- **Dice** _(WIP)_ — Cheerio + Playwright fallback, US tech jobs
- **SimplyHired** _(WIP)_ — Cheerio + Playwright fallback, global
- **Wellfound** _(WIP)_ — Playwright SPA (`__NEXT_DATA__` extraction), startup jobs
- **StepStone** _(WIP)_ — Playwright SPA, Germany (`.de`) initially

Total sources expanded from 39 to 46.

### New `siteType` Values

- `bamboohr`, `personio`, `jazzhr` — ATS sources (require `companySlug` parameter)
- `dice`, `simplyhired`, `wellfound`, `stepstone` — search-based job boards (included in default searches)

### Proxy Support

All 7 sources wire proxies through:

- HTTP sources: via `createHttpClient({ proxies })`
- Playwright sources: via `BrowserPool.getPage({ proxy })`

### WIP Sources Note

5 of 7 sources are marked WIP — code is shipped but HTML selectors need validation against live sites. These sources will gracefully return empty results if selectors are outdated.

## [0.2.0] — 2026-02-14

### New Sources (5)

Added 5 new job source integrations (Tier 1.5 — free API key required):

- **USAJobs** — US government job board (`USAJOBS_API_KEY` + `USAJOBS_EMAIL`)
- **Adzuna** — Multi-country aggregator, 12+ countries (`ADZUNA_APP_ID` + `ADZUNA_APP_KEY`)
- **Reed** — UK-focused job board (`REED_API_KEY`)
- **Jooble** — 70+ country aggregator (`JOOBLE_API_KEY`)
- **CareerJet** — 80+ country aggregator (`CAREERJET_AFFID`)

Total sources expanded from 34 to 39.

### New `siteType` Values

- `usajobs`, `adzuna`, `reed`, `jooble`, `careerjet` — search-based job sources (included in default searches when API keys are configured)

### New Input Field

- `clientIp` — Optional client IP address for sources that require it (e.g. CareerJet). Also useful for residential proxy rotation strategies. Combined with the existing `proxies` array for multi-IP support.

### Per-Request Auth Override

All API-key sources now support per-request credential override via `auth` in the request body, following the existing Upwork pattern. This allows clients to use their own API keys instead of (or in addition to) server-side environment variables.

New `auth` sub-objects: `auth.usajobs`, `auth.adzuna`, `auth.reed`, `auth.jooble`, `auth.careerjet`, `auth.exa`

Each credential field resolves independently — callers can override individual fields while keeping others from env vars (e.g. override `auth.usajobs.apiKey` but keep `email` from `USAJOBS_EMAIL`).

## [0.1.1] — 2026-02-14

### New Sources (8)

Added 8 new job source integrations (Tier 1 — public APIs/RSS, no auth required):

- **Job Boards (6):** RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, We Work Remotely
- **ATS (2):** Recruitee, Teamtailor

Total sources expanded from 26 to 34.

### New `siteType` Values

- `remoteok`, `remotive`, `jobicy`, `himalayas`, `arbeitnow`, `weworkremotely` — search-based job boards (included in default searches)
- `recruitee`, `teamtailor` — ATS sources (require `companySlug` parameter)

## [0.1.0] — 2026-02-08

### New Endpoints

- `POST /api/jobs/search` — search for jobs across multiple boards
  - JSON body input with `ScraperInputDto`
  - Wrapped response: `{ count, jobs, cached }`
  - CSV export via `?format=csv`
  - Pagination via `?paginate=true&page=1&page_size=10`
  - Response caching with configurable TTL
- `POST /api/jobs/analyze` — search and analyze jobs with summary statistics
- `GET /health` — service health with uptime, version, and memory usage
- `GET /ping` — simple liveness check

### Security

- API key authentication via configurable header (default: `x-api-key`)
- Per-client request throttling with configurable limits

### Response Headers

- `X-Request-Id` — unique request identifier for tracing
- `X-Process-Time` — request processing duration in ms
