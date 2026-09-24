# Spec 1735 — ATS-Delegating Company-Source Pipeline (verify → scaffold → tail-wire)

| Field | Value |
| --- | --- |
| Spec ID | 1735 |
| Slug | ats-delegate-company-source-pipeline |
| Status | implemented |
| Owner | agent (lane ej-sources) |
| Created | 2026-09-24 |
| Last updated | 2026-09-24 |
| Related specs | 1736 (Workday company sources), 1737 (quant/trading-firm company sources), 5004 (Workday detail enrichment), 5084 (Workday pagination guard), 1375 / 1677 (older per-backend pipelines), 1681 / 1682 (not_registered diagnostics) |

## 1. Problem statement

The owner wants two new families of company sources: **large US employers
whose careers sites run on Workday** (the employers that hire software, AI and
data interns and new grads at scale) and **quant / trading firms**. Almost all
of them publish their boards on an ATS Ever Jobs already has an adapter for
(`source-ats-workday`, `-greenhouse`, `-lever`, `-ashby`, `-icims`), so the
right shape is the proven **registry-delegating company plugin** (the
`source-company-abbvie` pattern): a thin `source-company-<key>` package that
resolves the ATS scraper from the `PluginRegistry`, calls it with the company's
board, and re-stamps the company identity.

The existing tooling cannot produce these plugins as-is:

1. Every delegating scaffolder covers exactly one backend
   (`ashby`, `lever`, `recruitee`, `smartrecruiters`, `workable`). None covers
   **Workday** (compound `tenant:wdN:site` slug, POST search + GET detail),
   **Greenhouse delegation** (the Greenhouse scaffolder emits a standalone copy
   of the Greenhouse parser) or **iCIMS** (HTML board).
2. Each scaffolder writes one `.specify/specs/<n>-source-company-<slug>/` per
   plugin. This lane has 15 spec numbers (1735–1749) for ~85 plugins.
3. The existing probes fan out at concurrency 16 over hundreds of guessed
   slugs. This lane verifies well-known companies against their real sites and
   must be polite: at most 1 request per second overall and ~3 requests per
   company, listing endpoint only, honest User-Agent.
4. `wire-company-source.ts` inserts registrations at the **head** of each
   block. Several branches are registering plugins concurrently; head
   insertion makes every branch rewrite the same region.
5. There is no place to tag a plugin with a company tier / industry for a
   later company-tier feature (`IPluginMetadata` has no such field).

## 2. Scope

- `scripts/probe-ats-delegate-company-source.ts` — polite serial verifier.
- `scripts/scaffold-ats-delegate-company-source.ts` — one generator for all
  supported backends, multi-board capable, no per-plugin spec directory.
- `scripts/wire-company-source-tail.ts` — append-at-tail registration.
- `scripts/seeds/ats-delegate-companies.json` — the curated seed (naming,
  domains, segment/industry tags, batch spec, boards).
- `scripts/seeds/ats-delegate-company-verification.json` — the merged live
  verification record (every request's URL, status, job count, date and the
  three recorded listings per board that seed the unit-test fixtures).
- Unit tests for all three scripts.

## 3. Non-goals

- No change to any ATS adapter. Behaviour such as the Workday adapter ignoring
  `searchTerm` (it sends `searchText: ''`) or fetching one detail per posting
  is inherited as-is (see `docs/questions.md` Q-107).
- No change to `IPluginMetadata` (the politeness lane edits that interface in
  parallel; a new field is deferred — Q-108).
- No bespoke scraper for firms that do not use a supported ATS (Q-109).
- No discovery crawl: candidates are hand-curated, then verified.

## 4. Contracts

### 4.1 Verification (probe)

| Rule | Value |
| --- | --- |
| Concurrency | 1 request in flight, process-wide |
| Pacing | >= `MIN_INTERVAL_MS` = 1,100 ms between request starts |
| Budget | <= `MAX_VARIANTS_PER_COMPANY` = 3 requests per company, stopping at the first verified board |
| Request | the board's first listing page only: Workday `POST .../wday/cxs/{tenant}/{site}/jobs` `{limit: 20, offset: 0, searchText: ''}`; Greenhouse `GET api.greenhouse.io/v1/boards/{slug}/jobs` (no `content=true`); Lever `?mode=json`; Ashby job-board; SmartRecruiters `postings?limit=100`; iCIMS `jobs/search?ss=1&in_iframe=1`; Avature `careers/SearchJobs/?jobOffset=0` |
| Identity | `User-Agent: EverJobs-SourceVerifier/1.0 (+https://github.com/ever-co/ever-jobs; one-off careers-listing check, max 1 req/s)`; no cookies, no browser headers, no bot-wall handling |
| Gate | HTTP 200 and >= 1 title-bearing posting (`MIN_JOBS = 1`) |
| Record | per attempt: backend, slug, URL, status, outcome (`verified`/`empty`/`http_error`/`network_error`/`bad_payload`), job count; per verified board: job count (backend total where exposed), date, up to 3 listings |

The 2026-09-24 runs made **98 requests** in total for 86 verified boards and
12 rejected candidates (see the verification seed).

### 4.2 Generated plugin

```ts
const BOARDS = [
  { companySlug: 'visa:5:Visa_Early_Careers', atsIdPrefix: 'wd-visa-' },
  { companySlug: 'visa:5:Visa', atsIdPrefix: 'wd-visa-' },
];

@SourcePlugin({
  site: Site.VISA,
  name: 'Visa',
  category: 'company',
  companyDomains: ['visa.com'],
  description: 'Visa careers via Workday. Tags: segment=workday-enterprise; industry=payments.',
})
```

`scrape(input)`:

1. `registry.getScraper(Site.<ATS>)`; missing registry or scraper →
   `JobResponseDto([], ScrapeDiagnostics('not_registered', …))` (Spec 1682).
2. For each board **sequentially** (so an ATS host never sees two of our
   scrapes of one company at once): `remaining = resultsWanted - jobs.length`
   (absent stays absent); stop when `remaining <= 0`; call the backend with
   `{...input, companySlug: board, resultsWanted: remaining}` — every other
   caller input (search term, location, proxies, …) passes through untouched.
3. Re-stamp each job: `site`, `companyName`, and a leading ATS id prefix
   (`wd-{tenant}-`, `gh-`, `lever-`, `ashby-`, `sr-`, `icims-{subdomain}-`) →
   `<key>-`. De-duplicate by id across boards.
4. Diagnostics: the first **actionable** reason (`ACTIONABLE_SCRAPE_REASONS`)
   from any board always surfaces — with jobs it reads as `partial` upstream;
   a benign reason (`empty`) surfaces only when nothing was found; a board that
   throws is classified with `classifyScrapeError` and never rethrown.

Boards are ordered **early-career first** so a small `resultsWanted` still
reaches the intern / new-grad board before the (much larger) main board.

### 4.3 Tags (company-tier hook)

Until `IPluginMetadata` grows a tag field (Q-108), every plugin generated here
ends its `description` with

```
Tags: segment=<segment>; industry=<industry-slug>.
```

`segment` is `workday-enterprise` (Spec 1736) or `quant-trading`
(Spec 1737); `industry` is the kebab-cased industry from the seed. The seed
file `scripts/seeds/ats-delegate-companies.json` is the machine-readable source
of the same tags (plus HQ and domains) for a later company-tier feature.

### 4.4 Tail wiring

`wire-company-source-tail.ts` appends, in seed order: the `Site` member above
the enum's closing brace; the import after the last import and the module as
the last `ALL_SOURCE_MODULES` entry; the tsconfig alias and the jest mapper
after the last `source-company-*` entry. It is idempotent and fails before
writing anything when an enum key or value is already taken.

## 5. Test plan

| Suite | What it pins |
| --- | --- |
| `scripts/__tests__/probe-ats-delegate-company-source.spec.ts` | request shapes per backend (listing only, no Greenhouse `content`), extraction and totals per backend, gate, variant planning (dedupe, cap 3), pacer spacing, serial execution, stop-at-first-verified, attempt outcomes, honest UA |
| `scripts/__tests__/scaffold-ats-delegate-company-source.spec.ts` | refusal of unverified boards, mixed backends, bad names/domains; emitted files (none under `.specify/`); registry delegation (no peer import); board order and id prefixes; tags; fixture URLs and derived ids per backend; multi-board test block; verification table |
| `scripts/__tests__/wire-company-source-tail.spec.ts` | tail placement in all four files, BOM preserved, `$'` preserved, pure-addition property, idempotency, collision failure |
| each generated `source-company-<key>` suite | see Specs 1736 / 1737 |

## 6. Rollback

Every generated plugin is a self-contained package plus four tail lines; the
batch can be disabled at runtime with `EVER_JOBS_DISABLED_SOURCES` or removed
by reverting the batch commit.
