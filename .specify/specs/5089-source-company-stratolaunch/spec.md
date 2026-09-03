# Spec: 5089 — Source Company Plugin: Stratolaunch

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 5089                                                    |
| Slug           | source-company-stratolaunch                             |
| Status         | in progress                                             |
| Owner          | agent                                                   |
| Created        | 2026-08-30                                              |
| Last updated   | 2026-08-30                                              |
| Supersedes     | (none)                                                  |
| Related specs  | 5087, 5088                                              |

## 1. Problem Statement

Stratolaunch's public careers page is a Craft CMS + Sprig filtered listing, but the
underlying job data is hosted on a Greenhouse board (`stratolaunch`). Callers that
address the plugin by the company's domain (`stratolaunch.com`) currently fail to
resolve a scraper because no plugin declares that domain.

## 2. Goals

- Add a `source-company-stratolaunch` plugin that exposes `Site.STRATOLAUNCH` and
  declares `companyDomains: ['stratolaunch.com']`.
- Ingest all live open roles from the public Greenhouse Job Board API.
- Emit normalized `JobPostDto`s with title, location, department, description,
  apply URL, and `datePosted`.

## 3. Non-Goals

- No generic Craft CMS / Sprig parser; this is a company-specific plugin.
- No changes to the Greenhouse ATS plugin or to `ScraperInputDto`.
- No headless-browser fallback.

## 4. Design

### 4.1 Source endpoint

`GET https://api.greenhouse.io/v1/boards/stratolaunch/jobs?content=true`

The `content=true` parameter returns the full HTML description for each posting,
avoiding a second detail fetch.

### 4.2 Input resolution

The plugin resolves the Greenhouse board token in priority order:

1. `input.companySlug` if provided.
2. A board slug extracted from `input.companyUrl` if it matches a Greenhouse
   `job-boards.greenhouse.io` or `boards.greenhouse.io` path.
3. Hardcoded fallback `stratolaunch`.

This keeps the plugin reachable by both `companyDomain` and explicit
`companyUrl`/`companySlug` inputs.

### 4.3 Output mapping

For each job returned by the API:

- `id`: `stratolaunch-{job.id}`
- `site`: `Site.STRATOLAUNCH`
- `title`: `job.title` trimmed of surrounding whitespace.
- `companyName`: `job.company_name` or `'Stratolaunch'`.
- `jobUrl` / `applyUrl`: `job.absolute_url`, falling back to
  `https://job-boards.greenhouse.io/stratolaunch/jobs/{id}`.
- `location`: `new LocationDto({ city: job.location.name })`.
- `department`: `job.departments[0].name` trimmed, or `null`.
- `description`: `stripHtmlTags(decodeHtmlEntities(job.content))`.
- `datePosted`: `job.first_published` preferred over `job.updated_at`.
- `isRemote`: `true` when the `Work Location` metadata contains `'Remote'` or
  the location name contains `'remote'`.

### 4.4 Filtering

Honour `resultsWanted`, `searchTerm` (title and department), and `location`
(location name substring) filters already present in `ScraperInputDto`.

### 4.5 Error handling

Wrap the full scrape in `try/catch`, classify failures with
`classifyScrapeError`, and return a `JobResponseDto` (possibly empty) rather
than throwing. This preserves the contract used by the rest of the source
plugins.

## 5. Acceptance

- `StratolaunchService` registers as a NestJS provider through
  `StratolaunchModule`.
- `Site.STRATOLAUNCH` resolves to `'stratolaunch'`.
- A mocked Greenhouse API fixture of 55 jobs yields 55 `JobPostDto`s.
- `resultsWanted`, `searchTerm`, and `location` filters behave as specified.
- The emitted `description` contains neither HTML tags nor encoded entities such
  as `&lt;` or `&amp;`.
- `tsc --noEmit` is clean for the package.
- The `source-company-stratolaunch` Jest suite passes.

## 6. Risks

- If Stratolaunch moves off Greenhouse, the plugin will return 0 jobs and
  callers should fall back to a manual/source update.
- The `content` field can be large; the plugin streams the JSON through the
  shared `HttpClient` with the default timeout.
