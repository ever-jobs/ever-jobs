# Plan: 5157

| Field | Value |
| ----- | ----- |
| Status | Done |
| Spec | `.specify/specs/5157-source-company-thoron_us/spec.md` |
| Affected packages | `source-company-thoron_us` (new), `models` (enum), `plugins` (registry), root tsconfig + jest config |

## 1. Approach

Two static GETs; the board is a JS literal inside the SPA bundle.

1. `fetchJobs` — GET `input.companyUrl` or `THORON_US_CAREERS_URL`; pull
   the `/assets/index-{hash}.js` script src from the shell; GET it;
   `parseJobsArray` → `ThoronJobEntry[]`.
2. `parseJobsArray` — anchored on the full entry field run
   `=[{id:\d+,title:"…",department:"…",location:"…",type:"` (other bundle
   arrays share `{…,title:"…"}` but not the id/department run), sliced by
   balanced brackets, never evaluated. Entries parsed field-by-field:
   scalar `id`/`title`/`department`/`location`/`type`; array
   `whatYoullDo`/`whatYouBring`/`niceToHaves`.
3. `toJobPost` — `thoron_us-{id}` ids; `department`;
   `location` → `parseLocationText`; `type` → `extractJobType` +
   `employmentType`; `description` composed from the three bullet
   sections; `jobUrl`/`jobUrlDirect`/`applyUrl` = careers URL.
4. `applyInput` — `resultsWanted`/`offset`/`searchTerm`.

## 2. Files

- `src/thoron-us.constants.ts`, `src/thoron-us.types.ts`,
  `src/thoron-us.service.ts`, `src/thoron-us.module.ts`, `src/index.ts`,
  `package.json`, `tsconfig.json`.
- `__tests__/fixtures/careers.html` (live shell),
  `__tests__/fixtures/index.js` (live bundle).
- `__tests__/thoron-us.service.spec.ts`.
- Registration: `site.enum.ts` (`THORON_US`, Phase 1711),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
- Docs: `docs/index.md` row, `docs/log.md` entry.

## 3. Risks

- **Bundle hash rotation** — resolved at fetch time from the shell, never
  hardcoded.
- **Array anchor collisions** — the anchor requires the full
  `id→title→department→location→type` run, so sibling literals
  (icon/feature arrays) can't match; entries additionally require
  `whatYoullDo`-family fields? No — require `id` + `title`; the array
  anchor already guarantees the shape.
