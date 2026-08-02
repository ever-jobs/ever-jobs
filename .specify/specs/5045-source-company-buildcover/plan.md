# Plan: 5045 — source-company-buildcover

| Field | Value |
| --- | --- |
| Spec ID | 5045 |
| Slug | source-company-buildcover |
| Status | implemented |

## Approach

Single-company plugin for Cover (`buildcover.com`). Read the company's public
Sanity query API (no ATS, no headless browser); map the structured `career`
documents to `JobPostDto`. Company constants (`projectId`, `dataset`, base URL)
are baked in; `companySlug` is ignored.

## Phases

1. **Scaffold package** — `package.json`, `tsconfig.json`, `index.ts`,
   `buildcover.module.ts`, `buildcover.constants.ts`, `buildcover.types.ts`.
2. **Sanity ingest** — build the GROQ query URL
   (`{projectId}.apicdn.sanity.io/{apiVersion}/data/query/{dataset}?query=…`);
   one GET returns `{ contactEmail, careers[] }`.
3. **Portable-Text walker** — render a block array to markdown-ish text
   (heading `style` → `#`…`####`, `blockquote` → `>`, `listItem` bullet/number →
   `- `/`1. `), joining span text; skip empty blocks.
4. **Description assembly** — concatenate the sections in the site's own order
   and labels: `Overview` (`overview`), `Role` (`role`), `Experience`
   (`experience`), each `extraSections[]` under its own `title`, then
   `Compensation` (`compensation`).
5. **DTO mapping** — title, companyName (constant `Cover`), jobUrl
   (`/careers/<slug>/`), location (on-site token stripped; remote/hybrid via
   shared parser), employmentType (raw `type`) + jobType via
   `getJobTypeFromString`, best-effort compensation from the compensation text,
   datePosted from `_createdAt`, apply email from `careersPage.contactEmail`
   (body-email fallback) → mailto.
6. **Input handling** — apply `searchTerm`/`location`/`isRemote`/`jobType`
   filters and `offset`/`resultsWanted` slice.
7. **Register** — Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper.
8. **Tests + smoke** — unit tests on a mocked GROQ response; live smoke on
   buildcover.
9. **Docs** — this spec/plan/tasks; `docs/index.md` + `docs/log.md`.

## Packages touched

- `packages/plugins/source-company-buildcover/**` (new)
- `packages/models/src/enums/site.enum.ts` (enum value)
- `packages/plugins/index.ts` (module registration)
- `tsconfig.base.json`, `jest.config.js` (path aliases)

## Risks / mitigations

- **Schema drift** — the plugin targets Cover's own Sanity schema. Missing/renamed
  fields degrade gracefully: title + jobUrl always resolve; body sections that are
  absent are skipped; a role fetch that returns nothing → empty with a warning.
- **Compensation variance** — comp is prose; `salaryToCompensation` best-effort
  extracts a range when present, else `compensation` is omitted (no fabrication).
  The per-unit token (`/hr`, `/yr`, …) is read from the prose and passed to the
  shared parser as an **explicit interval** (new `ExtractSalaryOptions.interval`,
  Spec 5018), so the pay period comes from the authoritative token rather than
  being guessed from the amount's magnitude. Unicode dashes are normalised and
  the token stripped from the numeric input (the number regex cannot span a
  `/hr` sitting between the amount and the separator), but the token's meaning
  survives as the interval. This fixes the magnitude-heuristic failure class
  (`$28,000/yr` → yearly not monthly; `$1,200/wk` → weekly, unrepresentable by
  magnitude). The raw compensation prose stays verbatim in the description.
- **API/CDN availability** — a failed query returns empty (no throw), matching the
  batch-resilience contract of the other adapters.
- **Not over-generalising** — kept single-company; the Sanity transport + Portable
  -Text helpers are separable for a future `@ever-jobs/common` lift if a second
  Sanity tenant appears (not built now — YAGNI).
