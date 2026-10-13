# Plan: 5156

| Field | Value |
| ----- | ----- |
| Status | Done |
| Spec | `.specify/specs/5156-source-company-int-dyn/spec.md` |
| Affected packages | `source-company-int-dyn` (new), `models` (enum), `plugins` (registry), root tsconfig + jest config |

## 1. Approach

One static GET of the one-page site; the board is the `#Careers` section.

1. `fetchJobs` — `client.get` `input.companyUrl` de-fragmented (or
   `INT_DYN_ORIGIN`), `cheerio.load`, `parseCareersPage` →
   `IntDynJobRow[]` `{title, tagline, bullets}`.
2. `parseCareersPage` — `div#Careers` → each
   `div.efi-pr-07-pricing-cell`: `h4.efi-h4-3` → title,
   `p.efi-big-paragraph-4` → tagline, `ul.list li.list-item` → bullets.
3. `toJobPost` — `int-dyn-{title-slug}` ids; `description` = tagline +
   `- `-bullets; `jobUrl`/`jobUrlDirect` = `/#Careers`; `applyUrl` = the
   site's shared contact mailto.
4. `applyInput` — `resultsWanted`/`offset`/`searchTerm`.

## 2. Files

- `src/int-dyn.constants.ts`, `src/int-dyn.types.ts`,
  `src/int-dyn.service.ts`, `src/int-dyn.module.ts`, `src/index.ts`,
  `package.json`, `tsconfig.json`.
- `__tests__/fixtures/index.html` (live one-pager).
- `__tests__/int-dyn.service.spec.ts`.
- Registration: `site.enum.ts` (`INT_DYN`, Phase 1710),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
- Docs: `docs/index.md` row, `docs/log.md` entry.

## 3. Risks

- **Pricing-cell reuse**: the careers cards are the site's pricing-cell
  component — scoped under `div#Careers` so sibling sections can't leak
  in.
- **Fragment URLs**: `companyUrl` arrives as `…/#Careers`; the hash is
  stripped for the fetch (a fragment isn't fetchable) but kept in
  `jobUrl`.
