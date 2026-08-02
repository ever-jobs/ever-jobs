# Plan: 5046 — source-company-nanonuclearenergy

| Field | Value |
| --- | --- |
| Spec ID | 5046 |
| Slug | source-company-nanonuclearenergy |
| Status | implemented |

## Approach

Single-company plugin for NANO Nuclear Energy (`nanonuclearenergy.com`). Read the
WordPress REST API for the careers page (`?slug=careers`), take its
`content.rendered` Divi markup, and parse the role blurbs with Cheerio (no
headless browser, no ATS). Company constants (WordPress host, page slug) are
baked in; `companySlug` is ignored.

## Phases

1. **Scaffold package** — `package.json`, `tsconfig.json`, `index.ts`,
   `nanonuclearenergy.module.ts`, `nanonuclearenergy.constants.ts`,
   `nanonuclearenergy.types.ts`.
2. **WP REST ingest** — GET `…/wp-json/wp/v2/pages?slug=careers`; take
   `pages[0].content.rendered`; empty/missing → empty result with a warning.
3. **Divi block parser** — walk `.et_pb_blurb, .et_pb_text` in document order: a
   blurb with an `h4` opens a role (title + optional subtitle); the next text
   module is its body; label-prefixed blurbs (`Full Time` / `Location - …` /
   `Salary: …`) fill its meta. Stop attaching body once meta starts.
4. **Description assembly** — subtitle (bolded) + body rendered to markdown via
   the shared `markdownConverter` (reused Turndown instance).
5. **Salary normalization** — repair Word-paste artifacts (space after `$`,
   spaces inside a number group, missing `$` on one end), rebuild `"$min - $max"`
   from the first two numeric groups, then parse with an explicit
   `CompensationInterval.YEARLY` hint (all roles state an annual base).
6. **DTO mapping** — title, companyName (constant), companyUrl/jobUrl (careers
   page), location via shared `parseLocationList`, employmentType (raw) + jobType
   via `getJobTypeFromString`, yearly compensation, `datePosted:null`, body
   emails.
7. **Input handling** — apply `searchTerm`/`location`/`isRemote`/`jobType`
   filters and `offset`/`resultsWanted` slice.
8. **Register** — Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper.
9. **Tests + smoke** — unit tests on a mocked WP REST fixture; live smoke on the
   14 roles.
10. **Docs** — this spec/plan/tasks; `docs/index.md` + `docs/log.md`.

## Packages touched

- `packages/plugins/source-company-nanonuclearenergy/**` (new)
- `packages/models/src/enums/site.enum.ts` (enum value)
- `packages/plugins/index.ts` (module registration)
- `tsconfig.base.json`, `jest.config.js` (path aliases)

## Risks / mitigations

- **Divi markup drift** — parsing is anchored on stable Divi class names
  (`et_pb_blurb`, `et_pb_module_header`, `et_pb_blurb_description`,
  `et_pb_text_inner`) and label prefixes rather than positional indexes, so
  adding/removing a role does not shift the parse. A blurb without an `h4` is
  treated as meta, never as a role, so decorative blurbs cannot create phantom
  jobs; a page with no role blurbs → empty with a warning.
- **Dirty salary text** — the pay prose is Word-pasted with artifacts. Normalized
  before parsing (see phase 5); the interval is authoritative (`YEARLY`) rather
  than guessed from magnitude via the shared `ExtractSalaryOptions.interval` hint
  (Spec 5018). Unrepairable text → compensation omitted (no fabrication).
- **No per-role URL / date** — the page exposes neither, so `jobUrl` is the
  careers page and `datePosted` is `null`; ids fold in the subtitle so the two
  repeated `Nuclear Engineer` titles stay distinct.
- **API availability** — a failed request returns empty (no throw), matching the
  batch-resilience contract of the other adapters.
- **Not over-generalising** — kept single-company; WordPress transport is uniform
  but the Divi content model is bespoke. A shared `source-wpjobmanager` plugin is
  justified only if a cohort of WP-Job-Manager sites (uniform schema) appears —
  YAGNI now.
