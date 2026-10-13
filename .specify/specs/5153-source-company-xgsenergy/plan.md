# Plan: 5153

| Field | Value |
| ----- | ----- |
| Status | Done |
| Spec | `.specify/specs/5153-source-company-xgsenergy/spec.md` |
| Affected packages | `source-company-xgsenergy` (new), `models` (enum), `plugins` (registry), root tsconfig + jest config |

## 1. Approach

Mirror the established `source-company-*` single-page pattern
(`thermwood`, `ampflame`): one `createHttpClient` GET of the careers page,
Cheerio parse, per-item `JobPostDto`.

1. `fetchJobs` — `client.get` the careers URL (`input.companyUrl` override),
   `cheerio.load`, `parseItems`.
2. `parseItems` — each `div.elementor-accordion-item`:
   - title element `a.elementor-accordion-title` → text; split on
     ` Location ` → `{title, locationFrag}`;
   - the tab's `id="elementor-tab-title-NNNN"` → `jobUrl` anchor;
   - sibling `.elementor-tab-content` → description + cfemail apply link.
3. Location fragments split on `/`; `hybrid` → `workFromHomeType`, the rest
   through `parseLocationText` into `locations[]` (first = `location`).
4. `decodeCfEmail` — first byte is the XOR key (validated to contain `@`);
   fallback chain `email-protection#hex` → bare `mailto:` → careers page.
5. `applyInput` — `resultsWanted`/`offset`/`searchTerm`/`location` filters.

## 2. Files

- `src/xgsenergy.constants.ts` — URL, selectors, regexes.
- `src/xgsenergy.types.ts` — `XgsEnergyJobRef` internal type.
- `src/xgsenergy.service.ts` — `IScraper` implementation.
- `src/xgsenergy.module.ts`, `src/index.ts`, `package.json`, `tsconfig.json`.
- `__tests__/fixtures/careers.html` — live-fetched page.
- `__tests__/xgsenergy.service.spec.ts`.
- Registration: `site.enum.ts` (`XGSENERGY`, Phase 1707),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
- Docs: `docs/index.md` row, `docs/log.md` entry.

## 3. Risks

- **Title/location split**: titles containing the literal " Location " would
  mis-split — live data shows none; the split takes the LAST occurrence only
  if titles could contain it. Implementation splits on the first
  ` Location ` match per live shape; titles are read from the accordion
  heading text.
- **Unstable anchor ids**: `elementor-tab-title-NNNN` ids may renumber on
  rebuild; they are anchors only, never stored ids (ids derive from title
  slug).
- **cfemail**: shared decoder shape copied from the soundryx plugin — kept
  local per repo convention.

## 4. Validation

`npx jest source-company-xgsenergy`; `npx tsc --project
tsconfig.typecheck.json --noEmit`; `npm run lint:docs`; live run against
`xgsenergy.com/careers/` expecting 7 roles.
