# Tasks: 1696 — Posted-time precision

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Core

- [x] T01 — `DatePostedPrecision` and `DatePostedBasis` enums.
  - **Files:** `packages/models/src/enums/date-posted.enum.ts`, `packages/models/src/enums/index.ts`
  - **Acceptance:** wire values `exact|minute|hour|day|week|month|year` and `timestamp|date|relative`; exported from `@ever-jobs/models`.

- [x] T02 — Three optional `JobPostDto` fields after `datePosted`.
  - **Files:** `packages/models/src/dtos/job-post.dto.ts`
  - **Acceptance:** `datePostedAt?: string | null`, `datePostedPrecision?`, `datePostedBasis?`; absent on a DTO that does not set them; nothing removed or renamed.

- [x] T03 — `parseRelativeAge` + `relativeAgeToMs`.
  - **Files:** `packages/common/src/converters/posted-time.ts`
  - **Acceptance:** the FR-3 grammar, case-insensitive and whitespace-collapsed (newlines, tabs, NBSP); `a`/`an` = 1, `30+` = 30; localised, future, unquantified, empty, non-string, five-digit and over-long input → `null`; month = 30 d, year = 365 d.

- [x] T04 — `postedFromRelativeLabel` with the §7.2 order.
  - **Files:** `packages/common/src/converters/posted-time.ts`
  - **Acceptance:** all five probe tuples; "1 week ago" against `2026-09-12` stays `2026-09-12` / `day` / `date`; an inconsistent pair drops the label; ±1-day midnight tolerance both ways; minute flooring; "today" never gets an instant; invalid or datetime hints ignored; an estimate before 2000 or a non-finite fetch time falls back to the hint or all null.

- [x] T05 — `postedFromTimestamp`.
  - **Files:** `packages/common/src/converters/posted-time.ts`
  - **Acceptance:** epoch ms, epoch seconds and numeric strings resolve to the same `exact` instant (regression for the `toDateOnly` null); `-04:00`, `+0530`, `+09`, `Z`/`z`, a space separator and 1–9 fraction digits parse; offset-less datetimes and date-only strings give `day` / `date`; outside 2000 … now + 36 h, impossible dates, `Date` objects and other strings keep the `toDateOnly` date with no precision; garbage, `null`, `NaN`, booleans and objects → all null.

- [x] T06 — `postedFromAgeInDays`.
  - **Files:** `packages/common/src/converters/posted-time.ts`
  - **Acceptance:** `0`, `3`, `'3'`, `' 5 '`, `3650` → `day` / `relative`; negative, `NaN`, `null`, `4000`, `3650.5`, non-numeric → all null; parity with `toDateOnly(fetchedAt − days × 86 400 000)` for 0–60 days.

- [x] T07 — `postedTimeFields` with the invariants and the kill switch.
  - **Files:** `packages/common/src/converters/posted-time.ts`
  - **Acceptance:** always carries `datePosted` (even `null`), other keys only when non-null; drops an instant with day-or-coarser precision or one that does not parse; drops every detail key when `datePosted` is null; `EVER_JOBS_POSTED_TIME_DETAIL` = `false`/`0`/`off`/`no` (trimmed, any case) or `{ detail: false }` emits `datePosted` alone; an explicit option beats the env var.

- [x] T08 — `postedSortKey` and `postedAtAgreesWithDate`.
  - **Files:** `packages/common/src/converters/posted-time.ts`
  - **Acceptance:** `datePostedAt` beats `datePosted`; a date-only row keys at 00:00Z; `Date` objects work; junk, `null`, an invalid `Date` → `0`; a mixed list sorts `pm, am, day, junk, none` deterministically. The agreement check accepts the same day and ±1 day, honours an explicit tolerance and is `false` for anything unparseable. The freshness-filter contract (spec §7.3) is in the `postedSortKey` JSDoc.

- [x] T09 — Barrel export and suite.
  - **Files:** `packages/common/src/converters/index.ts`, `packages/common/__tests__/posted-time.spec.ts`
  - **Acceptance:** every helper is reachable from `@ever-jobs/common`; invariant sweep over every helper; nothing throws even for a clock past the `Date` range. 160/160 passing. Mutation checks (label overriding the hint, no minute flooring, env var ignored, no consistency guard, no seconds detection, no future bound) each turn the suite red.

## Phase 2 — Plugins

- [x] T10 — `source-linkedin`: card labels via `postedFromRelativeLabel`, detail-page `JobPosting` upgrade gated on `postedAtAgreesWithDate`, debug counter line; synthetic-fixture spec; live e2e marker.
- [x] T11 — `source-indeed`: `postedFromTimestamp(datePublished ?? dateOnSite ?? null)`; spec.
- [x] T12 — `source-glassdoor`: `postedFromAgeInDays(ageInDays, fetchedAt)`; spec.

## Phase 3 — Surfaces

- [x] T13 — `jobs.service.ts` sort via `postedSortKey`; aggregator doc comment ("then posted time desc"); specs.
- [ ] T14 — GraphQL fields, tool manifest, MCP `date_posted_at`, CLI CSV columns appended at the end, `DESIRED_ORDER`, `docs/API_CHANGELOG.md`.

## Notes

- `docs/log.md` / `docs/index.md` entries are added with the integrating commit.

Integration 2026-09-25: T10-T12 landed with the board lanes (Specs 1701, 1702, 1703). T13: `JobsService` sorts same-site results by `postedSortKey` (new same-day ordering case in `jobs.service.spec.ts`); the aggregator comment says "then posted time desc". T14 (GraphQL / MCP / CLI / manifest / API changelog) stays open.
