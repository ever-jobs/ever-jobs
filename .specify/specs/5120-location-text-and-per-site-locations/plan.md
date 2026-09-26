# Plan: 5120 — `LocationDto.text` + per-site `locations[]` in six plugins

| Field | Value |
|---|---|
| Spec | 5120 |
| Slug | `location-text-and-per-site-locations` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5119 (`rippling-structured-locations`), 5118 (`ats-posting-country-code`) |

## Phases

1. **Models.** `LocationDto.text?: string | null` with JSDoc; placed after
   `name`. No other field touched; `displayLocation()` unchanged.
2. **Common parser.** In `parseLocationList`, wrap the per-site location as
   `new LocationDto({ ...location, text: normalized })` before pushing to
   `concrete`. The merged multi-site `location` and the remote/country-only
   paths are untouched, so they emit no `text`.
3. **Plugins — simple wiring** (`lever`, `workday`, `breezyhr`,
   `workatastartup`, `auroratech`): read `parsedLocations.locations` and emit
   `...(locations.length > 0 ? { locations } : {})` on the `JobPostDto`.
4. **Plugin — gusto-hosted:** the service flattens locations into an
   intermediate `GustoHostedDetailData`, so the field gains
   `locations: LocationDto[] | null`. The JSON-LD path maps each structured
   `jobLocation` entry to a `LocationDto` directly (no re-parse); the
   rendered-HTML path carries `parsedLocations.locations` through;
   `buildJobPost` emits it when non-empty.
5. **Tests.** Common-level `Spec 5120` block (recorded on parsed/unparsed,
   absent on merged and remote-only); one `locations[]` assertion per plugin.

## Packages touched

- `packages/models` — `LocationDto.text`.
- `packages/common` — `parseLocationList` records `text`; spec block in
  `location-parser.spec.ts`.
- `packages/plugins/source-ats-lever`, `source-ats-workday`,
  `source-ats-breezyhr`, `source-ats-workatastartup`,
  `source-company-aurora_tech` — one-line DTO wiring + test.
- `packages/plugins/source-ats-gusto-hosted` — service + types + tests.

## Risks

- `text` is additive, but it appears on `location` for single-site postings
  repo-wide (all ~30 `parseLocationList` callers), not only the six plugins —
  new key in the serialized DTO. No existing field changes value.
- `city` is unchanged, so the fallback path still carries an unparsed label
  under a field named `city`; `text` gives callers an honest source for that
  string rather than fixing the misuse.
- `source-ats-breezyhr` has a pre-existing `tsc` `rootDir` complaint when
  compiled standalone (`TS6059`, imports `@ever-jobs/common` sources);
  unrelated to this change.
