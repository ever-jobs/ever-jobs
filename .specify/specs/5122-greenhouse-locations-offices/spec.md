# Spec 5122 — Greenhouse per-site `locations[]` + `offices[]` (`OfficeDto`)

| Field | Value |
|---|---|
| Spec | 5122 |
| Slug | `greenhouse-locations-offices` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 5119 (`rippling-structured-locations`), 5120 (`location-text-and-per-site-locations`), 5121 (`ashby-adp-rdw-locations`), 5027 (structured remote evidence) |

## Problem

`source-ats-greenhouse` loses two distinct kinds of per-site data:

- `location.name` packs multiple sites into one free-text string. The plugin
  already splits it (`locationLabels` on `;`, ` or `, newlines) and feeds the
  segments to `parseLocationList`, but then keeps only the merged `location`
  and discards the per-site `locations[]`. Real packed labels: `"Rockville, MD
  or Hawthorne, CA or Tulsa, OK"`, `"Alameda, CA, Albuquerque, NM; Oak Ridge
  TN"`, `"Denver, CO;San Francisco, CA;New York, NY;Los Angeles, CA;Seattle,
  WA;Toronto, Ontario, CAN - Remote"`, plus remote-flavored labels
  (`"United States (Remote)"`, `"Florida-Remote"`, `"Remote/Hybrid"`, and the
  observed wire typo `"Remote/Hybird"`).
- `job.offices[]` is a separate company-office catalog tagged on the posting —
  real names observed: `"US"` (with `location: "Emeryville, California,
  United States"`), `"Quantum Space - Rockville, MD (HQ)"`, `"Seurat HQ"`,
  `"HQ (190 Tasman)"`, `"Alameda HQ (707 West Tower Avenue, Suite A, Alameda,
  CA 94501)"`, `"Bellevue Office, Sunset Corporate Campus"`, `"Any location"`,
  `"Multiple Locations"`, `"Remote "`. Today it is used only as (a) a
  fallback for a missing `location.name` and (b) remote-sensing labels. A
  corpus pass over cached public board-API payloads (29 domains, 1108 jobs)
  shows offices are present on ~98% of jobs, always at the job level, with a
  partial overlap against `location.name` — per-job segment count vs office
  count splits 978 equal / 69 locs>off / 61 locs<off — so offices are
  neither a subset nor a superset of the posting's sites and must not be
  merged into `locations[]` (that would fabricate role-sites the label never
  named).

## Scope

- `packages/models`: new `OfficeDto` (extends `LocationDto`, adds `id`);
  `JobPostDto.offices?: OfficeDto[]`; `RawJobSchema.offices` mirror.
- `source-ats-greenhouse` (public board path): emit `locations` =
  `parsedLocations.locations`; emit `offices` = one `OfficeDto` per wire
  office.
- `source-ats-greenhouse` (Harvest path): same `locations` emission and
  `offices` mapping (Harvest office `location` is `{name}`).

## Non-goals

- Changing merged `location`, `isRemote`, or `workFromHomeType` — the
  `officeLabels` + `"Work Location"` metadata remote-evidence path (Spec
  5027) is untouched.
- Reinterpreting `or`-chains vs `;`/`newline` segments (either-site vs
  all-sites distinction is unrecoverable; segments are preserved verbatim in
  `text`).
- Splitting comma-packed single labels (`"Toronto, Ontario, CAN"`).

## Contracts

### `locations[]`

- One entry per `locationLabels` segment of `location.name`; `text` = the
  segment verbatim; `city`/`state`/`country` from `parseLocationList`.
- `location` (merged) unchanged.

### `offices[]` (per office)

- `id` = wire office id as string; `name` = `office.name` verbatim
  (whitespace-normalized); `text` = `office.location` verbatim when the wire
  carries one (public shape: string; Harvest shape: `{name}`) — so `name`
  and `text` keep distinct provenance.
- Geography: from `office.location` when present; otherwise from the last
  `" - "` segment of `office.name` minus parentheticals — a parsed `city` is
  accepted only when the segment looks geographic (state/country parsed, or
  no site-name keyword and no digits). Remote-tokens and pseudo-sites
  (`Any location`, `Multiple Locations`) yield no geography.
- A trailing `(...)` group containing a digit is an address:
  `street, city, ST zip` is unpacked into `streetAddress`/`city`/`state`/
  `postalCode`; anything else is kept verbatim in `streetAddress` with a ZIP
  extracted when present.
- Deduped on `id ?? name|text`.

## Test plan

- `or`-packed label → 3 `locations[]` entries with per-segment `text`;
  merged `location` unchanged.
- Office `{name:"US", location:"Emeryville, California, United States"}` →
  `name:"US"`, `text` = location verbatim, `city:"Emeryville"`.
- `"Alameda HQ (707 West Tower Avenue, Suite A, Alameda, CA 94501)"` →
  `streetAddress`/`postalCode`/`city`/`state` unpacked, `name` verbatim.
- `"Quantum Space - Rockville, MD (HQ)"` → `city:"Rockville"`, `state:"MD"`.
- Offices do not mint `locations[]` entries; site-keyword offices
  (`"Denver Office"`) produce no fabricated geography.
- Remote-tag office (`"Remote "`) emits `{name:"Remote"}` with no geography;
  `isRemote` still true.
- Existing suite stays green.
