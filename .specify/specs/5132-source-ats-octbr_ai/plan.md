# Plan 5132 — Source ATS Plugin: Octbr (octbr.ai)

## Phases

1. Scaffold `packages/plugins/source-ats-octbr_ai/` (package.json, tsconfig,
   index.ts, module, constants, types, service).
2. Register: `Site.OCTBR_AI = 'octbr_ai'`, `ALL_SOURCE_MODULES`,
   `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
3. Fixture-based unit tests.
4. Live check against the `starcloud` slug.

## Design

- `scrape(input)`: GET `https://<slug>.octbr.ai/` → extract `data-page`
  attribute → `JSON.parse` after HTML-unescape → `jobsByDepartment`.
- Per job: second GET to `job.url` → `props.job` for `description` /
  `responsibilities` / `requirements` / `posted_date`. Fanned out with
  `Promise.allSettled` after the `resultsWanted` cap; a failed detail fetch
  keeps the job with `description: null`.
- Errors: catch resolves `JobResponseDto(jobs, classifyScrapeError(err))`,
  matching the pinpoint pattern.

## Risks

- `data-page` is an Inertia-internal prop; a template change could move job
  data elsewhere — the `data-page` JSON parse is the single point of
  failure, so a parse failure is logged and returns 0 jobs.
- `posted_date` on the listing is relative ("1 month ago") — only the
  detail page carries an absolute date.
