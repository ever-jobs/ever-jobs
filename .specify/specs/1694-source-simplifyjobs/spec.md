# Spec: 1694 — Source plugin: Simplify new-grad and internship lists

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1694                                     |
| Slug           | source-simplifyjobs                      |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 1689, 1696, 1697, 1699, 5082             |

## 1. Problem Statement

Early-career roles (full-time new-grad positions and internships) are the segment our catalogue
covers worst. `source-internshala` is India-only, `source-hackernews` is one monthly thread, and
the ATS plugins only reach employers we already know about.

Simplify (simplify.jobs) maintains two community-curated lists of exactly these roles and
publishes each as one machine-readable `listings.json` on GitHub, updated several times a day.
Every row links to the employer's own apply page (Workday, Greenhouse, Lever, Ashby, iCIMS,
Oracle and others). Checked live on 2026-09-24/25:

| List        | Rows in file | Live rows | Body size |
| ----------- | ------------ | --------- | --------- |
| New grad    | 19,944       | 3,091     | ~13.6 MB  |
| Internships | 17,190       | 4,604     | ~12.9 MB  |

The host (`raw.githubusercontent.com`) needs no auth, serves our honest User-Agent, has no
robots.txt (404) and sends `Cache-Control: max-age=300` with a strong `ETag`.

The difficulty is memory, not access. API pods have a history of heap exhaustion, and a naive
`JSON.parse` of one list holds a 13–27 MB string plus a ~16 MB parse tree at once, for ~80 %
of rows we then throw away.

## 2. Goals

- A new source plugin `source-simplifyjobs` (`Site` value `simplifyjobs`) serving both lists.
- One conditional GET per list per cache window, fetched sequentially, never a fan-out.
- Heap cost bounded by the live rows we keep, not by the body we download.
- Local search, location, remote, freshness and paging filters that behave the way callers
  expect from other boards.
- Honest behaviour: our own User-Agent, robots.txt checked, degraded results with diagnostics.

## 3. Non-Goals

- No detail-page fetches and no descriptions (the lists carry none; none is synthesised).
- No new `JobPostDto` field in this spec (see D-08 on visa sponsorship).
- No change to the shared location parser (see Q-1); a plugin-local pre-normaliser covers the
  label shapes this source uses.
- Registration in `site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json` and
  `jest.config.js` is done by the integrator, not in this spec's lane.

## 4. User / Caller Stories

> As a **job seeker**, I want **new-grad and internship roles with the employer's own apply
> link**, so that **I apply directly and early**.

> As an **operator**, I want **the plugin to keep working when the internship list is renamed
> for a new season**, so that **I only change an env var, not code**.

> As an **API pod**, I want **this source to cost a few MB of heap**, so that **a fan-out search
> never pushes me into an OOM**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `jobType` routing: unset → both lists (new grad first); `INTERNSHIP` → internships; `SUMMER` → internships with a `Summer …` term; `FULL_TIME` → new grad; every other type → no request, `[]` with `empty` and an explanatory detail. | must |
| FR-2  | A row is kept only when `active === true`, `is_visible !== false` (missing = visible), and it has a title, a company and an absolute http(s) apply URL. The `source` field (who added the row) and degrees are never kept. | must |
| FR-3  | Rows are sorted newest first (`date_posted` desc, `date_updated` desc, `id` asc) — the file is in insertion order. | must |
| FR-4  | Dedup by apply URL (trimmed, scheme/host lower-cased, one trailing `/` dropped), within and across lists; the newest row wins. Same company + title with different URLs are different requisitions and are all kept. | must |
| FR-5  | `searchTerm`: case- and accent-insensitive; every token (a quoted phrase is one token) must start a word in title, company, category or terms. | must |
| FR-6  | `location`: a row matches if any of its labels does — by word-start match against the label's facts (raw label, normalised label, parsed city / state / province name / country, inferred country), or structurally when the query names a state, country or remote work. `New York` finds `NYC`, `United Kingdom` finds `London, UK`, `Canada` finds `London, ON`, `UK` does not find `Milwaukee, WI`. | must |
| FR-7  | `isRemote === true` keeps rows with a remote label; `false` (the input default) does not filter. `country` is ignored (it defaults to USA and would drop every UK/Canada row). | must |
| FR-8  | `hoursOld`: keep `date_posted >= cutoff`; a midnight-aligned value (`% 86400 === 0`) is day-granular and counts as posted at the end of its day (Spec 1696 §7.3). Undated rows are kept. | must |
| FR-9  | Paging: `offset ≥ 0`, `resultsWanted` clamped to `[1, 1000]` (default 25), applied after sorting and dedup. | must |
| FR-10 | Mapping per §7.1; `datePosted` + Spec 1696 precision fields (`exact`/`timestamp` for a real instant, `day`/`date` for a midnight-aligned value). | must |
| FR-11 | Location pre-normaliser: `NYC`, `SF`, `SF Bay Area` / `Bay Area`, `DC` aliases; `Area, City, ST, Country` keeps the last three parts; `Area, City, ST` keeps the last two unless an earlier part is a country or a bare region code. The raw label is kept as `text`. | must |
| FR-12 | ATS detection from the apply-URL host (shared board-host resolver, then a host-suffix table, then a `gh_jid` query). | should |
| FR-13 | robots.txt of the host is read (24 h cache) before any feed request; a disallowed list is not requested (`blocked`); an unreachable robots.txt with no earlier copy means no feed request (`fetch_error`). | must |
| FR-14 | Operator overrides `SIMPLIFYJOBS_NEWGRAD_REPO`, `SIMPLIFYJOBS_INTERNSHIPS_REPO`, `SIMPLIFYJOBS_BRANCH`, read per scrape, validated; an invalid value warns once and falls back to the default. | must |
| FR-15 | A warning is logged when a list's newest posting is over 14 days old (the yearly rename). | should |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Heap retained by the cache for 8k live rows | < 6 MB (measured ~3.8 MB; a whole-body parse retains ~16 MB of tree plus the ~15 MB string) |
| NFR-2  | Largest string decoded or parsed while reading a feed | one row (< 2 KB); never the body |
| NFR-3  | Requests per list per pod | ≤ 1 conditional GET per `max-age` window (clamped 1–30 min); a 304 costs a few hundred bytes |
| NFR-4  | Requests after a failure | none for 60 s per list (error backoff) |
| NFR-5  | Cold scrape of both lists | ~8 s measured (2 s minimum spacing + two ~2 MB compressed downloads) |
| NFR-6  | Warm scrape (cache hit), all filters | no request; local work only |
| NFR-7  | Rows examined for a page | only until `offset + resultsWanted` distinct matches are found (a default search touches ~15 rows, not ~8k) |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/plugins/source-simplifyjobs
@SourcePlugin({ site: Site.SIMPLIFYJOBS, name: 'Simplify (new grad & internships)', category: 'niche', description })
export class SimplifyJobsService implements IScraper { scrape(input: ScraperInputDto): Promise<JobResponseDto> }
export class SimplifyJobsModule {}
export const SIMPLIFYJOBS_CLOCK: symbol; // optional provider: () => epoch ms (tests)
```

| `JobPostDto` | Value |
| ------------ | ----- |
| `id` | `simplifyjobs-<row id>` (a UUID-shaped hash of the apply URL when the row has none) |
| `site` | `simplifyjobs` |
| `title`, `companyName` | trimmed |
| `companyUrl` | the row's Simplify company page when it is on `https://simplify.jobs/`, else null |
| `jobUrl`, `jobUrlDirect`, `applyUrl` | the employer apply URL |
| `location`, `locations` | pre-normalised labels through `parseLocationList`; `locations` only when non-empty |
| `isRemote`, `workFromHomeType` | from the parser |
| `datePosted` (+ `datePostedAt`, `datePostedPrecision`, `datePostedBasis`) | Spec 1696 |
| `jobType` | new grad `[FULL_TIME]`; internships `[INTERNSHIP]`, plus `SUMMER` for a summer term |
| `jobLevel` | `Entry level` / `Internship` |
| `employmentType` | `Full-time (new grad)` / `Internship · <terms>` / `Internship` |
| `jobFunction` | normalised category (`Software`, `AI/ML/Data`, `Quant`, `Hardware`, `Product`, else trimmed) |
| `atsType` | detected ATS or null |
| `description`, `emails`, `compensation`, `skills` | null |

Environment variables (all optional):

| Variable | Default | Validation |
| -------- | ------- | ---------- |
| `SIMPLIFYJOBS_NEWGRAD_REPO` | `SimplifyJobs/New-Grad-Positions` | `owner/repo`, `[\w.-]`, no `.`/`..` segment |
| `SIMPLIFYJOBS_INTERNSHIPS_REPO` | `SimplifyJobs/Summer2027-Internships` | same |
| `SIMPLIFYJOBS_BRANCH` | `dev` | `[\w./-]`, no empty/`.`/`..` segment |

### 7.2 Errors

| Situation | Response |
| --------- | -------- |
| Unsupported `jobType` | `[]` + `empty` ("simplifyjobs lists only full-time new-grad roles and internships"); no request |
| All needed lists fetched, nothing matches | `[]`, no diagnostics |
| One list failed | the other list's jobs + `partial` (`<list>: <reason>: <detail>`) |
| A list served from a copy < 6 h old after an error | jobs + `partial` (`<list>: served cached copy (age Nm) after <msg>`) |
| Every needed list failed, no usable copy | `[]` + the first failure's reason; details of each list joined |
| Body not a JSON array / invalid element / truncated | `fetch_error`, detail `simplifyjobs: invalid feed JSON: …` |
| robots.txt disallows the list | `blocked`, detail `simplifyjobs: robots.txt disallows <path>` |
| robots.txt unreachable, never read | `fetch_error`, detail `… robots.txt unreachable …` |
| A row throws while mapping | row skipped with a warning naming its id |
| Anything else | `classifyScrapeError` |

## 8. Test Plan

- Unit (`__tests__/`, synthetic fixtures with invented employers):
  - `simplifyjobs.feed-parser.spec.ts` — the byte scanner (chunk boundaries mid-string, mid-escape
    and mid-UTF-8; BOM; non-object elements; every malformed-body shape; size caps), compaction
    rules, interning, the one-row-at-a-time property, and the heap bound for 8k live rows of a
    ~15 MB body.
  - `simplifyjobs.feed-cache.spec.ts` — TTL, 304 revalidation with ETag, `max-age` clamp,
    single-flight, stale-on-error, error backoff, eviction.
  - `simplifyjobs.robots.spec.ts` — group selection, longest match, wildcards, comments.
  - `simplifyjobs.mapper.spec.ts` — location pre-normaliser table, category order, ATS table,
    sponsorship, posted-time precision, full row mapping.
  - `simplifyjobs.query.spec.ts` — routing, search, location, freshness, sort/merge/dedup, paging.
  - `simplifyjobs.service.spec.ts` — end to end with a mocked HTTP client: mapping, filters,
    routing (including sequential fetches), cache, single-flight, every error row of §7.2,
    request shape, User-Agent, env overrides.
- E2E: `simplifyjobs.e2e-spec.ts`, live, runs only with `RUN_NETWORK_E2E=1`; fails on an empty or
  diagnosed result.

## 9. Open Questions

- **Q-1 (shared parser).** `parseLocationList(['Remote in UK', 'Remote in Canada'])` returns only
  the UK entry: country-only entries collapse on an empty city|state key. Live rows carry such
  pairs. Filtering here is per label, so matching is right, but `locations[]` loses the second
  country. Fix belongs in `packages/common` (default — proceeding without it).
- **Q-2 (model).** A `visaSponsorship` field on `JobPostDto` (see D-08). Default — proceeding
  without it; the compacted row already carries the normalised value.

## 10. Decisions

- **D-01 — Bytes, scanned row by row.** The body is requested as `arraybuffer` (off-heap) and a
  byte scanner hands each top-level element's own text to `JSON.parse`; the row is compacted or
  dropped before the next. Structural JSON bytes are ASCII and UTF-8 continuation bytes never are,
  so byte scanning is exact. The scanner is incremental, so a streamed body can use it unchanged.
- **D-02 — Buffered, not streamed, transport.** A streamed response would also avoid the
  off-heap body, but an unconsumed error-status stream would hold its socket through the HTTP
  client's retries, and axios's timeout stops covering the body once headers arrive. Buffered
  keeps retries, `maxContentLength` and the timeout intact.
- **D-03 — Interning.** Company, company page, category, locations and terms repeat heavily;
  each distinct value (and each distinct list) is stored once per list.
- **D-04 — Cache on the service.** The singleton service owns a `FeedCache` keyed by URL (ETag,
  clamped `max-age`, single-flight, 6 h stale-on-error, 60 s error backoff, at most 4 keys) and a
  second one for robots.txt (24 h, a copy up to 7 days old while unreachable, per RFC 9309).
- **D-05 — robots.txt at runtime.** The host has none today; checking it anyway costs one small
  request a day and honours a future policy without a code change. The product token is
  `everjobs`.
- **D-06 — Word-start matching.** Search and location tokens must start a word (a token that
  starts with punctuation may match anywhere). Plain substring matching made `uk` match
  `Milwaukee` and `ai` match `maintenance`.
- **D-07 — `PERMANENT` and `APPRENTICESHIP` (Spec 1697) route to neither list.** The lists do not
  state permanence, and an apprenticeship is not an internship.
- **D-08 — No visa field yet.** `JobPostDto` has no sponsorship field and the model is outside
  this lane. The value is normalised (`offered` / `not_offered` / `citizenship_required` / null)
  and kept on the compacted row, so exposing it later is a one-line mapping.
- **D-09 — `SUMMER` on summer internships.** A summer-term internship carries
  `[INTERNSHIP, SUMMER]`, consistent with the `SUMMER` route.
- **D-10 — Minimum 2 s between requests of one scrape.** Callers may lengthen the spacing, never
  shorten it. Redirects are pinned to the feed host (Spec 1689).
- **D-12 — Lazy page selection.** The per-list rows are cached newest first, so a page is
  taken by merging the list heads, filtering each head once and deduping on the fly, stopping at
  `offset + resultsWanted`. Same order as filter-all → merge → dedup → slice (pinned by an
  exhaustive equivalence test), without touching or keying every row per search.
- **D-11 — No crawl manifest field.** `@SourcePlugin` has no crawl-policy field on this branch;
  sequential fetching, the spacing and the cache give the same effect until it lands.

## 11. References

- `packages/plugins/source-simplifyjobs/src/*`
- Spec 1696 (posted-time precision and the freshness contract), Spec 1697 (job types),
  Spec 1699 (country names), Spec 1689 (redirect pinning), Spec 5082 (scrape diagnostics).
- RFC 9309 (robots exclusion protocol).
