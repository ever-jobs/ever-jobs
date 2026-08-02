# Plan: 5055 — source-ats-successfactors Career Site Builder reader

| Field | Value |
| --- | --- |
| Spec ID | 5055 |
| Slug | source-ats-successfactors-csb |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Approach

Extend the existing `source-ats-successfactors` plugin in place (no new package —
CSB is another surface of the same ATS). Add a CSB read path between the OData
path and the native careersection fallback, gated by a deterministic switch in
`scrape()`.

## Packages touched

- `packages/plugins/source-ats-successfactors` (only)
  - `src/successfactors.constants.ts` — CSB constants, URL builder, base-URL
    resolver, fingerprint helper, job-link regex.
  - `src/successfactors.types.ts` — `SfCsbListItem`, `SfCsbDetail`.
  - `src/successfactors.service.ts` — CSB reader (list pagination, bounded detail
    fan-out, microdata parse, mapping) + updated `scrape()` switch; OData/HTML
    scrape methods promoted to `protected` seams for testability.
  - `__tests__/successfactors-csb.service.spec.ts` — new unit suite.

No changes to the four registration points — the plugin already owns
`Site.SUCCESSFACTORS` and its aliases (this is an extension, not a new plugin).

## Phases

1. **Constants + types** — CSB page size / caps / concurrency, `buildSfCsbTileUrl`,
   `resolveCsbBaseUrl`, `htmlLooksLikeCsb`, `SF_CSB_JOB_LINK_RE`; list/detail
   interfaces.
2. **Switch** — rework `scrape()` to OData → CSB → careersection, tolerating a
   missing slug (CSB-only) and a missing portal (OData-only).
3. **CSB reader** — `collectCsbTiles` (paginate + de-dupe), `parseCsbTiles`,
   `fetchCsbDetails` (bounded `Promise.allSettled`), `parseCsbDetail` (microdata),
   `toCsbJobPost` (mapping), `formatDescription`, `absoluteUrl`, protected fetch
   seams (`fetchCsbTileHtml`, `fetchCsbDetailHtml`).
4. **Tests** — captured-HTML fixtures via the protected seams; helper unit tests.
5. **Docs** — `docs/index.md`, `docs/log.md`, `docs/ATS_INTEGRATIONS.md`,
   `docs/questions.md`.

## Risks

- **Selector drift.** CSB themes are per-tenant skins over a common engine; tile
  markup varies but the `/job/{slug}/{jobId}/` link shape and JobPosting
  microdata are engine-level and stable. Parsing keys on those, not on theme
  classes.
- **Sub-path-hosted portals.** The base is taken as the origin; a portal served
  under a path would need the path preserved. Logged as an open question.
- **No `employmentType` on CSB.** Left null on this path (OData still maps it).