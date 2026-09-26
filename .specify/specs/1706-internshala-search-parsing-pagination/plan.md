# Plan: 1706 — Internshala: a search that searches, one posting per card, and honest paging

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1706       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

Split the plugin the way sibling plugins are split: pure functions with no I/O in
`internshala.parser.ts`, request orchestration in `internshala.service.ts`. Everything the
service decides before its first request comes from one pure `planSearch(input, options)`.

1. **Plan.** `planSearch` maps `jobType` to streams (+ a part-time filter), cleans the term,
   resolves the city (first comma segment, aliases, country-only and remote-only values
   ignored), picks the starting strategy (`narrow` only when a city or remote was asked for and
   the term slugs faithfully) and the detail budget.
2. **Listing loop.** One `ListingStream` per kind. Each round fetches one page per active
   stream (internships first), sleeping 2–5 s before every request but the first. Each page is
   parsed, checked by the canonical guard, deduplicated against a global `seen` set and
   filtered. Stop rules: 0 cards, no unseen id, `isLastPage=1`, the highest pagination page,
   the page cap (counted in requests, so the guard's fallback cannot exceed it), a guard stop,
   or a request error (first error kept as diagnostics).
3. **Merge.** Round-robin across streams in fetch order, then `offset`, then `resultsWanted`.
4. **Details.** Sequential detail requests for the first `detailBudget` selected postings; a
   failure keeps the card snippet and records the error.
5. **Mapping.** `cardToJobPost` builds the DTO; `composeDescription` appends the extras line.

## Card → `JobPostDto`

| Field | Source |
| ----- | ------ |
| `id` | `is-<internshipid>` (element id `individual_internship_<n>` as a fallback, then the old url hash) |
| `title` | `a.job-title-href`, else `h2.job-internship-name` |
| `jobUrl` | base + `a.job-title-href[href]` or the card `data-href`; must be a `/job/detail/` or `/internship/detail/` path on the board host |
| `companyName` | `.company-name` without the hiring badge |
| `companyLogo` | `.internship_logo img[src]`, absolutised; `null` for the placeholder |
| `listingType` | `employment_type`, else the detail path, else the stream |
| `jobType` | internship (+ part time) / full time / part time |
| `location`, `locations` | location anchors split on commas, work-from-home labels removed, `parseLocationList`, India stamped unless "International" |
| `isRemote`, `workFromHomeType` | home icon or a "Work from home" label → `Remote`; "(Hybrid)" outside the anchors → `Hybrid` |
| `compensation` | `parseInrPay` on the pay row |
| `datePosted` (+ Spec 1696 fields) | `resolvePostedTime(label, path, now)` through `postedTimeFields` |
| `skills` | `.job_skills .job_skill`, `null` when none |
| `experienceRange` | briefcase row |
| `description` | detail body or card snippet, blank line, `Stipend|Salary: … | Duration: … | Experience: … | <offer>` |
| `emails` | from the description, else the snippet |

## Files

| File | Change |
| ---- | ------ |
| `packages/plugins/source-internshala/src/internshala.constants.ts` | new: base, roots, headers (no UA), honest default UA, caps, delays, budgets, aliases, robots prefixes, env names |
| `packages/plugins/source-internshala/src/internshala.types.ts` | new: kinds, strategies, options, plan, parsed card/page |
| `packages/plugins/source-internshala/src/internshala.parser.ts` | new: URL builder, robots guard, canonical guard, card/page parser, pay and posted parsers, filters, mapping, plan, options |
| `packages/plugins/source-internshala/src/internshala.service.ts` | rewritten orchestration (BOM kept); module and exports unchanged |
| `packages/plugins/source-internshala/src/index.ts` | also exports constants, types and parser |
| `packages/plugins/source-internshala/tsconfig.json` | new, same shape as sibling plugins |
| `packages/plugins/source-internshala/__tests__/fixtures/*.html` | new synthetic fixtures |
| `packages/plugins/source-internshala/__tests__/internshala.parser.spec.ts` | new |
| `packages/plugins/source-internshala/__tests__/internshala.service.spec.ts` | new |
| `packages/plugins/source-internshala/__tests__/internshala.e2e-spec.ts` | updated: small live keyword and multi-word searches |

## Verification

The two unit suites (mocked client, pinned clock), one live e2e run (≤ 3 listing requests),
and `tsc --project tsconfig.typecheck.json --noEmit`.
