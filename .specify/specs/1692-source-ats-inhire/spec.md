# Spec: 1692 — Source ATS Plugin: InHire (inhire.app, Brazil)

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1692                                     |
| Slug           | source-ats-inhire                        |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 5082, 1688, 1689, 1695, 1696, 1697, 1699 |

## 1. Problem Statement

InHire (inhire.app) is a Brazilian applicant-tracking system. Every customer company (a
"tenant") has a hosted career page at `https://{tenant}.inhire.com.br/vagas`, and those pages
load their openings from a public, unauthenticated JSON API on one shared origin,
`https://api.inhire.app`, selecting the tenant with an `X-Tenant` request header.

We had no adapter for it: no `source-ats-inhire` package, no `inhire` token anywhere in the
repository and no `Site` value for it (`siteFromDomain('inhire.app')` derives `inhire_app`, which
nothing uses, so a new `inhire` token cannot collide). The only Brazilian ATS plugins were
`source-ats-gupy` and `source-ats-solides`, so every InHire customer was invisible to a search.

## 2. Goals

- One generic, multi-tenant plugin that ingests a tenant's open roles from `companySlug` or
  `companyUrl` and maps them to `JobPostDto`.
- Honest, bounded crawling: an identifiable User-Agent, one fixed origin, requests paced across
  the whole process, detail records fetched one at a time by default, hard caps on list rows and
  detail calls.
- Degrade like the sibling ATS adapters: `scrape()` never throws; a failed call yields partial
  results plus a `ScrapeDiagnostics`.
- Correct Brazilian data: accents decoded, Brazilian state codes never read as countries, contract
  labels (`CLT`, `PJ`, `Estágio` …) mapped to job types, no Brazilian-real salary read as USD.

## 3. Non-Goals

- Applying to jobs, candidate accounts, or any authenticated API.
- A seed list of tenants (tenant discovery belongs to the source-adoption backlog).
- Registration in `Site`, `packages/plugins/index.ts`, `tsconfig.base.json` and `jest.config.js`
  (done by the integrator after this lane; see §7.4).
- Extending `resolveCompanyUrl`: its map is built for `/{slug}` path boards, and InHire tenants
  are sub-domains, so the plugin parses its own `companyUrl` (as Gupy does).

## 4. User / Caller Stories

> As an **API caller**, I want **`{"siteType":["inhire"],"companySlug":"olist"}`** to return that
> company's open roles, so that **InHire-hosted boards are searchable like any other ATS**.

> As an **operator**, I want **a failed or partial InHire scrape to say why**, so that **an empty
> result is never mistaken for an empty board**.

> As **the site owner**, I want **the plugin to identify itself and space its requests**, so that
> **our API is not hammered by an aggregator**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Tenant from `companySlug`: a bare slug (`olist`, `ACME-BR`), a tenant host (`olist.inhire.app`) or a URL on `*.inhire.app` / `*.inhire.com.br`. The tenant is the single label before the suffix, lower-cased, matching `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, not `api` / `files` / `www` (`portal` is a real tenant). | must |
| FR-2  | Tenant from `companyUrl` (used when `companySlug` is empty): only `*.inhire.app` / `*.inhire.com.br` hosts; a bare word is refused. The URL is **never fetched**. | must |
| FR-3  | Missing or invalid tenant input (whitespace, control characters, credentials, a port, a foreign host) returns `[]` with `bad_input` and makes **no request**. | must |
| FR-4  | Every request is a `GET` to `https://api.inhire.app/job-posts/public/pages/…` with `X-Tenant: <tenant>` and `Accept: application/json`; any other path is refused. Redirects are pinned to `api.inhire.app`. | must |
| FR-5  | List: `GET …/pages/lean` once (not paginated). At most 500 rows are considered (logged when more). Rows without a UUID `jobId` or a title are dropped; rows are de-duplicated by `jobId` in first-seen order. | must |
| FR-6  | `searchTerm` filters the **list title** before any detail call: case- and accent-insensitive, every whitespace-separated word must appear (`senior` matches `Sênior`). | must |
| FR-7  | Detail: `GET …/pages/{jobId}` in list order until `offset + resultsWanted` roles match, the detail budget is spent, or the list ends. Budget: 50 by default, 25 for `descriptionDepth: 'detail-25'`, 200 for `'detail-all'` (hard ceiling 200). | must |
| FR-8  | `descriptionDepth: 'board'` makes no detail call and emits title, URLs and company only; `location` / `isRemote` / `jobType` / `hoursOld` are then not evaluated (a warning is logged). | must |
| FR-9  | Only `status: "published"` roles are emitted (a missing status is accepted); other statuses are skipped and counted. | must |
| FR-10 | Post-detail filters: `location` (every comma part of the needle in the label or parsed city/state/country, accent-free, `Brasil` = `Brazil`); `isRemote` only when `=== true`; `jobType` (a role with no mapped type passes); `hoursOld` against the latest instant the posting time allows (a role with no date passes). `country` is ignored. | must |
| FR-11 | `offset` / `resultsWanted` apply to the filtered sequence in list order; `resultsWanted` defaults to 100 when unset and `0` returns `[]` with no request. | must |
| FR-12 | Output mapping per §7.1. | must |
| FR-13 | Degradation per §7.2. `scrape()` never throws. | must |
| FR-14 | One summary log line per scrape: `InHire(<tenant>): list= candidates= details=<ok>/<tried> skipped{status,invalid,dupe} removed= failed= filtered= unfetched= truncated= returned=`. | should |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Detail requests in flight per scrape | 1 by default; ≤ 2 with `INHIRE_DETAIL_CONCURRENCY=2` |
| NFR-2  | Gap between request starts to `api.inhire.app`, across every worker and every concurrent scrape in the process | ≥ 500 ms (raisable, never lowered) |
| NFR-3  | Requests per default scrape (`resultsWanted` = 15, no filters) | 1 list + 15 detail calls |
| NFR-4  | Per-request timeout | ≤ 15 s (a caller may only shorten it) |
| NFR-5  | User-Agent | `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)`; no browser UA, no client-identification or `sec-*` header |
| NFR-6  | Unit tests | no network; fixtures synthetic (fictitious tenant `acme-br`, fake UUIDs) |

## 7. Contracts

### 7.1 Output mapping

| `JobPostDto` | Source |
| ------------ | ------ |
| `id` / `atsId` / `atsType` / `site` | `inhire-{jobId}` / `jobId` / `inhire` / `inhire` |
| `title` | `detail.displayName`, else the list title; trimmed, whitespace collapsed |
| `companyName` | `detail.tenantName`, else the de-slugified tenant (`acme-br` → `Acme Br`) |
| `jobUrl` = `applyUrl` | the list `link` when it is https on `{tenant}.inhire.com.br` / `{tenant}.inhire.app` exactly (`pinUrlToHosts`, no credentials, no port), else `https://{tenant}.inhire.com.br/vagas/{jobId}` |
| `companyUrl` | origin of `jobUrl` + `/vagas` |
| `description` | `detail.description` per `descriptionFormat`: HTML as sent; MARKDOWN (default) via `markdownConverter`; PLAIN via `htmlToPlainText` after named entities (`&atilde;`) are decoded |
| `emails` | `extractEmails` over the plain-text description |
| `companyDescription` | plain text of `detail.about` |
| `companyLogo` / `bannerPhotoUrl` | `detail.logo` / first https entry of `detail.background`; public https hosts only |
| `datePosted` (+ `datePostedAt`, `datePostedPrecision`, `datePostedBasis`) | `postedTimeFields(postedFromTimestamp(publishedAt ?? createdAt ?? lastPublishedAt))` (Spec 1696) |
| `isRemote` / `workFromHomeType` | `workplaceType`: `Remote`/`Remoto` → `true` / `Remote`; `Hybrid`/`Híbrido` → `false` / `Hybrid`; else `false` / null |
| `location` / `locations` | `parseLocationList([label])`, label per §7.3 |
| `countryCode` | the ISO code when `detail.location` is one (`BR`); `BR` when the label is (or was completed as) Brazilian; else null |
| `employmentType` | `contractType` labels joined, e.g. `CLT` |
| `jobType` | §7.5; null when nothing maps |
| `compensation` / `salarySource` | `resolveCompensation({ text })` over the plain description **unless it contains `R$` / `BRL`**; `salarySource: 'description'` when set |
| `department` | null (the API has none) |

Board mode (`descriptionDepth: 'board'`): `id`, `atsId`, `atsType`, `site`, `title` (list),
`companyName` (de-slugified tenant), `jobUrl` = `applyUrl`, `companyUrl`; `description` and
`datePosted` null, `isRemote` null (unknown, not "false").

### 7.2 Errors

| Situation | Response |
| --------- | -------- |
| No `companySlug` / `companyUrl`, or an invalid tenant | `[]` + `bad_input`, no request |
| List call throws (403, network, timeout …) | `[]` + `classifyScrapeError(err)` |
| List body is not a JSON array | `[]` + `fetch_error` (detail = the body's `message`, ≤ 200 chars, when present) |
| List is `[]` | `[]`, no diagnostic (inferred `empty`) |
| Detail 404 | role skipped, no diagnostic (removed after the list call) |
| Detail transport error / 5xx after the client's retries | role skipped; the first failure becomes the response's diagnostic (`classifyScrapeError`) — jobs + diagnostic is inferred `partial`; no jobs + diagnostic reports why |
| Detail body not an object, or `jobId` of another role | role skipped; `fetch_error` diagnostic as above |
| `status` other than `published` | role skipped silently, counted |

### 7.3 Location label

1. `raw = detail.location`, `extra = detail.locationComplement`, both trimmed.
2. `raw` is a two-letter ISO code that resolves (`BR`): the label is `raw` and `countryCode = raw`;
   with a complement, the label is `<complement parts>, <country name>`.
3. Otherwise ` - ` / ` – ` / ` — ` / `/` become commas, `Brasil` becomes `Brazil`, workplace words
   (`Remoto`, `Remote`, `Híbrido`, `Hybrid`, `Presencial`, `On-site`) are dropped, parts of
   `raw` and `extra` are joined and de-duplicated. `, Brazil` is appended unless the label already
   names a country — and a trailing Brazilian state code (`PR`, `RS`, `SC`, `ES`, `PE` … several are
   also ISO country codes) never counts as one.
4. Nothing left: no location.

### 7.4 Registration (for the integrator)

| Item | Value |
| ---- | ----- |
| `Site` enum (append at the end) | `// Phase 1692: Spec 1692 — Source ATS Plugin: InHire (inhire.app) — public job-posts JSON API keyed by X-Tenant header` then `INHIRE = 'inhire',` |
| Module / service | `InhireModule` / `InhireService` from `./source-ats-inhire` |
| `packages/plugins/index.ts` | `import { InhireModule } from './source-ats-inhire';` and `InhireModule,` in the modules array, next to the other `source-ats-*` entries |
| `tsconfig.base.json` paths | `"@ever-jobs/source-ats-inhire": ["packages/plugins/source-ats-inhire/src/index.ts"]` |
| `jest.config.js` moduleNameMapper | `'^@ever-jobs/source-ats-inhire$': '<rootDir>/packages/plugins/source-ats-inhire/src/index.ts'` |
| After registration | replace `INHIRE_SITE` (`'inhire' as Site` in `inhire.constants.ts`) by `Site.INHIRE`, and the specs' `SITE` constant likewise |

### 7.5 Contract labels → `JobType`

| Label (case- and accent-insensitive) | JobType |
| ------------------------------------ | ------- |
| `CLT`, `Efetivo`, `Trainee` | FULL_TIME |
| `PJ`, `Freelancer`, `Autônomo`, `Cooperado` | CONTRACT |
| `Estágio` | INTERNSHIP |
| `Aprendiz`, `Jovem Aprendiz` | APPRENTICESHIP |
| `Temporário` | TEMPORARY |
| anything else | `getJobTypeFromString(label)`, ignored when null |
| title matching `estagio` / `estagiario(a)` / `intern(ship)` | + INTERNSHIP |

### 7.6 Configuration

| Env var | Default | Effect |
| ------- | ------- | ------ |
| `INHIRE_DETAIL_CONCURRENCY` | `1` | detail requests in flight per scrape; clamped to 1–2 |
| `INHIRE_MIN_INTERVAL_MS` | `500` | minimum gap between request starts to the API host; values below 500 are raised to 500, capped at 60 000 |

## 8. Test Plan

- Unit, `__tests__/inhire.helpers.spec.ts` (109 cases): tenant parsing (accepted and refused
  forms), list cleaning and cap, title search, URL pinning, https image URLs, entity decoding,
  location labels (incl. a parser round-trip proving `PR` / `RS` / `SC` / `ES` stay states),
  location matching, contract-type table, workplace flags, freshness instant, detail budget,
  env parsing, body helpers.
- Unit, `__tests__/inhire.service.spec.ts` (68 cases, mocked HTTP client, virtual clock): tenant
  input and `bad_input` with no request; fixed origin + `X-Tenant` + honest client options; full
  mapping of role 1; locations; contract types; closed / invalid / duplicate rows; hostile link;
  fallbacks; the three description formats; the salary guard with a positive control; all filters;
  paging, refill past a closed role, budgets (25 / 50 / 200) and the 500-row cap; board mode;
  every degradation path; pacing, the concurrency ceiling, the interval floor and one queue shared
  by two concurrent scrapes.
- Mutation checks run once by hand: disabling the salary guard, the pacer, the sequential default,
  the `isRemote === true` rule or the link pin each turns at least one case red.
- Network E2E, `__tests__/inhire.e2e-spec.ts`, opt-in with `RUN_NETWORK_E2E=1`: tenant `olist`
  (shape checks when jobs return), no tenant, `companyUrl`, unknown tenant. Run once on
  2026-09-25: 4/4.

## 9. Open Questions

- Q2 — multi-career-page tenants: verify `GET /job-posts/public/pages/careerPage/{careerPage}` and
  whether the lean list already spans non-default pages (every row carries its own
  `careerPageId`, which suggests it does). Optionally accept `tenant/careerPage` as a slug.
- Q3 — robots on tenant hosts (`{tenant}.inhire.com.br/robots.txt`): informational only, those
  hosts are never fetched.
- A two-letter `location` that is both an ISO country and a Brazilian state (`PR`, `ES`, `PE` …)
  is read as the country, as `BR` is. Revisit if a tenant is seen using state codes there.
- Follow-ups in shared code: BRL support in the salary parser (then drop the `R$` guard); a
  `Brasil` alias in the location parser (then drop the plugin-local rewrite); declare the crawl
  limits on `@SourcePlugin` once the metadata has a field for them (done at the Spec 1690 merge (`feat/http-politeness`, 2026-09-26):
  `INHIRE_CRAWL_POLICY` = `{ maxConcurrentPerHost: 2, minIntervalMs: 500 }`; the module-level
  slot reservation stays).

## 10. Decisions

- **Sequential by default.** The crawl policy this branch ships with fetches detail pages one after
  another, so the default is 1 in flight. The two-worker pool of the design stays available through
  `INHIRE_DETAIL_CONCURRENCY=2`; nothing higher is accepted.
- **Pacing is process-wide.** All tenants share one API host, so the 500 ms gap is kept by a
  module-level slot reservation (synchronous, so concurrent callers queue) rather than per scrape.
  The shared client's own rate delay reads its last-request time without a lock and races under
  overlap; a caller's `rateDelayMin` still applies on top.
- **Walk until enough match, in every mode.** Details are fetched in list order until
  `offset + resultsWanted` roles are accepted, with or without filters. With no filter and no
  skipped role this is exactly `offset + resultsWanted` detail calls; a closed or removed role in
  the window is replaced by the next one instead of shortening the page.
- **Every non-array list body is `fetch_error`**, not only a `{message}` object: a silent empty
  result would hide a shape change.
- **Detail shape errors are `fetch_error`** (a non-object body, a record for another role); transport
  errors go through `classifyScrapeError`.
- **A missing `status` is accepted**; only an explicit non-`published` status is skipped.
- **Entities are decoded before plain-text conversion.** The shared `htmlToPlainText` only knows a
  handful of entities, and the API entity-encodes every accent (`miss&atilde;o`); the HTML is
  round-tripped through cheerio first, which rewrites named entities as characters and keeps
  `&amp;` / `&lt;` / `&gt;` escaped.
- **`Aprendiz` / `Jovem Aprendiz` → APPRENTICESHIP** (the design said INTERNSHIP): Spec 1697 added
  the APPRENTICESHIP type for paid training contracts, which is what the Brazilian programme is.
- **Posting time via Spec 1696 helpers**, so exact timestamps also fill `datePostedAt`,
  `datePostedPrecision` and `datePostedBasis`; `EVER_JOBS_POSTED_TIME_DETAIL=false` keeps the
  date-only shape.
- **`/` is a location separator** (`Florianópolis/SC`), besides the spaced dashes.
- **Live answers recorded 2026-09-25** (honest UA, paced): an unknown `X-Tenant` answers `200 []`
  (Q4 — pinned by the E2E); `GET /job-posts/public/pages` (no `/lean`) returns the tenant's
  career-page record (`tenantName`, `about`, `background`, `logo`, `openGraph`, and `jobsPage`, an
  array with one short entry per open role — 5.5 KB for 19 roles, so no descriptions). It is not a
  single-request replacement for the detail calls (Q1). It could give board mode the brand name in
  one call; not done in v1. Live `location` values look like `Curitiba, PR, BR`, which the label
  builder keeps as-is (country already named) and maps to `countryCode: BR`.
- **The detail walk stops at a refusal (review fixup, 2026-09-25).** A 429, a 401/403/407, a
  block or a challenge page on a detail call stops every worker at once; three failed detail
  calls in a row (`INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES`) stop it too. The jobs collected so far
  are returned with the diagnostic that stopped the walk.

## 11. References

- `packages/plugins/source-ats-inhire/` — the plugin.
- `packages/plugins/source-ats-gupy/` — sibling Brazilian ATS adapter (tenant from a sub-domain).
- `packages/common/src/utils/url-guard.ts` — `pinUrlToHosts`, `isPubliclyRoutableHostname` (Spec 1689).
- `packages/common/src/converters/posted-time.ts` — Spec 1696.
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` — Spec 5082.
