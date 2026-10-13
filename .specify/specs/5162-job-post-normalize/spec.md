# Spec 5162

| Field | Value |
| ----- | ----- |
| Title | `normalizeJobPost` — aggregated-result whitespace cleanup |
| Status | Implemented |
| Package | `packages/common`, `apps/api` |

## Problem

Source plugins emit `JobPostDto` strings straight from the source — ATS JSON
or scraped HTML. Nothing normalizes them: `JobPostDto`'s constructor is a bare
`Object.assign`, and trimming is per-plugin, per-field, and inconsistent
(rippling has a `nonEmptyString` helper; most plugins trim nothing). Edge
whitespace, zero-width characters (\u200B-\u200D, \uFEFF), and interior
runs like `\n  ` scraped out of markup all reach the API response. A blank
`"   "` is worse than missing: `??` fallbacks only act on `null`, so a
whitespace-only value silently blocks the fallback.

## Proposal

`normalizeJobPost(job)` in `packages/common/src/utils` — a pure function that
returns a new `JobPostDto` with cleaned strings — called once in
`JobsService.searchJobsWithDiagnostics` over the aggregated result set, after
the scraper fan-out and salary post-processing (so fields written there, e.g.
`salarySource`, are cleaned too) and before sorting.

## Contracts

### Cleaning rules

- **Edge trim (extended set).** `[\s\u200B-\u200D\uFEFF]+` at either end —
  i.e. standard whitespace plus zero-width characters – and
  the BOM `\uFEFF`, which HTML scrapers produce and which break sorting the
  same way as spaces.
- **Blank → `null`.** A value empty after trimming becomes `null`, never `""`.
- **Interior collapse.** `title`, `companyName`, and text-shaped location
  parts (`name`, `text`, `city`, `state`, `streetAddress` on `location`,
  `locations[]`, `offices[]`) also collapse interior runs of the extended set
  to a single space.
- **Ends only.** Everything else — ids (`id`, `atsId`, `atsType`), URLs
  (`jobUrl`, `jobUrlDirect`, `applyUrl`, `companyUrl`, `companyUrlDirect`,
  `companyLogo`, `bannerPhotoUrl`), `description`, `companyDescription`,
  `countryCode`, `department`, `team`, `employmentType`, `workFromHomeType`,
  `listingType`, `jobLevel`, `jobFunction`, `companyIndustry`,
  `companyAddresses`, `companyNumEmployees`, `companyRevenue`, `salarySource`,
  `experienceRange`, location codes (`country`, `postalCode`, office `id`),
  and `compensation.currency`/`interval` — trims ends, preserves interior:
  inner whitespace in an id or URL is corrupt data worth surfacing, not
  silently joining.
- **Arrays.** `emails[]` and `skills[]` clean each entry, drop empties, dedupe
  preserving order.
- **Untouched.** `site` (registry token), `jobType`, `datePosted`, `isRemote`,
  numeric fields, `liveness`/`legitimacy`.
- **Purity.** Pure, deterministic, idempotent; returns a new object and never
  mutates the input.

### Non-goals

- No per-plugin changes — plugins keep emitting raw source values.
- No canonicalisation for dedup (`packages/common/src/normalize.ts` remains
  the identity layer; this spec is presentation cleanup only).
- No change to any request/response shape — the same `JobPostDto[]` comes
  back, cleaner.

## Test plan

- `packages/common/__tests__/job-post-normalize.spec.ts`:
  edge trim incl. zero-width/BOM; blank → `null`; interior collapse on
  `title`/`companyName`/location parts; interior preserved on `id`/`jobUrl`/
  `applyUrl`; `description` ends-only; arrays cleaned + deduped; `site`
  untouched; input not mutated; idempotent.
