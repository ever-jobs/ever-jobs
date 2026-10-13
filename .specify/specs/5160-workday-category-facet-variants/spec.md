# Spec 5160

| Field | Value |
| ----- | ----- |
| Title | Workday: discover tenant-renamed category facets |
| Status | Implemented |
| Package | `packages/plugins/source-ats-workday` |

## Problem

Spec 5159 recovered a Workday board's "Job Category" drop-down via the search
endpoint's `jobFamilyGroup` facet. Live probes of additional tenants show the
facet's `facetParameter` is **tenant-configurable**:

| Tenant board | Category facetParameter | Descriptor | Values |
| --- | --- | --- | --- |
| `recar:108:SLATEcareers` | `jobFamilyGroup` | "Job Category" | 13 |
| `zekelman:12:Careers` | `jobFamily` | "Job Family" | 14 |
| `wisk:108:Wisk_Careers` | `Department_Extended` | "Department" | 7 |

An exact match on `jobFamilyGroup` silently misses boards that renamed the
parameter, so no `department` is emitted for those tenants.

## Scope

- `packages/plugins/source-ats-workday/src/workday.constants.ts`
- `packages/plugins/source-ats-workday/src/workday.service.ts`
- `packages/plugins/source-ats-workday/src/workday.types.ts`
- `packages/plugins/source-ats-workday/__tests__/workday.service.spec.ts`

## Behavior

Facet discovery replaces the exact parameter match:

1. **Omit-list first.** A facet whose `facetParameter` is a known non-category
   field never qualifies — explicit set (`workerSubType`, `timeType`,
   `locations`, `locationCountry`, `locationRegionStateProvince`, `jobReqId`,
   `remote`, `brands`, `company`) plus a name guard matching
   `location|site|brand|compan|remote|subtype|timetype` for renamed
   location/type families.
2. **Category-word match.** A surviving facet qualifies when `facetParameter`
   **or** `descriptor` contains `categor|famil|depart` (case-insensitive).
   Covers `jobFamilyGroup`, `jobFamily`, `jobCategory`, `Department_Extended`,
   `departments`, and arbitrary tenant renames. Facets nested inside facet
   groups are candidates too (observed on live boards).
3. **Best coverage wins.** When several facets qualify (rare), the chosen one
   is the qualifier with the largest `sum(values[].count)` — most postings
   covered — rather than first-listed.
4. Everything else is unchanged: the chosen `facetParameter` drives
   `appliedFacets`, `WORKDAY_CATEGORY_FACET_CAP` bounds the value count, and
   the bucketed paginated pass is identical.

## Non-goals

- No multi-facet bucketing (qualifiers partition the same postings; one pass
  is enough).
- No change to the precedence chain (detail `jobFamily` → bucket → subtitles)
  or the two-stream parallelism from spec 5159.

## Contracts

- `department` emitted on boards whose category facet uses any
  category-worded parameter/descriptor, whatever the exact spelling.
- Zero extra requests when no facet qualifies — identical to spec 5159's
  facetless path.

## Test Plan

- Unit: `jobFamily`-parametered facet → department (zekelman shape).
- Unit: `Department_Extended`-parametered facet → department (wisk shape).
- Unit: omit-list — a known field labeled "Job Family" triggers **no**
  bucketed requests.
- Unit: two qualifying facets → the larger-coverage one is bucketed.
- Unit: category facet nested inside a facet group is found.
- Regression: the 5159 `jobFamilyGroup` suite keeps passing.
- Live: `zekelman:12:Careers` (183 jobs) and `wisk:108:Wisk_Careers` (7 jobs)
  emit departments.
