# Plan: 5044 — source-notion

| Field | Value |
| --- | --- |
| Spec ID | 5044 |
| Slug | source-notion |
| Status | implemented |

## Approach

Wire Notion like an ATS: one shared `Site.NOTION` plugin, keyed by the Notion
page id (`id_at_job_host`). Read the public `loadPageChunk` JSON API; no headless
browser. Child-page mode only (Stone Power's shape); collection-view is an
explicit, un-built extension point.

## Phases

1. **Scaffold package** — `package.json`, `tsconfig.json`, `index.ts`,
   `notion.module.ts`, `notion.constants.ts`, `notion.types.ts`.
2. **API ingest** — `loadPageChunk` POST helper; tolerant block resolver that
   handles both `{ role, value }` and `{ value: { role, value } }` envelopes and
   dashed/dashless record keys.
3. **Child-page enumeration** — from the root page's `content`, keep `type:"page"`
   children as roles (titles are inlined in the root chunk; no extra fetch).
4. **Detail fetch** — bounded fan-out (`Promise.allSettled`, concurrency 5) over
   role sub-pages; per role, walk blocks in order into a description, drop the
   title-duplicating header, capture the labelled `Location:` line, read
   `created_time`.
5. **DTO mapping** — title, company name (`Careers at X` → `X`), jobUrl
   (subdomain when known else `www.notion.so`), location (on-site token stripped;
   remote/hybrid via shared parser), best-effort compensation, datePosted,
   emails → mailto apply.
6. **Input handling** — resolve page id from `companySlug`/`companyUrl`; apply
   `searchTerm`/`location`/`isRemote`/`jobType` filters and `offset`/`resultsWanted`.
7. **Register** — Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest mapper.
8. **Tests + smoke** — unit tests on mocked chunks; live smoke on Stone Power.
9. **Docs** — this spec/plan/tasks; `docs/index.md` + `docs/log.md`.

## Packages touched

- `packages/plugins/source-notion/**` (new)
- `packages/models/src/enums/site.enum.ts` (enum value)
- `packages/plugins/index.ts` (module registration)
- `tsconfig.base.json`, `jest.config.js` (path aliases)

## Risks / mitigations

- **Layout variance** — only child-page mode is built. Detect "no child-page
  roles" → warn + empty rather than mis-parse; collection-view added when a real
  tenant appears.
- **Field convention variance** — location/comp are author conventions, not
  Notion standards. Title + description + jobUrl always resolve; location/comp
  degrade gracefully (never company-name branching).
- **API shape drift** — block-envelope resolver tolerates both known shapes and
  id-key forms; parsing failures per role are isolated by `allSettled`.
