# Spec: 5030 — BreezyHR company display name + structured-first compensation

| Field | Value |
| --- | --- |
| Spec ID | 5030 |
| Slug | breezyhr-company-compensation |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5015, 5018, 5022 |

## Problem

The BreezyHR plugin (Spec 5015) has two correctness bugs, both observed on live
`{slug}.breezy.hr` boards across several companies:

1. **`companyName` ships the slug, not the company name.** `processJob` sets
   `companyName: company`, where `company` is `input.companySlug` (e.g.
   `ondas-networks`, `vvater-llc`, `reaxiomatic-inc`, `zeno-power`). The list
   record already carries the human-readable display name under `company.name`
   (`Ondas Inc.`, `VVater`, `Reaxiomatic`, `Zeno Power`), but the `BreezyJob`
   type does not even model the `company` object, so the slug is shipped on
   every posting.

2. **Compensation ignores the structured `baseSalary`.** The plugin parses pay
   only from the free-text list field `salary` (`salaryToCompensation`). The
   per-job detail page's schema.org `JobPosting` ld+json also carries a
   structured `baseSalary` (a `MonetaryAmount` with `min`/`max`/`unitText`),
   which is the authoritative declared interval. When the free text omits a unit
   (e.g. `"$30 - $45"`) the heuristic can pick the wrong interval (guesses
   hourly) where the structured `unitText` says otherwise (`YEAR`).

## Scope

- **Company display name.** Read `company.name` from the list record; fall back
  to the slug only when it is absent. Add the `company` object to `BreezyJob`.
- **Structured-first compensation.** Parse the detail ld+json `baseSalary` into a
  `CompensationDto` (via the shared `jobPostingLdToCompensation`) and pass it as
  `structured` to `resolveCompensation`; the free-text list `salary` remains the
  fallback (Spec 5018 precedence). Set `salarySource` to `'structured'` when
  `baseSalary` is present, else `'description'` — matching the `source-jsonld` /
  `workatastartup` / `manatal` / `paylocity` convention.
- **Detail overlay carries `baseSalary`.** The per-job detail fetch already
  parses the ld+json description; it now also returns the structured
  `baseSalary`. A new `BreezyDetail` type models `{ description, baseSalary }`.

## Non-goals

- No change to the list/detail endpoints (`/json`, `/p/{friendly_id}`), the
  bounded-concurrency detail overlay, or the fail-safe behaviour.
- No change to location / `isRemote` / date / `jobType` / `employmentType`
  mapping.
- No change to the shared `resolveCompensation` / `jobPostingLdToCompensation`
  helpers (Spec 5018) or the ld+json extractor (Spec 5022).
- No plugin imports another plugin.

## Contracts

- `JobPostDto` shape unchanged.
- A posting whose list record has `company: { name: "Ondas Inc." }` yields
  `companyName: "Ondas Inc."`; a record with no `company.name` falls back to the
  slug (behaviour-preserving for that case).
- A posting whose detail ld+json has `baseSalary { min, max, unitText }` yields a
  `compensation` from that structured range with `salarySource: 'structured'`,
  regardless of the free-text `salary` (e.g. free text `"$30 - $45"` +
  structured `unitText: "YEAR"` → yearly interval).
- A posting with no structured `baseSalary` but a free-text `salary` still yields
  `compensation` via the text fallback with `salarySource: 'description'`
  (behaviour-preserving).
- A posting with neither structured nor free-text pay emits no `compensation`.

## Test plan

- **BreezyHR service**, new / updated cases:
    - company display name: list `company.name` → `companyName` (display name,
      not slug).
    - slug fallback: no `company.name` → `companyName` is the slug.
    - structured-first: detail with ld+json `baseSalary` (`unitText: YEAR`) over
      free text `"$30 - $45"` → yearly `compensation`, `salarySource:
      'structured'`.
    - text fallback: free-text `salary` only, no `baseSalary` → `compensation`
      via text, `salarySource: 'description'`.
- Existing BreezyHR suites stay green (structured location, detail description,
  description format, free-text yearly/hourly, jobType/employmentType, fail-safe
  on detail error, isRemote, empty-compensation cases).

## Risks

- Where breezy's structured `baseSalary` carries dubious employer units (the
  `"$30 - $45"` case is declared `YEAR`), structured-first will surface that
  declared value over the heuristic. This is the intended precedence (trust the
  employer's structured declaration), consistent with Spec 5018 and the
  paylocity fix; `salarySource` records which source won for auditability.
- The fix never *removes* compensation relative to today — it adds the structured
  source ahead of the existing text fallback.
