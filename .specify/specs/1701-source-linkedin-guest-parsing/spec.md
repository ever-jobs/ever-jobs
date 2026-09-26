# Spec: 1701 — LinkedIn guest board: pagination, stable ids, pay, detail fields and company enrichment

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1701                                     |
| Slug           | source-linkedin-guest-parsing            |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 1695, 1696, 5024, 5082                   |

## 1. Problem Statement

LinkedIn is one of our most-used boards, and the guest scraper (`packages/plugins/source-linkedin`)
lost data silently in six ways:

1. **Pagination skipped about 60% of results.** The loop advanced `start` by 25, but a guest search
   page holds 10 cards, so positions 10–24 of every window were never fetched.
2. **Job ids were unstable.** The id was `li-<url slug>` (title + company + id, percent-encoded),
   not the numeric posting id the card carries in `data-entity-urn`.
3. **Pay was almost always dropped or mislabelled.** The card regex did not match the per-bound
   `/yr` and `/hr` format, never read the detail page's pay block, and hard-coded `USD`
   (`CA$…` came back as USD, `€…` was dropped).
4. **Detail parsing misclassified and under-filled.** Job type was read from every criterion, so a
   Seniority of `Internship` became INTERNSHIP and a Job function of `Other` became OTHER.
   `jobFunction` and `companyLogo` were never set. The description selector matched the outer
   section, so every description ended in "Show more Show less".
5. **Remote results came back `isRemote=false`** even when we asked the board for remote-only jobs
   (`f_WT=2`), because the cards show a city.
6. **Search failures were invisible.** An error in the search loop `break`s with no diagnostic, so a
   block looked the same as an empty board.

Verified live on 2026-09-24 with three requests at least 3 s apart, using an honest user agent
(all HTTP 200): a search fragment with 10 cards, a canonical `/jobs/view/<id>` page (served directly,
no redirect) and a public company page.

## 2. Goals

- Fetch every result position; stop cleanly and politely.
- A stable identity: `li-<digits>`, `https://www.linkedin.com/jobs/view/<digits>` and
  `https://www.linkedin.com/company/<slug>`.
- Parse LinkedIn's pay display in any currency it renders, per-bound periods included.
- Read the detail page by label and scope; add `jobFunction`, `companyLogo`, the numeric company id
  and the applicant count from pages we already fetch.
- Report blocks (`999`, sign-in walls) and errors as diagnostics, keeping partial results.
- Opt-in, capped, cached company enrichment from the public company page.
- Integrate the Spec 1696 posted-time helpers (card labels and detail JSON-LD).
- Keep every old behaviour reachable behind a switch.

## 3. Non-Goals

- A generic workplace-type input (`onsite`/`hybrid`): only the existing `isRemote` input is wired.
- Mapping the card badges ("Be an early applicant", "Actively Hiring"): no suitable DTO field.
- Changing the request headers, adding any request, or solving any challenge.
- Promoting the remote detector to `@ever-jobs/common` (a follow-up; see §10 D-03).
- Description-prose pay: `JobsService.postProcessSalary` already runs the shared extractor.

## 4. User / Caller Stories

> As an **API caller**, I want **all LinkedIn results for my query, each with a stable id**, so that
> **dedup and change tracking work across runs**.

> As an **operator**, I want **a blocked LinkedIn run to say `blocked`**, so that **I can tell a
> block from an empty board**.

> As a **data consumer**, I want **pay in the right currency and period**, so that **salary filters
> and comparisons are correct outside the US**.

## 5. Functional Requirements

| ID     | Requirement | Priority |
| ------ | ----------- | -------- |
| FR-1   | `start` begins at `offset ?? 0` and advances by the number of cards on the page (every card, parseable or not). | must |
| FR-2   | The loop stops on a page with 0 cards, before requesting `start >= 1000`, after 2 consecutive pages with no new id, at `resultsWanted`, or on an error. | must |
| FR-3   | The posting id is the `urn:li:jobPosting:<digits>` value, else the trailing 6+ digits of the card link; a card with neither is skipped. `id = li-<digits>`, `jobUrl = https://www.linkedin.com/jobs/view/<digits>`. | must |
| FR-4   | `companyUrl` is normalised to `https://www.linkedin.com/company/<slug>` (no query, no regional subdomain). | must |
| FR-5   | `companyLogo` is set only from a `media.licdn.com` URL (never a `static.licdn.com` placeholder, never a face-pile photo). | must |
| FR-6   | `parseLinkedInPay` reads the en-US currency prefixes (`CA$`, `A$`, `NZ$`, `HK$`, `MX$`, `US$`, `R$`, `CN¥`, `$`, `€`, `£`, `₹`, `¥`, `₪`, `₩`, `₱`) and ISO prefixes (`SGD 1,234.50`), `K`/`M` suffixes, per-bound periods (`/yr`, `/hr`, `/mo`, `/wk`, `/day`), `+` (min only), `up to` (max only) and single fixed values; two currencies or two periods, or `min > max`, give `null`; no magnitude limits; never throws. | must |
| FR-7   | With `isRemote` requested, every job is `isRemote=true`, `workFromHomeType='Remote'`. Otherwise remote comes from whole-word signals in the title and location (with guards for "remote sensing/control/support", "not/no/non-remote"; the spaced "home office" is not a signal) or the location parser. | must |
| FR-8   | The detail description is `.show-more-less-html__markup`, else `.description__text` without its buttons; it never contains "Show more"/"Show less". | must |
| FR-9   | Detail job type comes only from "Employment type"; seniority "Not Applicable" is `null`; `jobFunction` and `companyIndustry` are read by label. | must |
| FR-10  | The detail page adds `companySourceId` (`meta[name=companyId]`, digits only), `applicantsCount` + `applicantsCountBound` (`exact`/`min`/`max`), the base-pay block and the offsite apply URL when present. Detail values override the card for pay, job type, level, function and industry; logo, company id, applicants and apply URL only fill gaps. The "similar jobs" cards are never read. | must |
| FR-11  | A search error sets diagnostics (`blocked` for HTTP 999 or a sign-in-wall final URL, else `classifyScrapeError`) and keeps the jobs collected so far. A 200 whose final URL is a sign-in wall is `blocked`, not `empty`. | must |
| FR-12  | A failed detail page keeps the card-only job; the first failure sets diagnostics only if none is set; a block stops the remaining detail fetches. | must |
| FR-13  | Company enrichment is opt-in (`linkedinFetchCompanyDetails` or `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS`), one sequential GET per unique slug, capped at 25, cached per call (failures as `null`), stopped by a block, never sets diagnostics, and only fills empty fields: website, size band (else the JSON-LD member count), HQ address, industry, description, logo. | must |
| FR-14  | Card posting time uses Spec 1696 `postedFromRelativeLabel(label, fetchedAt, datetime)`; `datePosted` stays byte-identical to the `datetime` attribute. With the description fetch on, a JSON-LD `datePosted` instant within a day of the card date upgrades the job to `exact`/`timestamp` without touching `datePosted` (and fills a missing date). A debug line counts relative / date-only / none / upgraded. | must |
| FR-15  | Every changed behaviour is reachable again through `EVER_JOBS_LINKEDIN_LEGACY` (`pagination`, `ids`, `pay`, `detail`, `remote`, or `all`). | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Requests to linkedin.com are sequential with a 3–7 s pause between any two (search, detail, company). | no parallel fan-out |
| NFR-2  | No new request unless company enrichment is enabled; detail additions ride on the existing description fetch. | 0 new by default |
| NFR-3  | At most 100 search pages (`start < 1000`) and 25 company pages per call. | hard caps |
| NFR-4  | Parsers never throw on empty, junk or oversized input. | total |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/plugins/source-linkedin/src/linkedin.types.ts
export type ApplicantsBound = 'exact' | 'min' | 'max';
export interface LinkedInJobExtras {
  companySourceId?: string | null;
  applicantsCount?: number | null;
  applicantsCountBound?: ApplicantsBound | null;
}
export type LinkedInJobPost = JobPostDto & LinkedInJobExtras;
export type LinkedInScraperInput = ScraperInputDto & { linkedinFetchCompanyDetails?: boolean };

// linkedin.parser.ts (pure)
parseSearchCards(html): { cardCount: number; cards: LinkedInCard[] };
cardToJobPost(card, input, fetchedAtMs, legacy): LinkedInJobPost | null;
parseJobDetail(html, format?, { legacyDetail?, legacyPay? }): LinkedInJobDetail;
parseCompanyPage(html): LinkedInCompanyDetails | null;

// linkedin.utils.ts — existing exports kept; new
parseLinkedInPay(raw): CompensationDto | null;
parseApplicants(text): { count: number; bound: ApplicantsBound } | null;
detectRemoteSignal(...fields): boolean;
extractLinkedInJobId(card): string | null;
normalizeCompanyUrl(href): string | null;
parseCriteria($, el): Record<string, string>;
linkedInBlockReason(value): string | null;
```

The three extra job fields are additive own properties, set only when there is a value. They are not
yet declared on `JobPostDto`; see §9.

### 7.2 Switches

| Name | Values | Default |
| ---- | ------ | ------- |
| `EVER_JOBS_LINKEDIN_LEGACY` | comma/space list of `pagination` (step 25, stop on the first page with no new id), `ids` (`li-<slug>`, slug job URL, company URL as served), `pay` (old card regex, no detail pay block), `detail` (old description selector, raw seniority, job type from every criterion), `remote` (old substring test, no stamping from `isRemote`); or `all`/`true`/`1` | unset (all fixes on) |
| `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS` | `true`/`1`/`yes`/`on` | off; `input.linkedinFetchCompanyDetails` wins when set |
| `EVER_JOBS_POSTED_TIME_DETAIL` (Spec 1696) | `false` drops the three posted-time detail keys | on |
| `parseJobType(…, { allCriteria: true })`, `isJobRemote(…, { legacy: true })` | per-call | off |

### 7.3 Errors

| Reason | When |
| ------ | ---- |
| `blocked` | HTTP 999, or a final URL on `/authwall`, `/login`, `/signup`, `/uas/login`, `/checkpoint` (search or detail) |
| `classifyScrapeError(err)` | any other search or detail failure (`fetch_error` for 429/5xx/network, `bad_input` for 404, …) |
| none | company-page failures (logged, cached as `null`) |

## 8. Test Plan

- Unit (`__tests__/linkedin.utils.spec.ts`): the pay table (USD/EUR/GBP/CAD/AUD/INR/SGD, `/yr` `/hr`
  `/mo` `/wk` `/day`, `+`, `up to`, fixed, `K`/`M`, multi-line, executive pay kept, null cases), the
  legacy regex's known defects, applicants, the remote detector (positives and guards), criteria,
  job type by label vs. all criteria, ids from urn/href, company URL normalisation, URL guards, block
  detection, both switches.
- Unit (`__tests__/linkedin.parser.spec.ts`): card counting and fields, identity, legacy ids/pay/remote,
  posted time per card (Spec 1696 table), detail description in all three formats with no button
  text, criteria, company id, applicants, pay block vs. the similar-jobs negative control, apply URL,
  JSON-LD instant, fallbacks, face-pile guard, company page (Organization not `@graph[0]`, DOM-only,
  linkedin.com `sameAs`, nothing).
- Service (`__tests__/linkedin.service.spec.ts`, mocked client and sleeps): pagination (0/10/20,
  offset, empty page, two duplicate pages, the 1000 cap, `resultsWanted`, pacing, legacy step),
  parameters, identity, remote stamping, diagnostics (999, authwall 200, 429 on page 2, network,
  empty), detail merge/override/fill, detail failure and block, company enrichment (off by default,
  cache, failure cache, block stop, cap 25, env switch, pacing), posted-time integration and the
  JSON-LD upgrade rules.
- Live (`__tests__/linkedin.e2e-spec.ts`, gated by `RUN_NETWORK_E2E=1`): ids/URLs/descriptions/job
  type shape, a second page is reached, a sub-day instant is present for `hoursOld: 24`. The
  existing ungated smoke case is kept.

Fixtures are synthetic (fictional companies, titles and ids) and keep LinkedIn's real class names
and attribute shapes as observed on the probe.

## 9. Open Questions

- **Q1 — DTO declarations (default — proceeding).** `companySourceId`, `applicantsCount`,
  `applicantsCountBound` (on `JobPostDto`) and `linkedinFetchCompanyDetails` (on `ScraperInputDto`,
  default `false`) belong in `@ever-jobs/models`, which this lane does not own. The plugin reads and
  writes them through `LinkedInJobPost` / `LinkedInScraperInput`, which stay compatible once the DTOs
  declare them. Until then the input flag only reaches the plugin where the caller's object is passed
  through unvalidated, so the env var is the reliable switch.
- **Q2 — CLI flag (default — proceeding).** `--linkedin-fetch-company-details` in
  `apps/cli/src/commands/search.command.ts` is left to the lane that owns that file.
- **Q3 — Crawl manifest.** When `@SourcePlugin` gains a `crawl` field, declare
  `{ maxConcurrentPerHost: 1, minIntervalMs: 3000 }` for LinkedIn. Until then the in-plugin pacer is
  the only guard.

## 10. Decisions

- **D-01 — One pacer per call.** Every request (search, detail, company) waits 3–7 s after the
  previous one; the old code slept after each page including the last. Same politeness, no trailing
  sleep.
- **D-02 — `datePosted` is pinned to the attribute.** If the Spec 1696 helper ever returns a date
  that differs from `toDateOnly(datetime)` (for example an impossible calendar date the old code
  passed through), the card keeps the old value with no precision claim.
- **D-03 — Plugin-local remote detector.** The design placed `detectRemoteSignal` in
  `@ever-jobs/common`; this lane owns only the plugin, so it lives in `linkedin.utils.ts` with the
  same contract. Promoting it is a follow-up once a second plugin adopts it.
- **D-04 — The 1000 cap applies in legacy pagination too.** It is a politeness guard, not a parsing
  change; the board serves nothing past it.
- **D-05 — The JSON-LD upgrade may fill a missing date.** Spec 1696 forbids overwriting
  `datePosted`; a card with no `<time>` has none to overwrite, so the page's instant is adopted whole.
- **D-06 — Detail fields merge even without a description block.** The old code discarded the
  whole page when the description was missing; criteria, company id and applicants are now kept.
- **D-07 — Legacy `ids` keeps the old id for a card with a link but no digits** (`li-mystery-role`),
  exactly as before; the default path skips such a card.
- **D-08 — Id change rollout.** LinkedIn ids change from `li-<slug>-<id>` to `li-<id>`, so each
  stored LinkedIn row gets one new observation on the first run after deploy; canonical dedup
  (title | company | location) still merges them. `EVER_JOBS_LINKEDIN_LEGACY=ids` restores the old ids.

## 11. References

- `packages/plugins/source-linkedin/src/{linkedin.service,linkedin.parser,linkedin.utils,linkedin.types,linkedin.constants}.ts`
- Spec 1695 (`intervalFromPeriodToken`, `parseSalaryNumber`), Spec 1696 (`posted-time.ts`),
  Spec 5082 (`ScrapeDiagnostics`), Spec 5024 (`toDateOnly`).
