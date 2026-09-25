# Spec: 1707 — RemoteOK search recall, text repair, hoursOld and direct-URL semantics

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1707                                     |
| Slug           | fix-remoteok-search-recall               |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 1689, 1696, 1698, 5024, 5082             |

## 1. Problem Statement

`source-remoteok` read only the global `GET https://remoteok.com/api` feed — the latest ~100
postings across every category — and filtered it locally with a lower-cased whole-phrase substring
test on title and tags. A live probe (2026-09-24, three requests, honest User-Agent, all 200, no
challenge) showed:

1. **Poor recall.** The public endpoint also serves `GET /api?tag=<slug>`: up to 100 postings
   carrying that tag. The global feed held **4** python-tagged jobs; `?tag=python` held **100**.
2. **Multi-word terms matched almost nothing.** `"senior python"` was one literal substring of
   the title or of a single tag; company and description were never searched, and there were no
   word boundaries (`java` matched `javascript`, `go` matched `google`).
3. **Garbled text reached the store and the dedup keys.** The feed serialises UTF-8 bytes as
   Latin-1 code points: U+2122 arrives as U+00E2 U+0084 U+00A2, `ó` as U+00C3 U+00B3, Arabic city
   names as runs of U+00D9/U+00D8 pairs. 81 of 99 global descriptions and every non-ASCII title,
   company and location were affected, including triple-encoded runs and sequences cut off at the
   end of a title. Titles and locations feed the canonical key, so these jobs never merged with the
   same posting from a clean source.
4. **`hoursOld` and `offset` were ignored.**
5. **`jobUrlDirect` was wrong.** `apply_url` is always the board's own job page (99/99 and
   100/100 in the probe), yet it was emitted as the direct employer link.
6. Smaller defects: a hard-coded browser User-Agent overrode `input.userAgent`; implausible salary
   pairs (`30–36`, the placeholder `10000–750000`) were emitted as yearly USD, which also blocked the
   description-based salary fallback; `requestTimeout` was silently dropped whenever proxies were
   set; the metadata row was skipped by index, not by shape; one row with an empty slug carried the
   bare index URL `/remote-jobs/` as its job link; HTML entities (`R&amp;S`) and newlines leaked into
   titles and company names; the plugin had no tests.

## 2. Goals

- Recall: ask the tag feed picked from the search term, fall back to the global feed.
- Correct matching: whole-word AND of the term's tokens over title, company, description and tags,
  ranked title-first, newest-first within a tier.
- Clean text in every output field and in the match text.
- Honour `hoursOld`, `offset`, `resultsWanted`, `userAgent`, `requestTimeout` and the retry/rate
  inputs.
- Direct-URL semantics: `jobUrlDirect` only when the apply link leaves the board.
- Degrade with diagnostics like sibling plugins: `partial`, `blocked`, `fetch_error`, `timeout`.
- Keep every old behaviour reachable.

## 3. Non-Goals

- No location or country filter: the board has no geo facet, 37% of locations are blank and the
  rest is free text.
- No `jobType` derived from tags: the board's tags are applied far too loosely (83% of the python
  feed also carried `customer support`).
- No change to registration, the module, `index.ts` or any shared package. Promoting the text
  repair to `@ever-jobs/common` and fixing the `timeout` pass-through in `createHttpClient` are
  follow-ups (§9).

## 4. User / Caller Stories

> As an **API caller**, I want **`searchTerm: "python"` to return the board's python jobs**, not the
> four that happen to be in the latest hundred, so that **the source is worth querying**.

> As the **dedup engine**, I want **`Lead — Ops` rather than its byte-garbled spelling**, so that
> **the posting merges with the same job from other sources**.

> As an **operator**, I want **a failed recall path to say so** (`partial`, or the tag feed's own
> error), so that **an outage is not reported as an empty board**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | Tokenise the term: fold case and diacritics, keep `+ # .` inside tokens (`c++`, `c#`, `node.js`), drop a trailing `.`, drop stopwords, de-duplicate, cap at 16 tokens. | must |
| FR-2  | Tag seed = the longest token that is not a generic role/seniority word and is slug-safe (`[a-z0-9][a-z0-9-]{0,39}` with at least one letter); earliest wins a tie; no seed → global feed. | must |
| FR-3  | Feed plan: with a seed, `GET /api?tag=<seed>`; ≥1 job → use it; 0 jobs → global feed; failure → global feed, **except** a `blocked` or rate-limited failure, which is returned as-is with no second request. Without a seed, the global feed. At most two sequential requests. | must |
| FR-4  | Match tier: every token in the title → 0; in title+company+plain description → 1; with tags → 2; otherwise excluded. Whole-word tokens with an optional plural `s`/`es`. Stable sort by tier. | must |
| FR-5  | `hoursOld` drops rows posted before `now − hoursOld h` (by `epoch`, else `date`); rows with no usable time are kept. | must |
| FR-6  | `offset` then `resultsWanted` (default 100, clamped 1…200) are applied after ranking. | must |
| FR-7  | Repair double-encoded UTF-8 per sequence (strict UTF-8 decode of each Latin-1 run, two passes, narrow truncated-tail strip on the raw string, C1 controls removed) on title, company, location, tags and description. Clean text is untouched; the repair is idempotent. | must |
| FR-8  | Plain-text fields (title, company, location, tags) also decode HTML entities; title and company collapse whitespace runs; titles lose a trailing separator run (`·`, `-`, `|`, …). | must |
| FR-9  | Locations: trim parts, drop empty parts, collapse adjacent case-insensitive repeats, map a bare `Remoto`/`Remota`/`Anywhere`/`Worldwide` to `Remote`, then `parseLocationList`. | must |
| FR-10 | `jobUrl` = the feed's `url` (normalised, host lower-cased) unless it is a board index page, else `/remote-jobs/<slug>`, else `/remote-jobs/<numeric id>`; skip the row when none resolves. `applyUrl` = `apply_url` or `jobUrl`; `jobUrlDirect` = `applyUrl` only when it is not on `remoteok.com`/`remoteok.io`. | must |
| FR-11 | Compensation: yearly USD only when plausible — one-sided kept; inverted pairs, figures under 1 000 and spreads over 10× dropped (logged at debug), leaving the description fallback free. | must |
| FR-12 | Posting time: `date` first (keeps the source's calendar day, Spec 5024), `epoch` when `date` gives no confident instant; emitted through the Spec 1696 helpers (`datePosted` plus `datePostedAt`/precision/basis). | should |
| FR-13 | Validate the body: a string is an error (`…challenge…` for a bot interstitial, so it classifies `blocked`), a non-array is an error, job rows are recognised by shape (`id` + string `position`) wherever the metadata row sits. | must |
| FR-14 | Client: pass `userAgent`, `requestTimeout` (also as `timeout`), retries, and a rate spacing never below the site's `Crawl-delay: 1` (default 1–1.5 s); pin redirects to the board hosts. A caller User-Agent wins over the constant's. | must |
| FR-15 | `EVER_JOBS_REMOTEOK_LEGACY` restores the pre-1707 behaviour, whole or per part. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Requests per scrape | ≤ 2, sequential, ≥ 1 s apart |
| NFR-2  | Text helpers | linear time (no `[...]+$` scans over inner runs); 80 KB flagged string repaired in < 2 s |
| NFR-3  | New sources' robots.txt | `/api` and `/api?tag=` are allowed for `User-agent: *` (`Crawl-delay: 1`) |
| NFR-4  | Politeness | no detail fetches, no fingerprint headers, no challenge solving; a block or rate limit is never retried by a second feed request |

## 7. Contracts

### 7.1 API / Interface

No DTO changes. Behaviour of existing inputs is as in §5. New configuration:

```ts
// remoteok.constants.ts
export const REMOTEOK_LEGACY_ENV = 'EVER_JOBS_REMOTEOK_LEGACY';
// true | 1 | yes | on | all      -> every part
// comma/space list of parts      -> those parts
// unset | '' | false | 0 | no | off | none -> current behaviour
type RemoteOkLegacyPart = 'search' | 'text' | 'urls' | 'salary' | 'location';
```

| Part | Restores |
| ---- | -------- |
| `search` | global feed only; lower-cased whole-phrase substring on title or any tag; feed order |
| `text` | no UTF-8 repair, no entity decoding, no whitespace or separator trimming |
| `urls` | `jobUrl = url`, `applyUrl = jobUrlDirect = apply_url` verbatim; `companyLogo = company_logo` verbatim |
| `salary` | any pair with both bounds > 0 as yearly USD |
| `location` | the location label reaches the parser untidied |

`offset` and `hoursOld` apply in every mode (a caller wanting the old result omits them). The
Spec 1696 detail keys keep their own switch, `EVER_JOBS_POSTED_TIME_DETAIL`.

### 7.2 Errors

| Situation | Result |
| --------- | ------ |
| The feed used succeeds | `JobResponseDto(jobs)`, no diagnostics |
| Tag feed fails (not blocked / rate-limited), global succeeds, jobs remain | `partial`, detail `tag feed "<seed>" failed: <msg>; served global feed` |
| Tag feed fails, global succeeds, 0 jobs remain | the tag error's own classification |
| Tag feed blocked (403, challenge) or rate limited (429) | that classification; no second request |
| Global feed fails | `classifyScrapeError(err)` (`blocked`, `fetch_error`, `timeout`, …) |
| One row fails to map | warning, row skipped |

## 8. Test Plan

- Unit, pure helpers: `packages/plugins/source-remoteok/__tests__/remoteok.text.spec.ts` —
  repair cases (two-, three-, four-byte, triple-encoded, truncated tails, repaired trailing letter,
  mixed strings, clean strings untouched, idempotence, invalid runs kept, linear time), title
  cleaning, tokens, seeds, whole-word matching, tiers, locations, salary, URLs, feed validation and
  the legacy-mode grammar.
- Unit, service with a mocked client:
  `packages/plugins/source-remoteok/__tests__/remoteok.service.spec.ts` — feed plan, every row of
  §7.2, AND semantics and ranking, `hoursOld`, `offset`/`resultsWanted`, end-to-end repair, entity
  and whitespace handling, locations, URLs (incl. the bare-index row and relative logos), salary,
  posting time, client options (User-Agent, timeout with proxies, crawl-delay floor, redirect pin),
  row shape, and each legacy part.
- Fixtures: `__tests__/fixtures/remoteok-feed.fixture.ts`, synthetic companies and titles; only the
  wire shape and the encoding defects are the board's, written as `\xNN` escapes.
- E2E (live, ≤ 4 requests, honest User-Agent): `__tests__/remoteok.e2e-spec.ts`.

## 9. Open Questions

Unverified server behaviour the design deliberately does not depend on (local matching always
applies, so these change recall only): what `?tag=` returns for an unknown tag, whether multi-word
tags work, whether tag matching is case-sensitive, whether any paging parameter exists.

Follow-ups:

- Core: `createHttpClient` reads only `requestTimeout` in its input-shaped branch, so plugins that
  pass `timeout` lose it whenever proxies are set. This plugin passes both spellings.
- Core: promote `repairMojibake` to `@ever-jobs/common` (at least one other plugin documents the
  same wire-side double encoding).
- Location parser: recognise the endonym `Brasil` and `Remoto`/`Remota` natively.
- Crawl manifest: declare `{ maxConcurrentPerHost: 1, minIntervalMs: 1000 }` once plugin metadata
  carries a crawl field.
- Probe once whether `?tag=` accepts multi-word values; if so, try the whole slugified term first.
- Optionally drop category-like tags (`digital nomad`, `exec`, `full time`) from `skills`.

## 10. Decisions

- **D-01 — Local matching always applies.** The tag feed only changes which ~100 rows are
  candidates; correctness never depends on how the server interprets `tag`.
- **D-02 — Generic words never seed the feed.** `senior`, `engineer`, `developer`, … still have to
  match, but as tags they are absent or noise. A seed also needs a letter (`2026` would only cost a
  wasted request).
- **D-03 — No second request after a block or rate limit.** The fallback exists for an unknown
  tag or a transient failure. Answering a 403, a challenge page or a 429 with another request is
  what the crawl policy rules out.
- **D-04 — Repair per sequence, strip the truncated tail on the raw string.** A whole-string
  decode fails on any field with one bad byte; stripping after decoding would eat a correctly
  repaired trailing letter (`Café` → `Caf`).
- **D-05 — A board index page is not a job link.** The feed sent `https://remoteOK.com/remote-jobs/`
  for a row with an empty slug. `/remote-jobs/<numeric id>` is used instead: a live check on
  2026-09-25 returned `301` to the full slug URL.
- **D-06 — Posting time through the Spec 1696 helpers.** `date` keeps the source's day;
  `postedFromTimestamp` also refuses a non-ISO `date` that a plain `slice(0, 10)` would have cut
  into garbage, and falls back to `epoch`.
- **D-07 — The crawl delay is a floor.** A caller's `rateDelayMin` can lengthen the spacing, never
  shorten it below the site's `Crawl-delay: 1`.
- **D-08 — Old behaviour stays reachable.** One env var, whole or per part (§7.1), read on every
  scrape. The browser User-Agent constant is kept and only overridden by `input.userAgent`.
- **D-09 — File encodings kept.** `remoteok.service.ts` keeps its UTF-8 BOM and LF endings; the new
  files are ASCII with LF.
- **D-10 — Identifying User-Agent by default (review fixup, 2026-09-25).** The plugin now sends
  `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)` like the other
  rewritten boards; one live request with it on 2026-09-25 got HTTP 200 and the JSON feed (99
  jobs). `EVER_JOBS_REMOTEOK_LEGACY=ua` (or `all`) restores the pre-1707 browser User-Agent; a
  caller's `userAgent` wins in every mode. This supersedes the second sentence of D-08.

## 11. References

- `packages/plugins/source-remoteok/src/remoteok.service.ts`, `remoteok.text.ts`,
  `remoteok.constants.ts`, `remoteok.types.ts`
- `packages/models/src/dtos/scrape-diagnostics.dto.ts` (`classifyScrapeError`, `looksLikeChallenge`)
- `packages/common/src/converters/posted-time.ts` (Spec 1696)
- `packages/common/src/http/http-client.ts` (`allowedRedirectHosts`, Spec 1689)
