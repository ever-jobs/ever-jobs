# Spec 1735 — ATS-Delegating Company-Source Pipeline (verify → scaffold → tail-wire)

| Field | Value |
| --- | --- |
| Spec ID | 1735 |
| Slug | ats-delegate-company-source-pipeline |
| Status | implemented |
| Owner | agent (lane ej-sources) |
| Created | 2026-09-24 |
| Last updated | 2026-09-25 (review follow-ups: §3.1, §4.2, §4.5–§4.7; §4.6 per-scrape bound, Spec 1736 T11) |
| Related specs | 1736 (Workday company sources), 1737 (quant/trading-firm company sources), 5004 (Workday detail enrichment), 5084 (Workday pagination guard), 1375 / 1677 (older per-backend pipelines), 1681 / 1682 (not_registered diagnostics), 1690 / 1691 (crawl policy: per-host limits, robots.txt, User-Agent) |

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

- No ATS adapter change beyond the review follow-ups in §4.5 and §4.6
  (Greenhouse: the env Harvest key is scoped to its own board; Workday:
  `searchTerm` is sent as `searchText`, detail enrichment is sequential and
  paced). Everything else an adapter does is inherited as-is (Q-107).
- No per-host rate limiter, robots.txt engine or User-Agent policy: that is
  the crawl-policy lane (Spec 1690 / 1691). §3.1 records what this lane's
  hosts publish so that lane has the inputs.
- No change to `IPluginMetadata` (the politeness lane edits that interface in
  parallel; a new field is deferred — Q-108).
- No bespoke scraper for firms that do not use a supported ATS (Q-109).
- No discovery crawl: candidates are hand-curated, then verified.

### 3.1 robots.txt and terms review of the scraped host families (2026-09-25)

Every generated plugin runs in the default fan-out, so each host family below
is contacted on every default search. robots.txt was fetched once per host on
2026-09-25 with an identifying `EverJobs-SourceVerifier/1.0` UA (6 requests,
>= 1.2 s apart); "terms" is what the platform itself publishes about the
endpoint the adapter calls.

| Host family (endpoint the adapter calls) | robots.txt (2026-09-25) | Published terms / documentation | Outcome |
| --- | --- | --- | --- |
| `{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/…` (Workday; 56 boards) | Per tenant. Sampled `salesforce.wd12`, `visa.wd5`: `Allow: /{site}/` for each public site, `Disallow: /refreshFacet/`, and `Disallow` for private sites (e.g. `/Visa_Talent_Portal/`). No rule matches `/wday/cxs/`, so it is not disallowed (RFC 9309: unmatched paths are allowed). | None. `/wday/cxs/` is the **undocumented JSON backend** of the public careers site, not a published API; the employer's careers-site terms apply. | Allowed, but the least-sanctioned family here: keep it polite (§4.6: one detail request in flight per board, 250–500 ms apart, keyword filtered server-side). Per-host limits for the shared `wd1`/`wd5`/`wd12` clusters are Spec 1690's host limiter. |
| `api.greenhouse.io/v1/boards/{slug}/jobs` (Greenhouse; 27 boards) | Present, every rule commented out (nothing disallowed). | Documented public Job Board API: Greenhouse's docs state GET endpoints need no authentication, and the API exists to build custom careers pages. | Allowed. |
| `api.lever.co/v0/postings/{slug}` (Lever; 1 board) | `User-agent: *`, `Allow: /`, **`Crawl-delay: 1`**. | Documented public Postings API for building job sites (published postings are publicly viewable). | Allowed; the 1 s crawl delay is host-wide, so it binds the whole Lever fan-out (hundreds of existing Lever company plugins), not one plugin. Input for Spec 1690 `robotsTxt: 'crawl-delay'`. |
| `api.ashbyhq.com/posting-api/job-board/{slug}` (Ashby; 1 board) | HTTP 401 (no robots.txt served). RFC 9309 treats a 4xx robots.txt as "no restrictions". | Documented public Job Posting API for custom careers pages. | Allowed. |
| `careers-sig.icims.com/jobs/search` (iCIMS; SIG only) | `User-agent: *` **`Disallow: /`**. | iCIMS publishes no public listing API; the adapter reads the portal HTML. | **Disallowed for every crawler.** The SIG plugin is therefore explicit-only (§4.7): it never runs in the default fan-out, only when a caller selects `sig` / `sig.com` explicitly. Decision in Q-109. |

**User-Agent.** The 98 verification requests identified themselves honestly
(`EverJobs-SourceVerifier/1.0`, §4.1). Production traffic does **not**: it goes
through the adapters, which all send a desktop-Chrome User-Agent
(`WORKDAY_HEADERS`, `GREENHOUSE_HEADERS`, `LEVER_HEADERS`, `ASHBY_HEADERS`,
iCIMS). Whether these adapters should move to an identifying UA is a
crawl-policy decision (Spec 1690 `userAgentMode`), raised with that lane as an
open item; this lane does not change any adapter UA.

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
   `{...input, auth: undefined, companySlug: board, resultsWanted: remaining}`
   — every other caller input (search term, location, proxies, …) passes
   through untouched. `auth` never does (§4.5).
3. Re-stamp each job: `site`, `companyName` (§4.2.1), and a leading ATS id
   prefix (`wd-{tenant}-`, `gh-`, `lever-`, `ashby-`, `sr-`,
   `icims-{subdomain}-`) → `<key>-`. De-duplicate by id across boards.
4. Diagnostics: the first **actionable** reason (`ACTIONABLE_SCRAPE_REASONS`)
   from any board always surfaces — with jobs it reads as `partial` upstream;
   a benign reason (`empty`) surfaces only when nothing was found; a board that
   throws is classified with `classifyScrapeError` and never rethrown.

Boards are ordered **early-career first** so a small `resultsWanted` still
reaches the intern / new-grad board before the (much larger) main board.

#### 4.2.1 Company name

- **Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS**: the adapter's
  company name is a board-level label (or the slug), one value per plugin, so
  `companyName` is always re-stamped to the plugin's display name.
- **Workday**: the adapter reads each posting's own
  `hiringOrganization.name`, which on a shared multi-business tenant names the
  business unit (RTX's `globalhr` tenant carries Collins Aerospace, Pratt &
  Whitney and Raytheon; J&J, Cox, Warner Bros. Discovery and GE Aerospace are
  similar). That name is **kept**. The plugin re-stamps its display name only
  when the adapter's name is empty, is the tenant token the adapter falls back
  to, or is the display name in legal form — equal after lower-casing,
  `&` → `and`, dropping punctuation, a leading `The` and trailing legal-form
  words (`Inc`, `Incorporated`, `LLC`, `Corp`, `Corporation`, `Co`, `Company`,
  `Ltd`, `Limited`, `LP`, `LLP`, `PLC`, `GmbH`, `AG`, `SA`, `NV`, `BV`). So
  `Salesforce, Inc.` reads `Salesforce`, while `Collins Aerospace` and
  `Johnson & Johnson Innovative Medicine` stay as the source names them.

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

### 4.5 Credential isolation (review follow-up, 2026-09-25)

A company plugin scrapes a **third party's** board, so no credential may
follow the request there:

1. **Per-request credentials** — the generated plugin delegates with
   `auth: undefined`. A caller's `auth.greenhouse.apiKey` (or any other ATS
   key) belongs to the caller's own organisation; forwarding it would make an
   authenticated adapter path answer with the caller's jobs under another
   company's name.
2. **Env credentials** — a plugin cannot unset `process.env`, so the adapter
   scopes them. `source-ats-greenhouse` uses `GREENHOUSE_API_KEY` (Harvest)
   only when `GREENHOUSE_HARVEST_BOARD` names the requested board token
   (case-insensitive). Harvest's `/v1/jobs` lists the key owner's jobs
   (including confidential ones) whatever `companySlug` says, so an unscoped
   env key made every Greenhouse-delegating plugin return the operator's jobs
   labelled as Jane Street, Hudson River Trading, …. With the env key set and
   `GREENHOUSE_HARVEST_BOARD` unset or different, the adapter reads the public
   board and logs one warning per adapter instance (the key itself is never
   logged). An explicit per-request key is
   still honoured as before (the caller asked for it, with its own slug).

The Lever, Ashby and SmartRecruiters authenticated paths address the board by
`companySlug` in the URL, so their env keys never return another company's
jobs; they are unchanged here.

### 4.6 Workday politeness and keyword (review follow-up, 2026-09-25)

The 55 Workday-delegating plugins (56 boards) put Workday into every default
search, so `source-ats-workday` changes (Spec 1736 T6/T8/T11):

| Before | After |
| --- | --- |
| `searchText: ''` always — every board returned its newest postings whatever the keyword | `searchText` = the trimmed `searchTerm`; `''` in list mode (term absent, null, empty or whitespace — contract C1). A keyword search is filtered by Workday and only matching postings are enriched. |
| Detail enrichment 5 requests in flight per board, no pause | **1 in flight** (`WORKDAY_DETAIL_CONCURRENCY = 1`), 250–500 ms (`WORKDAY_DETAIL_DELAY_{MIN,MAX}_MS`) before each detail request |
| One detail request per listed posting, no time bound (`resultsWanted = 1000` ≈ 10 min per board, running on after the fan-out deadline abandoned it) | At most `WORKDAY_MAX_DETAIL_FETCHES` (50) detail requests per scrape and a `WORKDAY_SCRAPE_TIME_BUDGET_MS` (90 s) budget over listing and enrichment; the rest returned at list level (Spec 1736 §8, T11) |

Listing pagination is unchanged (20 per page, 1–2 s between pages) except that
the time budget above also stops it. Worst case per default search is now
about 56 concurrent Workday requests (one per board) instead of about 280, and
each board stops starting requests after 90 s. Per-host / per-cluster limits
remain Spec 1690's.

### 4.7 Explicit-only plugins (review follow-up, 2026-09-25)

A seed entry may carry `explicitOnly: "<reason>"`. The generated plugin then
runs only when the caller selected it explicitly — its `Site` is in
`siteType`, or one of its `companyDomains` is in `companyDomain` (a leading
`www.` ignored). In the default fan-out (no `siteType`, e.g. a plain or
`siteCategories` search) it makes **no request** and returns an empty result
with an `empty` diagnostic whose detail names the reason. Used for SIG, whose
iCIMS host disallows all crawlers (§3.1).

## 5. Test plan

| Suite | What it pins |
| --- | --- |
| `scripts/__tests__/probe-ats-delegate-company-source.spec.ts` | request shapes per backend (listing only, no Greenhouse `content`), extraction and totals per backend, gate, variant planning (dedupe, cap 3), pacer spacing, serial execution, stop-at-first-verified, attempt outcomes, honest UA |
| `scripts/__tests__/scaffold-ats-delegate-company-source.spec.ts` | refusal of unverified boards, mixed backends, bad names/domains; emitted files (none under `.specify/`); registry delegation (no peer import); board order and id prefixes; tags; fixture URLs and derived ids per backend; multi-board test block; verification table |
| `scripts/__tests__/wire-company-source-tail.spec.ts` | tail placement in all four files, BOM preserved, `$'` preserved, pure-addition property, idempotency, collision failure |
| `scripts/__tests__/scaffold-ats-delegate-company-source.spec.ts` (review follow-ups) | `auth: undefined` in every backend's delegation; the Workday company-name rule (emitted for Workday only, evaluated on legal-form, tenant, empty and business-unit names); the explicit-only gate emitted only for flagged seeds; the Greenhouse env-key regression block emitted only for Greenhouse plugins |
| `packages/plugins/source-ats-workday/__tests__/workday.service.spec.ts` | never more than 1 detail request in flight, a paced sleep before each detail request, `searchText` = trimmed `searchTerm`, `''` for absent / null / whitespace; the per-scrape detail cap and time budget (Spec 1736 §6, §8) |
| `packages/plugins/source-ats-greenhouse/__tests__/greenhouse.service.spec.ts` | env Harvest key ignored unless `GREENHOUSE_HARVEST_BOARD` names the board (public board URL only), used when it does, per-request key still honoured |
| each generated `source-company-<key>` suite | see Specs 1736 / 1737; plus: a caller's `auth` is never forwarded; Workday plugins keep a posting's business-unit name through the real adapter; Greenhouse plugins request only their own public board with `GREENHOUSE_API_KEY` set; SIG makes no request in the default fan-out |

## 6. Rollback

Every generated plugin is a self-contained package plus four tail lines; the
batch can be disabled at runtime with `EVER_JOBS_DISABLED_SOURCES` or removed
by reverting the batch commit. The adapter follow-ups (§4.5, §4.6) are
separate commits and revert independently; reverting §4.6 restores 5 detail
requests in flight and keyword-blind Workday listings. The per-scrape bound
(Spec 1736 T11) is its own commit too; without a revert,
`WORKDAY_MAX_DETAIL_FETCHES` >= `resultsWanted` plus
`WORKDAY_SCRAPE_TIME_BUDGET_MS=0` restores the unbounded request pattern.
