# Tasks: 5120 — `LocationDto.text` + per-site `locations[]` in six plugins

| Field | Value |
|---|---|
| Spec | 5120 |
| Slug | `location-text-and-per-site-locations` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5119 (`rippling-structured-locations`), 5118 (`ats-posting-country-code`) |

- [x] T01 — `LocationDto.text?: string | null` in `packages/models`; `displayLocation()` unchanged.
- [x] T02 — `parseLocationList` records the normalized label as `text` on every concrete per-site location; merged/remote-only paths unchanged.
- [x] T03 — Emit `locations` from `source-ats-lever`, `source-ats-workday`, `source-ats-breezyhr`, `source-ats-workatastartup`, `source-company-aurora_tech`.
- [x] T04 — `source-ats-gusto-hosted`: `locations` through `GustoHostedDetailData`; JSON-LD sites mapped structurally; emitted on `JobPostDto`.
- [x] T05 — Common-level `Spec 5120` tests + a per-plugin `locations[]` assertion; fix the workatastartup country-code expectation.
- [x] T06 — Focused jest + `tsc --noEmit` on touched packages; `npm run lint:docs`; `docs/index.md` row + `docs/log.md` top entry.
