# Plan: 5154

| Field | Value |
| ----- | ----- |
| Status | Done |
| Spec | `.specify/specs/5154-source-company-revoy/spec.md` |
| Affected packages | `source-company-revoy` (new), `models` (enum), `plugins` (registry), root tsconfig + jest config |

## 1. Approach

Two-level static fetch — index page then each linked Google Doc.

1. `fetchJobs` — `client.get` the careers page (`input.companyUrl`
   override), `cheerio.load`, `parseIndex` → `RevoyJobRef[]` `{docId,
   docUrl, title, linkLocation}`.
2. Per ref — `client.get` `export?format=txt` (`.catch(() => null)` so a
   doc outage degrades to link-only fields), `parseDoc` → merge.
3. `parseIndex` — `a.link-12[href*="/document/d/"]` (doc-id regex on href);
   title = link text; trailing ` — City, ST` on the parent text →
   `linkLocation`.
4. `parseDoc` — labeled-header regexes on the plain text:
   `Location:`/`LOCATION`, `Department:`/`FUNCTION`, `Type:`/`EMPLOYMENT`,
   optional `(on-site)`/`(onsite)`/`(remote)` qualifier →
   `workFromHomeType`; remaining text = `description`.
5. `applyInput` — `resultsWanted`/`offset`/`searchTerm`/`location`.

## 2. Files

- `src/revoy.constants.ts`, `src/revoy.types.ts`,
  `src/revoy.service.ts`, `src/revoy.module.ts`, `src/index.ts`,
  `package.json`, `tsconfig.json`.
- `__tests__/fixtures/{join-the-team.html,doc-finance.txt,doc-supplychain.txt}`.
- `__tests__/revoy.service.spec.ts`.
- Registration: `site.enum.ts` (`REVOY`, Phase 1708),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
- Docs: `docs/index.md` row, `docs/log.md` entry.

## 3. Risks

- **Freeform doc headers**: labels vary per doc (`Location:` vs `LOCATION`,
  `Department` vs `FUNCTION`) — covered by alternation regexes; unlabeled
  docs degrade to link fields, never fail.
- **Doc fetch 404/unpublished**: `.catch` → link-only job (still emitted;
  title+location from the index row).
- **Link label split**: ` — ` em-dash separator is the site's own
  typography — fallback `,` split if a future row drops the dash.

## 4. Validation

`npx jest source-company-revoy`; `npx tsc --project
tsconfig.typecheck.json --noEmit`; `npm run lint:docs`; live run expecting
2 roles with full descriptions.
