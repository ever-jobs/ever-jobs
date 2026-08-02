# ATS Integrations

Ever Jobs integrates directly with **41 applicant tracking systems** that power career pages at thousands of companies worldwide. When a recruiter publishes a new role through any supported ATS, Ever Jobs detects the posting at the source — often hours before it appears on aggregated job boards like LinkedIn or Indeed.

## How ATS Integration Works

1. **Purpose-Built Adapters** — Each ATS has a dedicated scraper module that understands the platform's data format, API structure, and publishing workflow.
2. **Direct Source Detection** — Ever Jobs reads from the ATS's structured JSON/XML feed or API endpoint, seeing jobs the moment they go live on the company's career page.
3. **Normalized Output** — Despite each ATS having a different response schema, all results are normalized into the standard `JobPostDto` format with consistent fields across platforms.

### Usage

ATS scrapers require a `companySlug` parameter to identify which company's career page to query:

```bash
# Search Greenhouse jobs for Stripe
curl -X POST http://localhost:3001/api/jobs/search \
  -H 'Content-Type: application/json' \
  -d '{"companySlug": "stripe", "siteType": ["greenhouse"]}'

# Search all ATS platforms for a given company
curl -X POST http://localhost:3001/api/jobs/search \
  -H 'Content-Type: application/json' \
  -d '{"companySlug": "notion"}'
```

When `companySlug` is provided without an explicit `siteType`, all 41 ATS scrapers run concurrently. Each one independently checks whether the company exists on its platform and returns results accordingly.

---

## Supported Platforms

### Greenhouse

The leading applicant tracking system for scaling companies. Known for structured hiring methodology with scorecards, interview plans, and evaluation criteria. Career pages typically hosted at `boards.greenhouse.io`.

- **Method**: REST API (`api.greenhouse.io/v1/boards`)
- **Data Format**: JSON with full job descriptions, departments, offices
- **Notable Users**: Airbnb, Coinbase, Datadog, DoorDash, HubSpot, Notion, Stripe

### Lever

A talent acquisition suite combining ATS and CRM capabilities. Lever helps companies build and maintain candidate relationships throughout the hiring process, from sourcing to close.

- **Method**: REST API (`jobs.lever.co`)
- **Data Format**: JSON with team, location, commitment level
- **Notable Users**: Netflix, Shopify, KPMG, Eventbrite, Atlassian

### Workday

Enterprise-grade human capital management platform used by the world's largest organizations. Workday Recruiting is a core module within its broader HR suite, handling requisitions, approvals, and candidate management at global scale.

- **Method**: REST API (company-specific Workday endpoints)
- **Data Format**: JSON with compensation, requisition metadata
- **Notable Users**: Amazon, Salesforce, Target, Bank of America, Visa, Netflix

### Ashby

A modern, all-in-one recruiting platform purpose-built for high-growth companies. Ashby combines ATS, CRM, scheduling, and analytics into a single product, favored by technology companies that value data-driven hiring.

- **Method**: REST API (`jobs.ashbyhq.com`)
- **Data Format**: JSON with department, team, employment type
- **Notable Users**: Ramp, Figma, Linear, Vercel, Plaid

### SmartRecruiters

Enterprise talent acquisition platform with a marketplace of integrated hiring tools. SmartRecruiters serves large organizations across industries globally, with strong compliance and reporting capabilities.

- **Method**: REST API (`jobs.smartrecruiters.com`)
- **Data Format**: JSON with location, department, experience level
- **Notable Users**: Visa, Bosch, LinkedIn, Skechers, Equinox

### Jobvite

End-to-end talent acquisition suite covering recruitment marketing, ATS, and onboarding. Jobvite is recognized for its annual insights on hiring trends and candidate behavior.

- **Method**: REST API (`jobs.jobvite.com`)
- **Data Format**: JSON with requisition details, department, category
- **Notable Users**: Logitech, Schneider Electric, Zappos

### Workable

Hiring platform designed for small and mid-sized businesses. Workable provides sourcing tools, an ATS, and AI-powered candidate recommendations, making it accessible for organizations without dedicated recruiting operations.

- **Method**: GraphQL API (company-specific subdomains)
- **Data Format**: JSON with requirements, benefits, location
- **Notable Users**: Sephora, Bain Capital, Forbes

### SAP SuccessFactors

SAP's cloud-based human experience management suite used by large enterprises worldwide. SuccessFactors Recruiting handles talent acquisition at scale with deep integration into SAP's broader HR ecosystem.

- **Method**: three read surfaces, deterministic switch (Spec 5055) — OData API (preferred when an instance is known) → **Career Site Builder (CSB / RMK)** portal → native careersection HTML fallback
- **Data Format**: OData XML/JSON with full requisition details; CSB portals are server-rendered HTML whose detail pages carry schema.org `JobPosting` **microdata** (not JSON-LD)
- **CSB portals**: frequently on the employer's **own custom domain** (e.g. `careers.example.com`, no `successfactors` in the hostname) and often without public OData; addressed by the portal URL (`companyUrl`), list at `/tile-search-results/?...&startrow={N}`, detail at `/job/{slug}/{jobId}/`
- **Notable Users**: Siemens, Accenture, Deloitte, EY

### Oracle Taleo

Oracle's enterprise talent management cloud and one of the most widely deployed ATS platforms globally, particularly among Fortune 500 companies. Taleo handles high-volume recruiting across complex organizational structures.

- **Method**: REST API (JSON)
- **Data Format**: JSON with requisition metadata, location hierarchy
- **Notable Users**: JPMorgan Chase, PepsiCo, Intel, Cisco

### iCIMS

Talent cloud platform serving enterprise employers. iCIMS powers hiring for some of the world's largest workforces with tools spanning the entire talent lifecycle — from attraction and engagement to hiring and onboarding.

- **Method**: Playwright + JSON gateway
- **Data Format**: JSON via dynamic rendering
- **Notable Users**: UPS, Uber, Johnson & Johnson, Target

### ADP Recruiting

Part of ADP's comprehensive HR platform, ADP Recruiting Management helps organizations streamline hiring from requisition to onboarding. Integrated with ADP Workforce Now, it provides unified HR and recruiting data for enterprises.

- **Method**: REST API (ADP Workforce Now endpoints)
- **Data Format**: JSON with requisition, location, compensation
- **Notable Users**: Major enterprises across industries

### UKG (UltiPro)

UKG's talent acquisition module within its broader workforce management platform. UKG Pro Recruiting is used by mid-to-large organizations for end-to-end HR management, particularly strong in healthcare and manufacturing sectors.

- **Method**: REST API (`recruiting.ultipro.com`)
- **Data Format**: JSON with opportunity details, department, location
- **Notable Users**: Major healthcare and manufacturing organizations

### Rippling

Modern HR platform that unifies employee management, payroll, benefits, and recruiting. Rippling's ATS integrates tightly with its broader HR suite, popular among technology companies.

- **Method**: REST API
- **Data Format**: JSON

### Recruitee

Collaborative hiring platform with an emphasis on employer branding. Recruitee provides public career page APIs with salary data when available.

- **Method**: REST API (`{slug}.recruitee.com/api/offers`)
- **Data Format**: JSON with salary, department, location

### Teamtailor

Swedish-origin employer branding and ATS platform focused on candidate experience. Teamtailor powers career sites with rich media and analytics.

- **Method**: REST API (company-specific career page endpoints)
- **Data Format**: JSON

### BambooHR

HR software designed for small and medium businesses. BambooHR's recruiting module provides public career page APIs with structured job and location data.

- **Method**: REST API (`{slug}.bamboohr.com/careers/list`)
- **Data Format**: JSON with department, location, employment status

### Personio

European-focused HR platform for small and mid-sized companies. Personio's recruiting module exposes job listings through XML feeds.

- **Method**: XML feed
- **Data Format**: XML with position details, department, location

### JazzHR

Recruiting software for small businesses. JazzHR provides career pages with job listings accessible through HTML scraping.

- **Method**: HTML scraping
- **Data Format**: HTML with job details, location, department

### Breezy HR

Visual hiring pipeline ATS with a focus on simplicity and employer branding.

- **Method**: REST API
- **Data Format**: JSON

### Comeet

Collaborative hiring platform that helps teams make data-driven hiring decisions.

- **Method**: REST API
- **Data Format**: JSON

### Pinpoint

Smart recruiting software with employer branding and analytics.

- **Method**: REST API
- **Data Format**: JSON

### Manatal

AI-powered ATS serving 160,000+ organizations, particularly strong in Asia-Pacific and global SMB markets. Manatal offers public career page APIs that require no authentication.

- **Method**: REST API (`api.manatal.com/open/v1/career-page/{slug}/jobs/`)
- **Data Format**: JSON with salary, location, department
- **Notable Users**: 160K+ organizations globally

### Paylocity

US mid-market HR and payroll platform with integrated recruiting. Career page jobs are accessible via GUID-based public endpoints.

- **Method**: REST API (`recruiting.paylocity.com/recruiting/api/feed/jobs/{guid}`)
- **Data Format**: JSON
- **Notable Users**: 30K+ US mid-market companies

### Freshteam

Freshworks' HR platform with applicant tracking. Requires API key authentication for job listing access.

- **Method**: REST API (`{company}.freshteam.com/api/job_postings`)
- **Auth**: Bearer token (API key)
- **Data Format**: JSON

### Bullhorn

The #1 ATS for staffing and recruiting agencies. Uses corp token authentication for public job search endpoints.

- **Method**: REST API (`public-rest{cls}.bullhornstaffing.com/rest-services/{token}/search/JobOrder`)
- **Auth**: Corp Token (static per-company)
- **Data Format**: JSON
- **Notable Users**: 10K+ staffing agencies

### Trakstar Hire

Formerly RecruiterBox. Provides API access with basic authentication for job listings.

- **Method**: REST API (`{slug}.hire.trakstar.com/api/v1/openings`)
- **Auth**: API Key (Basic Auth)
- **Data Format**: JSON
- **Notable Users**: 5K+ companies

### HiringThing

White-label ATS platform (also branded as ATS Anywhere). API key required for access.

- **Method**: REST API (`api.hiringthing.com/api/v1/jobs`)
- **Auth**: API Key (Basic Auth)
- **Data Format**: JSON

### Loxo

AI-powered recruiting platform with public career board endpoints and optional API token for full access.

- **Method**: REST API (`app.loxo.co/api/{slug}/jobs`)
- **Auth**: Optional API token (public career board works without)
- **Data Format**: JSON
- **Notable Users**: 1K-3K recruiting firms

### Fountain

High-volume hourly hiring ATS used by major enterprises for frontline workforce hiring.

- **Method**: REST API (`api.fountain.com/v2/openings`)
- **Auth**: Bearer token
- **Data Format**: JSON
- **Notable Users**: 300+ enterprises (Uber, Amazon for frontline hiring)

### Deel

Global hiring and EOR (Employer of Record) platform with an integrated ATS module for job posting management.

- **Method**: REST API (`api.letsdeel.com/rest/v2/ats/job-postings/`)
- **Auth**: Bearer token
- **Data Format**: JSON
- **Notable Users**: 35K+ customers globally

### Phenom

Enterprise talent experience platform powering career sites for 900+ large enterprises. Each company has a Phenom-powered career site with REST API access.

- **Method**: REST API (`jobs.{company}.com/api/jobs` — per-company domain)
- **Auth**: None (public per-company career site)
- **Data Format**: JSON
- **Notable Users**: Boeing, Hilton, Nestle, Comcast, Verizon

### Eightfold

Talent-intelligence platform ("PCSX" / SmartApply) powering the public careers sites of many large enterprises. Every tenant exposes the same public positions API; tenants are reachable at an Eightfold subdomain or a custom apply domain.

- **Method**: Public positions REST API (`https://{slug}.eightfold.ai/api/apply/v2/jobs?domain={domain}&start=N&num=10&sort_by=timestamp`)
- **Auth**: None (public SmartApply endpoint)
- **Data Format**: JSON — `{ positions: [...], count: <total> }`; server-fixed page size 10, paginated by `start`; remaining pages fanned out concurrently (≤ 8) with `Promise.allSettled`
- **Custom Domains**: Supported via the `companyUrl` input override
- **Notable Users**: Nvidia, Cisco, AT&T, Bayer, Booking, Dolby, Activision
- **Known Limitation**: tenants behind an aggressive WAF (Cloudflare) may 403 plain HTTPS; a browser-fingerprint fallback is a tracked follow-up (Q-043)

### Avature

Enterprise-grade talent acquisition and CRM platform for global enterprises. Avature emphasizes flexible workflow configuration and is widely used in financial services, energy, and global staffing. Career portals are reachable both at standard subdomains and at custom-domain tenants (e.g. Bloomberg, IBM).

- **Method**: HTML scrape with cheerio (`*.avature.net/careers/SearchJobs/?jobOffset=N&jobRecordsPerPage=12`)
- **Auth**: None (public career portal)
- **Data Format**: HTML — five-cascade selector chain (`article.job` / `div.job-item` / `li.job-listing` / `tr.job` / `div[data-job-id]`) plus an `/JobDetail/`-link fallback
- **Custom Domains**: Supported via the `companyUrl` input override (e.g. `https://careers.ibm.com`)
- **Notable Users**: Bloomberg, KPMG (Ireland / NL), Deloitte (PNG), Maximus, Plante Moran, NVA, Delta, One800Flowers

### Gem

Modern recruiting platform combining ATS + CRM, popular with high-growth technology companies and venture-backed startups. Gem boards are hosted at `jobs.gem.com/<companySlug>` with a single batched GraphQL endpoint that returns the entire board in one round-trip.

- **Method**: Single batched GraphQL POST (`https://jobs.gem.com/api/public/graphql/batch`) carrying both `JobBoardTheme` + `JobBoardList` operations
- **Auth**: None (public board)
- **Data Format**: JSON — `data.oatsExternalJobPostings.jobPostings[]` per envelope; response-order tolerant (Theme first or List first)
- **Notable Users**: Accel, Alex and Ani, A16Z Speedrun, 43North, Acre, Agora, Airframe

### Join.com

European-focused recruiting platform with strong adoption in Germany, Austria, and Switzerland. Join.com career pages live at `join.com/companies/<slug>`; the public REST API exposes paginated jobs at 50 per page with optional aggregations.

- **Method**: Two-step REST flow — Step 1: HTML scrape `join.com/companies/<slug>` to regex-extract numeric `companyId` (primary `"company":{"id":N` shape, fallback `"companyId":N` for skinned tenants); Step 2: paginated `GET /api/public/companies/<id>/jobs?locale=en-us&page=N&pageSize=50&withAggregations=true&sort=+title` until `pagination.totalPages` is reached or `items[]` is empty
- **Auth**: None (public `/api/public` namespace)
- **Data Format**: JSON with `items[]`, `pagination`, optional aggregations
- **Polite Pacing**: 0.5 s between paginated calls (matches upstream Python's `time.sleep(0.5)`)
- **Notable Users**: Awork, Alteos, Aitad, Capitalmind, Brandcircle, Cinnamood, Brandneo, Brunathelabel, Allunity, Citychickennhas490

### Oracle HCM Cloud (Oracle Recruiting Cloud)

Enterprise-grade multi-tenant ATS within Oracle's HCM Cloud suite. Tenants typically host at `https://<subdomain>.fa.<region>.oraclecloud.com` (e.g. `eeho.fa.us2.oraclecloud.com` for Oracle's own careers site). The CandidateExperience REST API exposes a finder-string-driven `recruitingCEJobRequisitions` endpoint that paginates at 100 per page.

- **Method**: REST GET against `/hcmRestApi/resources/latest/recruitingCEJobRequisitions` with a `findReqs;<finder-string>` finder (commas between params, semicolons between facets — matches upstream Python's wire format; the all-semicolon variant suggested in spec drafts was rejected by the live API)
- **Auth**: None (public CandidateExperience namespace)
- **Data Format**: JSON — `response.items[0].requisitionList[]`; each row carries `Id` / `Title` / `PrimaryLocation` / `PostedDate` / `EmployerName` plus optional `ExternalUrl` / `ExternalUrlSeo` for canonical apply links
- **Tenant Resolution**: `companyUrl` (full URL override, canonical) ⇒ used verbatim; `companySlug` (`<subdomain>-<region>` form, e.g. `eeho-us2`) ⇒ composed to `https://<subdomain>.fa.<region>.oraclecloud.com`
- **`siteNumber` Override**: Optional `ScraperInputDto.siteNumber` field defaulting to `'CX_45001'` (Q-030 — upstream Python's documented default; ≥ 95 % of tenants honour it)
- **Pagination**: `offset=N` increments by 100 until `requisitionList[]` is empty OR `resultsWanted` cap; first page omits `offset=` for canonical request shape
- **Notable Users**: Oracle, City of Atlanta, TTX, CooperCompanies, EXP, Kroll, Macy's, Westpac Group, DTCC, Hologic, Mountaire, Mouser, Ricoh, Galliford Try, Apollo Hospitals, Standard Aero, Proskauer, Euroclear, Arcadis, BDO USA, Onity, Hillside, Dubai World Trade Centre, Zeus

### Mercor

Talent marketplace (NOT a per-company ATS) where companies post contract / full-time opportunities. The explore page returns the **entire public catalogue** in one GET — no per-company URL segmentation, no pagination — so per-company filtering is a client-side substring match on `companyName` rather than a slug-keyed dispatch.

- **Method**: Single REST GET to `https://aws.api.mercor.com/work/listings-explore-page`
- **Auth**: Literal `Authorization: Bearer` header (empty token — mirrors upstream Python's `MercorClient.session.headers`); `Origin` + `Referer` (`https://work.mercor.com`) required by the API gateway
- **Data Format**: JSON — `response.listings[]`; each row carries `listingId` / `title` / `companyName` / `location` / `postedAt` plus a `rateMin / rateMax / payRateFrequency` triple (mapped into `JobPostDto.compensation` directly — no detail fetch required)
- **Filtering Semantics**: `companySlug` is a **case-insensitive substring filter** on `companyName` (e.g. `companySlug='stripe'` retains rows whose `companyName.toLowerCase()` contains `'stripe'`). Empty slug ⇒ full catalogue, capped by `resultsWanted` (cap applies AFTER the filter so a 5-row Stripe slice is genuinely 5 Stripe rows)
- **Detail Fetch**: Not exercised — explore-page envelope already carries enough fields for `JobPostDto` mapping. Detail-page enrichment deferred to candidate Spec 016
- **Notable Users**: Stripe, OpenAI, Anthropic, Notion, Airbnb, Figma, Vercel, Linear, Discord, Coinbase, Plaid, Ramp (sample of the catalogue at time of writing — the explore page surfaces ≥ 200 distinct employers across software, finance, design, and operations)

### Tesla

Single-company custom careers portal at `https://www.tesla.com/careers/search/`. Tesla operates its own internal `/cua-api/` endpoint pair (board + per-job detail) protected by Akamai Bot Manager. Ever Jobs ships **two** Tesla plugins:

- **Default `source-tesla` (pure-HTTP):** Calls the board endpoint directly with rotated UA + `Accept: application/json`. Akamai-challenge surfaces (HTTP 403 / 503 OR a `text/html` body when JSON was requested) return an empty `JobResponseDto` with the `ERR_TESLA_AKAMAI_CHALLENGE` sentinel logged.
- **Optional `source-tesla-playwright` (browser-automation companion):** Lazy-loads `playwright` via `Function('s', 'return import(s)')(specifier)` indirection (defeats ts-jest's static module resolution). Launches headless Chromium with `--disable-blink-features=AutomationControlled`, navigates to the careers-search landing page, settles 5 s for Akamai's challenge JS to resolve, then issues in-page `fetch()` calls through the established session. Per Q-028, this companion is **NOT** auto-registered via `ALL_SOURCE_MODULES` — operators opt in by importing `TeslaPlaywrightModule` directly.

- **Method (default)**: REST GET to `https://www.tesla.com/cua-api/apps/careers/state` (board) followed by per-job GETs to `/cua-api/careers/job/{id}` (detail)
- **Method (companion)**: Headless Chromium navigation to `/careers/search/` → in-page `fetch()` for board + detail (lazy `import('playwright')`)
- **Auth**: None for either path (public careers API; companion adds a real browser session for Akamai bypass)
- **Data Format**: JSON — `response.listings[]` at top level + `response.lookup` as a sibling map (location-id / department-id dictionaries; the spec draft's `data.lookup.listings[]` path was incorrect and is corrected in the implementation)
- **Description Budget**: `ScraperInputDto.descriptionDepth` controls per-job detail-fetch fan-out: `'board'` → 0 follow-ups (descriptions stay null), `'detail-25'` (default per Q-031) → 25 follow-ups, `'detail-all'` → ∞. Detail-fetch failures are silently swallowed; the affected listing keeps `description: null` but still emits as a `JobPostDto`
- **Cross-Plugin Dedup**: When both Tesla plugins are enabled, rows emit under different `Site` keys (`Site.TESLA` vs `Site.TESLA_PLAYWRIGHT`) so per-source breaker policies (Spec 005 / FR-1) track them independently. `dedup-hybrid`'s hash strategy (Spec 003 / FR-3) collapses cross-site duplicates by `externalId` (per Q-032 default)
- **Notable Users**: Tesla (single-tenant; no per-company variation)

### Cornerstone OnDemand (CSOD)

Enterprise talent-management suite whose Cornerstone Recruiting product powers the public career sites of many large enterprises and public-sector organizations at `https://{slug}.csod.com`. The public listing flow is an **anonymous two-step bootstrap** — no OAuth/operator credentials required.

- **Method**: (1) GET the public career-site page `https://{slug}.csod.com/ux/ats/careersite/{siteId}/home?c={slug}` — embeds an anonymous JWT token and the regional "cloud" API host (e.g. `https://us.api.csod.com`), with the JWT `rurls` claim whitelisting `rec-job-search/external`; (2) `POST {cloud}/rec-job-search/external/jobs` paginated by `pageNumber` / `pageSize=25`, bounded concurrent fan-out with `Promise.allSettled`
- **Auth**: None (anonymous JWT minted by the public career-site page)
- **Data Format**: JSON — requisitions array; `externalDescription` already present in the listing (no per-requisition enrichment needed)
- **Tenant Resolution**: `companySlug` → `https://{slug}.csod.com`, or explicit `companyUrl`; `siteNumber` overrides the default careerSiteId (`1`)
- **Known Limitation**: WAF-gated tenants, the credentialed OAuth Recruiting REST API, and multi-portal careerSiteId auto-discovery are explicit non-goals (Spec 297)

### Dayforce (Ceridian Dayforce HCM)

Cloud HCM platform whose candidate career portals are hosted at `https://{client}.dayforcehcm.com/CandidatePortal/`. Ever Jobs reads the consolidated **no-auth geo job-posting search feed**.

- **Method**: `POST https://jobs.dayforcehcm.com/api/geo/{client}/jobposting/search` with body `{ clientNamespace, jobBoardCode: 'CANDIDATEPORTAL', cultureCode: 'en-US', distanceUnit, paginationStart }`; server-fixed page size 25 paginated via `paginationStart`, bounded `Promise.allSettled` fan-out
- **Auth**: None (public candidate-portal feed)
- **Data Format**: JSON — `{ jobPostings[], maxCount, count }`. Parser reads both modern camelCase geo fields (`jobPostingId`, `jobTitle`, `jobDescription`, `postingLocations`, `postingStartTimestampUTC`) and the documented PascalCase RESTful fields (`Title`, `JobDetailsUrl`, `ApplyUrl`, `City`/`State`/`Country`, `DatePosted`, `ParentRequisitionCode`) defensively
- **Tenant Resolution**: client namespace from `companySlug`, then `siteNumber`, then parsed from `companyUrl` (legacy `{client}.dayforcehcm.com` subdomain or the path segment after the locale / `CandidatePortal`)
- **Known Limitation**: WAF/Cloudflare TLS-fingerprint-gated tenants (HTTP 403 on plain HTTPS) deferred to a browser-fingerprint follow-up (Q-044); per-posting detail enrichment and the legacy XML feed are non-goals (Spec 298)

### Zoho Recruit

Recruitment ATS in the Zoho suite; career sites are hosted per-tenant at `https://{slug}.zohorecruit.com` (with `.eu` / `.in` datacenter variants). Zoho **server-renders the full open-roles list into the careers page** rather than exposing a separate paginated JSON API.

- **Method**: GET `https://{slug}.zohorecruit.com/jobs/Careers`; the open-roles list is an HTML-entity-encoded JSON array embedded in a hidden `<input id="jobs">`. The service fetches once, decodes entities, and `JSON.parse`s defensively (the single fetch is still wrapped in `Promise.allSettled` per the batch-safety rule)
- **Auth**: None (public career site)
- **Data Format**: Embedded JSON — `Job_Openings` fields (`id`, `Posting_Title` / `Job_Opening_Name`, `Job_Description`, `City` / `State` / `Country`, `Date_Opened`, `Remote_Job`, `Job_Type`, `Industry`, `Is_Locked` / `Publish`); job URLs built as `{host}/jobs/Careers/{id}/{title-slug}`
- **Tenant Resolution**: `companySlug` (US `.com` default) or explicit `companyUrl` for EU/IN datacenters
- **Known Limitation**: the OAuth REST API, WAF-gated tenants, lazy-load/digest-gated pagination beyond the embedded slice, and non-US datacenter auto-discovery are non-goals (Spec 299). Wires the previously-orphaned `Site.ZOHORECRUIT` enum member to a real plugin.

### ClearCompany

Talent-management ATS whose career sites are hosted at `https://careers-page.clearcompany.com/jobs/{slug}/...`. Ever Jobs reads the **verified public careers feed**.

- **Method**: GET `https://careers-page.clearcompany.com/api/v1/careers/jobs` with an `API-ShortName: {slug}` header — returns the tenant's full open-roles list in a single call (no auth, no pagination envelope)
- **Auth**: None
- **Data Format**: JSON — flat array of PascalCase objects (`Id` GUID, `PositionTitle`, `Description` HTML, `OpenDate` ISO, `DepartmentName`, `OfficeName` free-text location, `ApplyUrl`, `OrganizationName`); dedup by job GUID via a `Set`
- **Tenant Resolution**: slug from `companySlug` or the `companyUrl` `/jobs/{slug}` path segment; unknown tenants return HTTP 400 and are handled gracefully as empty
- **Known Limitation**: WAF-gated tenants, server-side keyword/location filtering, structured-office lookup, and per-job detail enrichment (descriptions already in the feed) are non-goals (Spec 300)

---

### Niceboard

Hosted job-board platform; each board lives at `https://{slug}.niceboard.co`. Ever Jobs reads the **verified public board search feed** (the same call the board's SPA makes).

- **Method**: GET `https://{slug}.niceboard.co/api/jobs` with a fixed base query (JSON-encoded array filters + `custom_fields={}`), paginated by `limit`/`page`; remaining pages fanned out via bounded `Promise.allSettled`
- **Auth**: None (the credentialed `/api/v1/jobs?key=` private API is deliberately not used)
- **Data Format**: JSON `{ jobs, count }`; snake_case job objects with embedded `description_html`, `is_remote`, `apply_url`, `published_at`, nested `location.{city_long,state_long,country_long}`, `category.name`, `jobtype.name`
- **Tenant Resolution**: board sub-domain from `companySlug` or `companyUrl`; job-detail URL `/job/{id}-{slug}-{board}` (or `/job/{id}-{slug}` when `anonymity_enabled`)
- **Known Limitation**: server-side filtering and the credentialed private API are non-goals (Spec 301)

---

### GoHire

Hosted careers boards at `jobs.gohire.io`, keyed by an opaque client hash. Ever Jobs reads the **verified public widget feeds**.

- **Method**: list feed GET `https://api2.gohire.io/widget-jobs/{clientHash}` → `{ jobs: [...] }`; per-role detail GET `https://api.gohire.io/widget-job?clientHash={hash}&jobId={id}` hydrates the full HTML description + structured city/county/country via a bounded `Promise.allSettled` (max 8) fan-out
- **Auth**: None (a browser `User-Agent` header is required; the authenticated dashboard route is not used)
- **Data Format**: JSON; list rows carry `{id,title,location,salary,type,date,link}` (empty description), detail returns `{client:{name,country},title,type:{name},city,county,country:{code,name},description(HTML),salary}`
- **Tenant Resolution**: client hash from `companySlug` or `companyUrl`; unknown tenant returns `{}` (HTTP 200, no jobs) → empty
- **Known Limitation**: list-feed descriptions are empty, so detail hydration is mandatory for full descriptions (Spec 302)

---

### Recooty

Recruiting platform with hosted career pages. Ever Jobs reads the **verified public Job Widget feed**.

- **Method**: GET `https://standaloneapi.recooty.app/api/widget/{widgetId}?language=en` → one envelope `{ career_page_url, team:{ name, slug, jobPosts[] }, translation }`
- **Auth**: None — the 32-char hex widget id functions as a public read key supplied in the URL path
- **Data Format**: JSON; `team.jobPosts` rows (`id,title,slug,description,city,state,location_type,employment_type,department,published_at`); `location_type` ∈ `REMOTE/ON_SITE/HYBRID`, `employment_type` ∈ `FULL_TIME/PART_TIME/CONTRACTOR/INTERN/OTHER`
- **Tenant Resolution**: widget id from `companySlug` or the `companyUrl` `/widget/{id}` segment; job/apply URLs built from `career_page_url` + `team.slug` + `job.slug`; unknown id returns HTTP 422 → empty
- **Known Limitation**: requires the dashboard-issued widget id (not a human slug) (Spec 303)

---

### Polymer

Modern ATS/careers-page platform. Ever Jobs reads the **verified unauthenticated Public API** (documented at `developer.polymer.co`).

- **Method**: list feed GET `https://api.polymer.co/v1/hire/organizations/{slug}/jobs?page={n}&per_page=50` (paginated `{ items, meta }`, walked via `meta.is_last`); per-job detail GET `.../jobs/{id}` hydrates HTML description + department via a bounded (concurrency 5) fan-out
- **Auth**: None
- **Data Format**: JSON; snake_case (`id`, `hash_id`, `title`, `city`, `state_region`, `country`, `display_location`, `remoteness_pretty`, `kind_pretty`, `job_post_url`, `organization_name`, `job_category_name`, `published_at`); camelCase aliases modelled defensively
- **Tenant Resolution**: slug from `companySlug` or `companyUrl`; ATS id = numeric `id`, falling back to `hash_id`
- **Known Limitation**: list rows carry no description, so detail hydration is mandatory; a failed detail fetch keeps the role with a null description (Spec 304)

---

### VivaHR (AvaHR)

Multi-tenant ATS; public careers sites are server-rendered HTML at `https://jobs.avahr.com/{tenant}/jobs` (legacy `jobs.vivahr.com` 301-redirects after the AvaHR rebrand). No anonymous JSON API exists, so Ever Jobs scrapes the **verified public HTML + schema.org JSON-LD**.

- **Method**: GET the listing page to enumerate each role's `/{tenant}/{jobId}-{jobSlug}/` detail URL, then parse the `JobPosting` JSON-LD embedded in each detail page via a bounded `Promise.allSettled` fan-out
- **Auth**: None (the developer API and WordPress plugin both require a per-tenant API key and are intentionally not used)
- **Data Format**: schema.org JSON-LD (`title`, HTML `description`, `datePosted`, `employmentType`, `industry`, `identifier.value` job id, `hiringOrganization`, `baseSalary`, `jobLocation`, `jobLocationType` for remote)
- **Tenant Resolution**: `companySlug` is the full `{id}-{slug}` tenant token (e.g. `236-avahr`), or extracted from a `companyUrl`
- **Known Limitation**: anonymous surface is HTML-only (no JSON feed); descriptions require per-detail fetches (Spec 305)

---

### Occupop

Dublin-based ATS; tenant careers sites (`{slug}.occupop-careers.com`) are backed by a public Apollo GraphQL gateway. Ever Jobs reads the **verified unauthenticated GraphQL feed**.

- **Method**: POST `https://gateway.server.occupop.com/graphql`, operation `LiveJobs`, variables `{ companyKey: "{slug}", tags: [], includeAllBrandsJobs: false }` → `data.careersPage.liveJobs[]`
- **Auth**: None (the GraphQL query + gateway host were extracted verbatim from the careers SPA bundle; introspection is disabled)
- **Data Format**: JSON; `liveJobs` rows (`uuid`, `title`, HTML `description`, `publishedAt`, `companyName`, `location{city,country}`, `hiringCompany{name}`, `period` employment type, `subsectors[{name,sector{name}}]`)
- **Tenant Resolution**: `companyKey` from `companySlug`/`companyUrl`; apply page `https://{slug}.occupop-careers.com/jobs/{uuid}/apply`; unknown key returns a GraphQL error + `data:null` → empty
- **Known Limitation**: location exposes only city/country (no state); the REST `/rest/jobs` route requires a per-tenant token and is not used (Spec 306)

---

### JobAdder

ATS powering many hosted job boards. The structured v2 API requires OAuth2, so Ever Jobs scrapes the **verified anonymous hosted Careerpage HTML**.

- **Method**: GET `https://clientapps.jobadder.com/{accountId}/{slug}` (server-rendered HTML), parse each `job_items` card for title/jobId/date/location/employmentType/department, then lazily fetch each detail page `/{accountId}/{slug}/{jobId}/{titleSlug}` for the full description via a bounded `Promise.allSettled` fan-out
- **Auth**: None (the OAuth2 v2 jobs API and opaque-key JS widget endpoints are not used)
- **Data Format**: HTML (listing cards + detail-page description container)
- **Tenant Resolution**: tenant is an `{accountId}/{slug}` **pair** — `companySlug` must be `"{accountId}/{slug}"` (e.g. `84381/eq8-recruit`) or `companyUrl` a full Careerpage URL; a bare slug is rejected; unknown account/slug returns HTTP 404 → empty
- **Known Limitation**: listing-page only (multi-page pagination deferred — Q-044); the unlabelled listing `<ul>` is classified heuristically into classification/location/employmentType (Spec 307)

---

### Hireology

Multi-tenant SMB/automotive/healthcare careers platform at `careers.hireology.com/{slug}`. Ever Jobs reads the **verified public jobs feed**, bootstrapping the anonymous token the careers page mints.

- **Method**: scrape the careers shell for `window.startingData.apiToken` (an anonymous, short-lived public bearer minted into every careers page), then GET `https://api.hireology.com/v2/public/careers/{slug}?page={n}&page_size=50` with `Authorization: Bearer {token}` → `{ data, count, page, page_size }`; remaining pages fanned out via bounded `Promise.allSettled`
- **Auth**: None in practice — the bearer is not a private credential; it is minted unauthenticated into the public careers page and only authorizes the read-only public feed (re-scraped per run)
- **Data Format**: JSON; snake_case (`id`, `name`, `job_description` HTML, `created_at` ISO, `status`, `employment_status`, `remote`, `locations[].{city,state,zip_code,address}`, `organization.{id,name,type}`, `job_family.{id,name}`, `career_site_url`, `application_path`)
- **Tenant Resolution**: slug from `companySlug`/`companyUrl`; unknown tenant → HTTP 404 / no token → empty
- **Known Limitation**: depends on the public-token bootstrap remaining un-gated (Spec 308)

---

### Applied

Values-based hiring platform whose public org career pages live at `app.beapplied.com/org/{orgId}/{orgSlug}`. Applied exposes **no anonymous JSON API** (every `/api/v1/` path returns HTTP 401), so Ever Jobs reads the **verified public HTML** surface.

- **Method**: GET `https://app.beapplied.com/org/{orgId}/{orgSlug}` (org listing) → parse `/apply/{jobSlug}` anchors with `cheerio`, then bounded `Promise.allSettled` fan-out to each `https://app.beapplied.com/apply/{jobSlug}` detail page for title, company, location, salary, employment type and description
- **Auth**: None — public HTML only; all REST endpoints require authentication and are not used
- **Data Format**: HTML (no JSON-LD / stable class anchors; description uses a largest-prose-container heuristic)
- **Tenant Resolution**: `companySlug` in `{orgId}/{orgSlug}` form (e.g. `1549/citizens-uk`); a `companyUrl` whose path starts with `/org/` is also accepted
- **Known Limitation**: HTML-shape dependent; the numeric `orgId` must be supplied (slug-only paths return HTTP 404) (Spec 309)

---

### CATS

Recruiting ATS whose hosted public career portals live at `https://{slug}.catsone.com/careers/{portalID}-{name}`. The authenticated v3 REST API requires `Authorization: Token` and is not used; Ever Jobs reads the public server-rendered HTML.

- **Method**: GET `https://{slug}.catsone.com/careers/{portalID}-{name}?page={n}` → parse `.cats-job` listing cards with `cheerio` (three fallback selector layers), then per-job detail fetches at `/careers/{portalID}-{name}/jobs/{jobID}-{slug}` for descriptions; pagination via `?page=N`
- **Auth**: None — public portal HTML only
- **Data Format**: HTML (`.cats-job` / `.cats-job-title` / `.cats-job-location` / `.cats-job-category`)
- **Tenant Resolution**: `companySlug` (sub-domain label) or a `companyUrl` carrying the `/careers/{portalID}-{name}` path
- **Known Limitation**: HTML selector cascade is template-dependent (heuristic confidence); descriptions fetched per role (Spec 310)

---

### Recruit CRM

Recruiting-agency CRM/ATS whose public agency jobs pages live at `https://recruitcrm.io/jobs/{accountSlug}`. Ever Jobs calls the same anonymous backend endpoint the listing SPA uses.

- **Method**: POST `https://albatross.recruitcrm.io/v1/external-pages/jobs-by-account/get?account={accountSlug}&batch=true` with `Origin: https://recruitcrm.io` and JSON body `{ limit, offset, search_data: {}, onlyJobs: true }`; paginated by `offset` (exhausted when the returned array is shorter than `limit`) with bounded `Promise.allSettled`
- **Auth**: None — the credentialed `api.recruitcrm.io/v1/jobs` Bearer API is not used
- **Data Format**: JSON job objects with embedded HTML descriptions
- **Tenant Resolution**: `companySlug` (account slug, e.g. `Terra_Careers`) or `companyUrl`
- **Known Limitation**: no publish timestamp or category in the feed (`datePosted`/`department` are null); custom-domain tenants out of scope (Spec 311)

---

### Vincere

Recruitment-agency ATS/CRM whose public Instant Job Board is served at `https://{slug}.vincere.io/careers/`. Ever Jobs uses the same CSRF-gated AJAX endpoint the board calls — no secret API keys.

- **Method**: anonymous GET `/careers/` to obtain the per-session `X-CSRF-TOKEN` + `laravel_session` cookie, then page POST `https://{slug}.vincere.io/careers/ajax/search-jobs` (10/page) → `{ items, total, more }` with structured JSON (HTML descriptions, location, employment type, publish date)
- **Auth**: None secret — the CSRF token is obtained anonymously from the public careers page; the OAuth2 `/api/v2/job/search/` REST API is not used
- **Data Format**: JSON (`VincereJob` items)
- **Tenant Resolution**: `companySlug` (sub-domain label) or `companyUrl`
- **Known Limitation**: depends on the public Instant Job Board being enabled for the tenant (Spec 312)

---

### Factorial

HRIS platform with an integrated ATS that hosts public career pages for every tenant at `https://{slug}.factorialhr.com`. No anonymous JSON API exists; Ever Jobs reads the **verified public HTML** + sitemap.

- **Method**: GET `/` (index page — job metadata embedded in `data-controller="job-postings"` HTML attributes), GET `/sitemap.xml` for `lastmod` dates, and per-job detail pages at `/job_posting/{title-slug}-{id}` for the full HTML description (`div.styledText`) + apply URL; detail fan-out bounded by `Promise.allSettled` (concurrency 6)
- **Auth**: None — the OAuth2 `api.factorialhr.com/api/v1/ats/…` REST API is not used
- **Data Format**: HTML + XML sitemap
- **Tenant Resolution**: `companySlug` (sub-domain label) or `companyUrl`
- **Known Limitation**: N+1 detail fetches (no list-level descriptions) (Spec 313)

---

### Workstream

All-in-one HR/payroll/hiring platform for the hourly/deskless workforce. Public careers pages are served as HTML at `https://www.workstream.us/j/{accountId}/{brandSlug}`. No anonymous JSON API; Ever Jobs reads the public HTML.

- **Method**: GET `https://www.workstream.us/j/{accountId}/{brandSlug}/positions` → extract job href links, then bounded `Promise.allSettled` fan-out to each `/j/{accountId}/{brandSlug}/{locationSlug}/{jobSlug}-{jobId}?locale=en` detail page; `atsId` is the 8-char hex suffix of the job path
- **Auth**: None — the OAuth2 `public-api.workstream.us` REST API is not used
- **Data Format**: HTML
- **Tenant Resolution**: `companySlug` in `{accountId}/{brandSlug}` form (e.g. `36047dd7/jamba`); callers must know the account UUID
- **Known Limitation**: `datePosted` not exposed (null); UUID discovery for new tenants out of scope (heuristic confidence) (Spec 314)

---

### Harri

All-in-one workforce-management and talent-acquisition platform for the hospitality/service industries. Employer careers pages are public HTML at `https://harri.com/{employerSlug}`. No anonymous JSON API; Ever Jobs reads the public HTML.

- **Method**: GET `https://harri.com/{employerSlug}` → parse job href links matching `/{slug}/job/{jobId}-{titleSlug}`, then bounded `Promise.allSettled` fan-out to each detail page for title/location/description via Open Graph meta tags + heuristic HTML extraction
- **Auth**: None — Harri's underlying REST API is not used
- **Data Format**: HTML (Open Graph meta tags)
- **Tenant Resolution**: `companySlug` (employer slug) or `companyUrl`
- **Known Limitation**: `datePosted` always null; detail parsing heuristic (heuristic confidence) (Spec 315)

---

### Tribepad

UK enterprise ATS powering large public- and private-sector career sites. Each tenant site is public at `https://{slug}.tribepad-gro.com` (Gro tier) or a custom domain. No anonymous JSON API; Ever Jobs reads the public sitebuilder HTML.

- **Method**: GET `https://{slug}.tribepad-gro.com/v2/job/search?page={n}&records_per_page={size}` → parse `.sitebuilder-job-results-item` cards with `cheerio`, then per-job detail fetches at `/members/modules/job/detail.php?record={id}` for the full HTML description; pagination via `?page=N`
- **Auth**: None — public HTML only
- **Data Format**: HTML (stable sitebuilder v2 template; Font Awesome icon-keyed location/salary/type/date fields)
- **Tenant Resolution**: `companySlug` (→ `{slug}.tribepad-gro.com`) or `companyUrl` (origin used verbatim for custom domains)
- **Known Limitation**: detail-page failures degrade gracefully to listing-level data (Spec 316)

---

### Eploy

UK recruitment platform used by councils, NHS trusts, police services and private employers. Each tenant career site exposes a **public, anonymous XML datafeed** (the same feed customers use to syndicate roles to job boards).

- **Method**: GET `{tenantUrl}/feeds/datafeed.ashx?Format=xml` → single XML document (`<Vacancies Count="N">` / `<Item>` children) parsed with `cheerio` in `xmlMode`; no pagination (all open roles in one document)
- **Auth**: None — the OAuth2 `/api/vacancies/search` REST API is not used
- **Data Format**: XML (PascalCase elements)
- **Tenant Resolution**: `companyUrl` (custom domain, e.g. `https://jobs.islington.gov.uk`, stripped to scheme+host) or `companySlug` (bare hostname, or staging sub-domain under `eploy.net`)
- **Known Limitation**: `<Company>` often empty for single-employer portals (company name derived from the tenant URL/slug) (Spec 317)

---

### Oorwin

Cloud staffing & talent-management platform (ATS + CRM + HRMS). Each tenant is served from its own sub-domain under `oorwin.com` (e.g. `purpledrive.oorwin.com/careers/`) via two anonymous POST endpoints.

- **Method**: POST `https://api.oorwin.ai/api/v2/careers/getJobList` with body `{ sub_domain, limit, page, order, sort, list_type, getDefaultData }` for paginated summaries (total from the first response), then per-job POST `https://api.oorwin.ai/api/v2/careers/job_view` with `{ sub_domain, job_id, view_type }` for the HTML description; detail fan-out bounded by `Promise.allSettled`
- **Auth**: None — both endpoints are anonymous
- **Data Format**: JSON (listing rows carry no description — two-stage fetch required)
- **Tenant Resolution**: `companySlug` used directly as `sub_domain`, or the first sub-domain label of `companyUrl`
- **Known Limitation**: large tenants page deeply (capped by `resultsWanted`); remote detection via `remote_status === 'Remote'` (Spec 318)

---

### Ceipal

US staffing & talent-acquisition ATS. Public career portals are powered by an anonymous, key-scoped REST API where the tenant's career-portal API key is carried in the URL path.

- **Method**: GET `https://api.ceipal.com/{apiKey}/job-postings/?page={n}` (DRF pagination envelope `{results,count,num_pages,page_number,next,previous}`) + per-job GET `https://api.ceipal.com/{apiKey}/job-postings/{id}/` fetched only when a listing row lacks a description
- **Auth**: None — the career-portal key authorises the read; it is masked in logs. The credentialed v1 ATS API (`/v1/getJobPostingsList`, `Authorization: Token`) is not used
- **Data Format**: JSON
- **Tenant Resolution**: career-portal API key via `companySlug` (or parsed from `companyUrl`)
- **Known Limitation**: `heuristic` confidence — wire shape derived from the platform's public reference client; tenant keys rotate (Spec 319, Q-049)

---

### Softgarden

German ATS. Modern React career pages expose a public schema.org job feed; no credentials required.

- **Method**: GET `{tenantOrigin}/jobs.feed.json` — a schema.org `DataFeed` of `JobPosting` items with inline HTML descriptions; one call per tenant (no detail fan-out)
- **Auth**: None — the documented v2/v3 jobboard REST APIs require a client token + `channelId` and are not used
- **Data Format**: JSON (schema.org)
- **Tenant Resolution**: `companyUrl` (origin) or `companySlug` → `{slug}.career.softgarden.de`
- **Known Limitation**: legacy Wicket boards lack the feed and degrade to empty; `department` approximated from `employmentType` (Spec 320, Q-050)

---

### Recruitis

Czech ATS. The public career site is server-rendered HTML, scraped with `cheerio`.

- **Method**: GET `https://jobs.recruitis.io/{tenant}?page={n}` (`div.row.job` blocks; pagination ends on a `--disabled` next link) + per-job `#job-description` detail fan-out (`Promise.allSettled`)
- **Auth**: None — the token-gated `app.recruitis.io/api2/jobs` REST API is not used
- **Data Format**: HTML
- **Tenant Resolution**: `companySlug` (tenant label) or `companyUrl`
- **Known Limitation**: `datePosted` null (no machine-readable date in public HTML); chips are Czech-localised (Spec 321, Q-051/Q-052)

---

### Flatchr

French ATS. A single public JSON endpoint returns the full vacancy catalogue inline.

- **Method**: GET `https://careers.flatchr.io/company/{slug}.json` → `{items:[...]}` with full inline vacancy records (description + mission + profile HTML, structured address, contract, salary, remote) — exactly one network call per tenant
- **Auth**: None
- **Data Format**: JSON
- **Tenant Resolution**: `companySlug` (tenant label) or `companyUrl`
- **Known Limitation**: French-language HTML passed through verbatim; pagination not needed (full set in one document) (Spec 322)

---

### Jobsoid

Recruitment ATS. Each tenant exposes a public anonymous JSON feed.

- **Method**: GET `https://{tenant}.jobsoid.com/api/v1/jobs` — flat array of full job objects (inline HTML description, structured location, `function.title`→department, `hostedUrl`/`applyUrl`); results sliced client-side and de-duped by id
- **Auth**: None
- **Data Format**: JSON
- **Tenant Resolution**: `companySlug` (tenant sub-domain) or `companyUrl`
- **Known Limitation**: the feed ignores `offset`/`limit` (full set returned); remote is heuristic (no dedicated flag) (Spec 323)

---

### Skeeled

Luxembourg-based ATS. Public board pages embed all offers in an SSR Nuxt data island.

- **Method**: GET `https://app.skeeled.com/board/{boardId}` — offers parsed from `<script id="__NUXT_DATA__">` (flattened-reference JSON); i18n title/description resolver (en→fr→nl→de→first) with an `a[href*="/offer/c/"]` HTML-card fallback
- **Auth**: None — the documented REST API is credentialed and not used
- **Data Format**: HTML / embedded JSON
- **Tenant Resolution**: 24-hex board id via `companySlug` or `companyUrl` (`.../board/{id}`)
- **Known Limitation**: `datePosted` null; company name derived from the logo asset / board id (Spec 324, Q-052)

---

### Teamdash

Estonian recruitment ATS. The public career page is the only anonymous surface — no JSON API exists.

- **Method**: GET `https://{tenant}.teamdash.com/p/job/{landingToken}/{slug}` — jobs read from an inline `window.context` JSON blob (career-page feed + per-posting `landing.data.blocks[]` HTML), extracted via a depth-tracking brace scan
- **Auth**: None
- **Data Format**: HTML / embedded JSON
- **Tenant Resolution**: `companyUrl` is reliable; `companySlug`-only is best-effort (opaque landing token)
- **Known Limitation**: `department` = pipeline `stage.name`; multi-language postings resolve to default→en→first (Spec 325, Q-053)

---

### DigitalRecruiters

French ATS (career-site platform). A public REST API serves paged job ads.

- **Method**: POST `https://api.digitalrecruiters.com/public/v1/careers-site/job-ads?domainName={domain}&page={p}&locale={loc}` (paged) + per-job `GET .../job-ads/{job_ad_id}` detail; a config endpoint resolves the canonical career domain and a **region-qualified** locale (a bare `iso_code` is rejected HTTP 400)
- **Auth**: None
- **Data Format**: JSON (+ JSON-LD on detail)
- **Tenant Resolution**: `{tenant}.digitalrecruiters.com` sub-domain or custom `companyUrl`
- **Known Limitation**: default-locale-only ingestion (multi-locale deferred); detail takes the numeric `job_ad_id` (Spec 326, Q-054)

---

### Concludis

German e-recruiting ATS. The public listing is server-rendered HTML with schema.org detail enrichment.

- **Method**: GET `https://{tenant}.concludis.de/prj/lst/{hash}/...htm?page={n}` (`cheerio` rows `div[id=line_{oid}]`; total from `div.stellensum`; 25/page) + best-effort per-job detail parsing schema.org JSON-LD (`Promise.allSettled`, concurrency 6)
- **Auth**: None
- **Data Format**: HTML (+ JSON-LD detail)
- **Tenant Resolution**: `companySlug` (sub-domain) or `companyUrl`; root redirects to the shared listing-view hash
- **Known Limitation**: detail pages are tenant-variable / session-gated — a role is never dropped for missing enrichment (Spec 327, Q-055)

---

### rexx systems

German HR/recruiting suite. No anonymous feed exists, so the public job market is scraped and enriched via schema.org JSON-LD.

- **Method**: GET `https://{tenant}-portal.rexx-systems.com/stellenangebote.html` (`cheerio` `article.joboffer_container` + `data-count`) then per-job detail fan-out (`Promise.allSettled`, max 6/round, 250 ms delay) extracting the embedded schema.org `JobPosting` JSON-LD
- **Auth**: None — probed XML/RSS export paths all 404
- **Data Format**: HTML (+ JSON-LD detail)
- **Tenant Resolution**: `companySlug` (auto-appends the `-portal` host suffix) or `companyUrl`
- **Known Limitation**: only the first listing page is parsed; custom-domain portals assumed to share the path/JSON-LD shape (Spec 328, Q-056)

---

### PCRecruiter

US staffing ATS (Main Sequence). Public job boards are server-rendered HTML with schema.org detail.

- **Method**: GET `https://www2.pcrecruiter.net/pcrbin/jobboard.aspx?uid={DisplayName}.{db}` (`cheerio` `table#joblist` rows) + per-job `?action=detail&recordid={id}` whose schema.org `JobPosting` JSON-LD is the primary field source (`#jobdesc` marker-comment HTML as fallback)
- **Auth**: None
- **Data Format**: HTML (+ JSON-LD detail)
- **Tenant Resolution**: `uid` (`{DisplayName}.{database}`) via `companySlug` or full `companyUrl`
- **Known Limitation**: stateful `pcr-id`-token pagination replicated best-effort, bounded by `MAX_PAGES=20`, page-1 always retained (Spec 329, Q-057)

---

### Prescreen

Austrian ATS (part of the onlyfy/XING group). The candidate portal is server-rendered HTML; the host has rebranded to `onlyfy.jobs`.

- **Method**: GET `https://{handle}.onlyfy.jobs/` (`#jobList` rows) + `/job/{token}` schema.org JSON-LD + `/job/show/{token}/full?lang=en` description fragment
- **Auth**: None — the retired `prescreenapp.io` JSON feed and credentialed `api.prescreenapp.io` are not used
- **Data Format**: HTML (+ JSON-LD detail)
- **Tenant Resolution**: `handle` (sub-domain label) via `companySlug` or `companyUrl`; legacy `jobbase.io`/`prescreenapp.io` hosts 301-redirect here
- **Known Limitation**: host-rebrand churn; single listing page observed; description served in the tenant's language when `lang=en` is unavailable (Spec 330, Q-058)

### Gusto Hosted

Multi-tenant job-board product hosted by Gusto (the payroll/HR vendor) at `jobs.gusto.com` for other companies. **Distinct from `source-company-gusto`**, which scrapes Gusto, Inc.'s OWN Greenhouse-backed careers (a single employer) and is left untouched — the two share a vendor name but are different targets (Spec 5054).

- **Plugin**: `source-ats-gusto-hosted` (`Site.GUSTO_HOSTED = 'gusto_hosted'`)
- **Method**: stealth headless browser (`BrowserPool.getPage({ proxy, stealth: true })`) → GET `/boards/{slug}` (enumerate `/postings/{postingSlug}` links) + GET `/postings/{postingSlug}` (bounded fan-out) → shared `parseJobPostingLd` (Spec 5022)
- **Data Format**: HTML + schema.org `JobPosting` JSON-LD (title, description, datePosted, employmentType, hiringOrganization, location, baseSalary)
- **Tenant Resolution**: board slug `<company>-<uuid>` via `companySlug`, or a `jobs.gusto.com/boards/<slug>` `companyUrl`
- **Cloudflare**: both pages sit behind a Cloudflare managed challenge (plain HTTPS is 403'd `cf-mitigated: challenge`), so a real stealth browser clears it — same pattern as `source-company-desktopmetal` (Spec 5047). If the challenge is not cleared → `[]`; the plugin NEVER falls back to another company's board.
- **Known Limitation**: live board/posting HTML capture deferred (the Turnstile challenge loops on a datacenter IP); board enumeration is anchored on the stable `/postings/{slug}` link shape and detail parsing on the stable JSON-LD contract (Spec 5054, `questions.md`)

---

## Architecture

Each ATS integration is an independent NestJS package following the `IScraper` interface:

```
packages/source-ats-{name}/
  src/
    index.ts              # Public exports
    {name}.module.ts      # NestJS module
    {name}.service.ts     # IScraper implementation
    {name}.constants.ts   # API URLs, headers
    {name}.types.ts       # Response type definitions
```

All ATS services are registered in `JobsService.ATS_SITES` and included in the scraper map, ensuring they run automatically when `companySlug` is provided.

---

## Adding a New ATS Integration

See [PRD_NEW_JOB_SOURCES.md](PRD_NEW_JOB_SOURCES.md) for the step-by-step guide to implementing a new source. The key steps are:

1. Create `packages/source-ats-{name}/` with the standard file structure
2. Implement the `IScraper` interface in the service
3. Add the `Site` enum entry in `packages/models/src/enums/site.enum.ts`
4. Register the path in `tsconfig.base.json`
5. Import the module in `apps/api/src/jobs/jobs.module.ts` and `apps/cli/src/cli.module.ts`
6. Wire it into `JobsService` (constructor, scraper map, `ATS_SITES` set)
