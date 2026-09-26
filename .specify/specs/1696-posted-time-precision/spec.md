# Spec: 1696 — Posted-time precision

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1696                                     |
| Slug           | posted-time-precision                    |
| Status         | in-progress                              |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-26                               |
| Supersedes     | (none)                                   |
| Related specs  | 5024, 720                                |

## 1. Problem Statement

Every source collapses its posting time to `YYYY-MM-DD` through `toDateOnly` (Spec 5024). That is
right for the canonical `datePosted`, but three high-volume boards hand us finer information that
we throw away:

| Source | What the source gives us | What we keep today |
| ------ | ------------------------ | ------------------ |
| LinkedIn guest search card | `<time datetime="YYYY-MM-DD">26 minutes ago</time>` — a date attribute **and** an age label | the attribute only |
| Indeed `jobSearch` | `datePublished`, an absolute epoch timestamp | its UTC date only |
| Glassdoor `jobListings` | `header.ageInDays`, an integer day bucket | its UTC date only |

Two jobs posted "today" on the same board therefore tie in the result order, a UI cannot say
"posted 26 min ago", and dedup has no signal for how far to trust a posting date. Two latent bugs
ride along:

- `toDateOnly("1790280000000")` (a numeric **string**) returns `null`, because
  `new Date("1790280000000")` is an Invalid Date. If Indeed ever serialises `datePublished` as a
  string, every Indeed `datePosted` silently becomes `null`.
- The result comparator uses `new Date(datePosted).getTime()`. A junk `datePosted` makes it return
  `NaN`, and a comparator returning `NaN` gives an engine-dependent, unstable order.

### Probe evidence (2026-09-24, honest user agent, three requests at least 2 s apart)

LinkedIn guest search (200, 10 cards, fetched at `2026-09-24T20:00:03Z`):

| `datetime` attribute | label | real age from the attribute |
| -------------------- | ----- | --------------------------- |
| 2026-09-24 | `1 hour ago` | same day |
| 2026-09-22 | `2 days ago` | 2 d |
| 2026-09-12 | **`1 week ago`** | **12 d** |
| 2026-09-09 | `2 weeks ago` | 15 d |
| 2026-09-04 | **`2 weeks ago`** | **20 d** |

**The label is coarser than the attribute for anything a day old or older.** A "prefer the label"
rule (week = 7 d, month = 30 d) would make dates worse by up to five days. The label only beats the
attribute when its unit is sub-day. The label sits inside `<time>` between newlines and runs of
spaces, so it must be whitespace-collapsed before matching.

Guest detail pages captured the same day carry a schema.org `JobPosting` block whose `datePosted` is
a full UTC instant on four of six pages; our sub-day label estimate was within its stated precision
on both same-day samples (< 1 min for "33 minutes ago", 21 min for "1 hour ago").

Indeed and Glassdoor answered the honest user agent with a 403 at the CDN edge, so their shapes rest
on the fields the plugins already select.

## 2. Goals

- Keep `datePosted` exactly as it is.
- Add an optional sub-day instant (`datePostedAt`) plus `datePostedPrecision` and `datePostedBasis`,
  present only when the source supports them.
- Provide pure, total, time-injected helpers in `@ever-jobs/common` that any plugin can adopt.
- Zero new HTTP requests.

## 3. Non-Goals

- A core `hoursOld` post-filter. None exists; every plugin passes `hoursOld` to its board. §7.3
  records the contract a future filter must follow instead.
- Inventing a time of day for day-precision rows (for example anchoring them to noon UTC).
- Localised age labels. They degrade safely to the date attribute.
- Changing `datePosted` semantics. The only value changes are bug fixes: a numeric-string timestamp
  no longer becomes `null`, an epoch-**seconds** number no longer lands in January 1970, and a
  negative or absurd `ageInDays` gives `null` instead of a nonsense date.
- Changing dedup `observedAt` (recorded separately).

## 4. User / Caller Stories

> As an **API consumer**, I want **jobs posted the same day to order by their real posting
> minute**, so that **the freshest listing is first**.

> As a **UI**, I want **an instant plus how far to trust it**, so that **I can say "posted 26 min
> ago" only when that is true**.

> As a **plugin author**, I want **one helper per source shape (timestamp, age label, day
> bucket)**, so that **I never hand-roll "N days ago" parsing again**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `DatePostedPrecision` (`exact`, `minute`, `hour`, `day`, `week`, `month`, `year`) and `DatePostedBasis` (`timestamp`, `date`, `relative`) enums in `@ever-jobs/models`. | must |
| FR-2  | `JobPostDto` gains optional `datePostedAt?: string \| null`, `datePostedPrecision?`, `datePostedBasis?`. Nothing is removed or renamed. | must |
| FR-3  | `parseRelativeAge` reads English age labels: optional `posted `/`reposted ` prefix; `just now`, `moments ago`, `today`, `yesterday`; `<amount>[+] <unit> ago` with amount `\d{1,4}`/`a`/`an` and unit `second(s)`, `sec(s)`, `minute(s)`, `min(s)`, `hour(s)`, `hr(s)`, `day(s)`, `week(s)`, `wk(s)`, `month(s)`, `mo(s)`, `year(s)`, `yr(s)`. Case-insensitive, whitespace-collapsed, anchored. Anything else → `null`. | must |
| FR-4  | `postedFromRelativeLabel(label, fetchedAtMs, dateHint?)` follows §7.2 — a day-or-coarser label never overrides a source date. | must |
| FR-5  | `postedFromTimestamp(value, nowMs?)` follows §7.2; numeric strings and epoch seconds read correctly. | must |
| FR-6  | `postedFromAgeInDays(days, fetchedAtMs)` gives the historical `fetchedAt − days × 86 400 000` date with `day` / `relative`, for `0..3650` only. | must |
| FR-7  | `postedTimeFields(p)` always carries `datePosted` and each other key only when non-null, and re-enforces the invariants. | must |
| FR-8  | `postedSortKey(job)` is always finite: `datePostedAt`, else `datePosted` at 00:00Z, else `0`. | must |
| FR-9  | `EVER_JOBS_POSTED_TIME_DETAIL=false` (or `0`/`off`/`no`), or `postedTimeFields(p, { detail: false })`, emits `datePosted` alone — the pre-1696 shape. | must |
| FR-10 | LinkedIn, Indeed and Glassdoor adopt the helpers; LinkedIn upgrades to `exact` from the detail page's `JobPosting` block when the description fetch is already on. | should |
| FR-11 | The aggregate sort uses `postedSortKey`; GraphQL, the tool manifest, the MCP tools and the CLI CSV expose the new fields. | should |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Extra HTTP requests | 0 |
| NFR-2  | Helper failure mode | never throws; bad input only downgrades precision |
| NFR-3  | Regex cost | linear, anchored patterns; labels over 80 characters are refused before matching |
| NFR-4  | Existing `datePosted` values | byte-identical wherever `toDateOnly` was already correct |

## 7. Contracts

### 7.1 API / Interface

```ts
// @ever-jobs/models
export enum DatePostedPrecision { EXACT = 'exact', MINUTE = 'minute', HOUR = 'hour', DAY = 'day', WEEK = 'week', MONTH = 'month', YEAR = 'year' }
export enum DatePostedBasis { TIMESTAMP = 'timestamp', DATE = 'date', RELATIVE = 'relative' }

// JobPostDto (additive)
datePostedAt?: string | null;                     // ISO-8601 UTC, only for exact/minute/hour
datePostedPrecision?: DatePostedPrecision | null;
datePostedBasis?: DatePostedBasis | null;

// @ever-jobs/common — packages/common/src/converters/posted-time.ts
export interface PostedTime {
  datePosted: string | null;
  datePostedAt: string | null;
  datePostedPrecision: DatePostedPrecision | null;
  datePostedBasis: DatePostedBasis | null;
}
export const NO_POSTED_TIME: Readonly<PostedTime>;           // all null, frozen
export type AgeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
export interface RelativeAge { amount: number; unit: AgeUnit; label: 'ago' | 'now' | 'today' | 'yesterday' }
export const POSTED_TIME_DETAIL_ENV = 'EVER_JOBS_POSTED_TIME_DETAIL';

export function parseRelativeAge(text: string | null | undefined): RelativeAge | null;
export function relativeAgeToMs(age: RelativeAge): number;   // month = 30 d, year = 365 d
export function postedAtAgreesWithDate(at: string | number | null | undefined, date: string | null | undefined, toleranceDays?: number): boolean;
export function postedFromTimestamp(value: unknown, nowMs?: number): PostedTime;
export function postedFromRelativeLabel(label: string | null | undefined, fetchedAtMs: number, dateHint?: string | null): PostedTime;
export function postedFromAgeInDays(days: unknown, fetchedAtMs: number): PostedTime;
export function postedTimeFields(p: PostedTime, options?: { detail?: boolean }): Pick<JobPostDto, 'datePosted' | 'datePostedAt' | 'datePostedPrecision' | 'datePostedBasis'>;
export function postedSortKey(job: { datePosted?: Date | string | null; datePostedAt?: string | null } | null | undefined): number;
```

Invariants (every helper, and `postedTimeFields` at the DTO boundary):

- `datePostedAt != null` ⇒ `datePostedPrecision ∈ {exact, minute, hour}`.
- `datePostedPrecision != null` ⇒ `datePosted != null`.
- When the source gave a calendar date, `datePosted` is that date and is never re-derived from the
  instant (keeps Spec 5024 local-day semantics and every existing LinkedIn value).

### 7.2 Resolution rules

**`postedFromRelativeLabel`** — `hint` is `dateHint` when it is a real `YYYY-MM-DD` date, else
ignored.

1. Sub-day label (seconds, minutes, hours, "just now"): `at = floorToMinute(fetchedAt − age)`.
   If `hint` is set and `at`'s UTC day is more than one day from it, the pair disagrees and the
   label is dropped (go to 2). Otherwise → `datePosted = hint ?? utcDate(at)`, `datePostedAt = at`,
   precision `minute` (seconds/minutes/now) or `hour`, basis `relative`.
2. `hint` set → `datePosted = hint`, `day`, `date`, no instant.
3. Day-or-coarser label, no hint → `utcDate(fetchedAt − age)`, precision = the label's unit,
   basis `relative`, no instant. "today" is a date, never an instant.
4. Otherwise, or an estimate before 2000 → all null.

**`postedFromTimestamp`**

| Input | Result |
| ----- | ------ |
| Epoch number, or a string of 9–13 digits | below 1e11 → seconds, else ms; `exact` / `timestamp`, `datePosted` = UTC date |
| ISO datetime with `Z` or `±hh[:mm]` | `exact` / `timestamp`; `datePosted` = the source's local day (Spec 5024) |
| ISO datetime without an offset | `day` / `date`, no instant (the host zone would otherwise decide) |
| `YYYY-MM-DD` | `day` / `date` |
| Instant before 2000-01-01 or more than 36 h after now; impossible calendar date; a `Date` object; any other string | `datePosted` exactly as `toDateOnly` gives it, no precision claimed |
| Unparseable / non-string non-number | all null |

**`postedFromAgeInDays`** — finite number or numeric string in `0..3650` → `day` / `relative`;
anything else → all null.

### 7.3 Contract for any future freshness filter

An hours-based post-filter must treat a row as posted at the **latest instant its precision
allows**: the `datePostedAt` instant; the end of the UTC day (capped at now) for `day`; the date
plus 7 days for `week`, and so on. A day-bucketed row can then never be dropped by a 24 h filter,
and no time of day ever has to be invented. `postedSortKey` (start of day) is for ordering only.

### 7.4 Errors

None. Every helper is total: bad input returns a date-only result or all nulls, never throws, and
never drops a job. A markup or locale change shows up as a precision downgrade (and, once FR-10
lands, in the LinkedIn debug counter), not as an error.

## 8. Test Plan

- Unit: `packages/common/__tests__/posted-time.spec.ts` — the probe tuples as regression rows
  (including "1 week ago" against a 12-day-old attribute), the midnight tolerance, every timestamp
  shape, the day-bucket parity with the historical arithmetic, the DTO-boundary invariants, the
  kill switch, the sort key and a sweep asserting the invariants over every helper.
- Plugin units and the live LinkedIn e2e marker (at least one `datePostedAt` under
  `hoursOld: 24`) arrive with FR-10.

## 9. Open Questions

- None blocking. Adjacent observations (dedup `observedAt` uses `datePosted`; LinkedIn ids keep the
  whole slug) go to `docs/questions.md` with the integrator.

## 10. Decisions

- **D-01 — Additive only.** Three optional fields; `datePosted` keeps its values. Reverting is safe.
- **D-02 — A day-or-coarser label never overrides a source date.** Probe-driven: "1 week ago" was
  12 days, "2 weeks ago" covered 15–20 days.
- **D-03 — Floor relative instants to the minute.** No false sub-minute precision.
- **D-04 — ±1 UTC day between a sub-day label and its date attribute.** Absorbs the source's
  unknown time zone around midnight; more than that means the pair disagrees and the label goes.
- **D-05 — No invented time of day.** Day-precision rows carry no instant; §7.3 keeps a future
  filter correct without one.
- **D-06 — Plausibility window.** An absolute instant before 2000 or more than 36 h in the future
  loses its instant *and* its precision claim, but keeps the `toDateOnly` date — no regression, and
  no confidence we cannot back. Also applied to date-only and offset-less values (by their day), and
  to relative estimates (an estimate before 2000 is dropped), so a four-digit "years ago" label can
  never produce a negative-year date.
- **D-07 — A `Date` object carries no precision.** It may have been built from a date-only string,
  so calling it `exact` would overstate it.
- **D-08 — Our own offset parser.** Offset timestamps are computed from their parts rather than by
  `new Date()`, so `+0530`, `+09`, a space separator and nanosecond fractions resolve identically on
  every host.
- **D-09 — Kill switch.** `EVER_JOBS_POSTED_TIME_DETAIL=false` (read per call) or
  `{ detail: false }` restores the pre-1696 shape without a revert.
- **D-10 — `postedTimeFields` re-enforces the invariants.** Plugins that post-process a
  `PostedTime` (the LinkedIn detail upgrade) cannot leak an inconsistent triple.
- **D-11 — `postedAtAgreesWithDate` is exported.** The label/attribute guard and the LinkedIn
  detail-page upgrade share one ±1-day rule.

## 11. References

- `packages/common/src/converters/posted-time.ts`, `packages/common/src/converters/date-converter.ts`
- `packages/models/src/enums/date-posted.enum.ts`, `packages/models/src/dtos/job-post.dto.ts`
- Spec 5024 (`toDateOnly` keeps the local day), Spec 720 (Workday relative labels)

## 12. As built: surfaces (FR-11, T14, 2026-09-26)

Until this change the three fields stopped at REST JSON. They now reach every surface; each one
follows FR-7 (a job without the detail looks exactly as it did before):

| Surface | As built |
| ------- | -------- |
| GraphQL | `JobPostGql.datePostedAt`, `datePostedPrecision`, `datePostedBasis`: nullable `String`s, `null` when absent. Strings, not GraphQL enums, so the values match REST (`minute`, not `MINUTE`); each description lists every enum value, generated from the enums. The resolver returns `JobPostDto`s as-is, so no mapping code changed. |
| Tool manifest | `output_schema` job items gain `datePostedAt` (`format: date-time`), `datePostedPrecision` and `datePostedBasis` (`enum`s in enum order). |
| MCP | `search_jobs`, `search_remote_jobs` and `get_job_details` add `date_posted_at`, `date_posted_precision` and `date_posted_basis` right after `date_posted`, each only when the API sent a non-blank string (camelCase or snake_case). The keys are omitted rather than `null`, so a date-only job's result keeps its previous keys. |
| CLI CSV | Three columns appended after `description`; every earlier column keeps its position. Empty cells when absent. |
| CLI table | A trailing `Posted at (UTC)` column: `datePostedAt` as `YYYY-MM-DD HH:MM`, prefixed `~` when `datePostedBasis` is `relative`; blank otherwise. The original six columns are unchanged. |
| CLI JSON, REST JSON | Already carried the fields (the DTO is serialised as-is). |
| REST CSV (`?format=csv`) | Its columns are the union of the jobs' keys, so it already carried them; a test now pins that. |
| `DESIRED_ORDER` | Ends with the three, after every earlier column. |

The kill switch (`EVER_JOBS_POSTED_TIME_DETAIL=false`) acts where the fields are made
(`postedTimeFields`), so every surface falls back with it: GraphQL `null`, no MCP keys, empty CSV
cells, a blank table cell.

Tests: `gql-types.schema.spec.ts` (types, descriptions, a real query with and without the detail),
`tool-manifest.spec.ts`, `tools-posted-time.spec.ts` (MCP mapping, both key spellings, key order,
unchanged keys for a date-only job), `search-posted-time.command.spec.ts` (CSV header and cells,
table cells, `postedAtLabel`), `jobs.controller.spec.ts` (REST CSV) and `posted-time.spec.ts`
(`DESIRED_ORDER`). Docs: `docs/API_CHANGELOG.md`, `docs/CLI.md`, `apps/mcp/README.md`.
