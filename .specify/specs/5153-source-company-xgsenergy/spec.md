# Spec: 5153

| Field | Value |
| ----- | ----- |
| Status | Done |
| Owner | ever-jobs maintainers |
| Plugin | `source-company-xgsenergy` |
| Site | `Site.XGSENERGY = 'xgsenergy'` |

## 1. Problem Statement

`xgsenergy.com` (XGS Energy, geothermal) publishes its openings at
`https://www.xgsenergy.com/careers/` — a WordPress/Elementor page with no
recognized ATS and no `JobPosting` JSON-LD. Ever-jobs has no plugin for the
site, so the 7 live postings are invisible to consumers.

## 2. Scope

- New source plugin `source-company-xgsenergy` under
  `packages/plugins/source-company-xgsenergy/`, registered in all four places
  (site enum, `plugins/index.ts`, `tsconfig.base.json` paths,
  `jest.config.js` moduleNameMapper).
- One static GET of the careers page; Cheerio over
  `div.elementor-accordion-item`.
- `companyDomains: ['xgsenergy.com']` declared to pre-claim the host.

## 3. Page Shape (verified live 2026-09-24)

- `/careers/` is a ~284 KB fully server-rendered WordPress page; no fetch to
  any backend API is needed and no headless render is required.
- Each of the 7 `div.elementor-accordion-item` blocks is one role. The
  accordion title (`a.elementor-accordion-title` / the tab labelled
  `id="elementor-tab-title-NNNN"`) reads `"{Title} Location {Place}"`; the
  literal ` Location ` marker separates title from location.
- Multi-site and remote qualifiers appear in the location fragment, e.g.
  `Seattle, WA / Austin, TX / Houston, TX` and `Houston, TX / Hybrid` —
  `/`-separated.
- Each item's `.elementor-tab-content` (id `elementor-tab-content-NNNN`,
  same `NNNN` as its title) contains the full posting: overview paragraph,
  Responsibilities / Requirements `ul` lists, and a closing line with a
  Cloudflare-obfuscated `mailto:` link.
- Apply is one shared mailbox rendered as `/cdn-cgi/l/email-protection#<hex>`
  / `.__cf_email__[data-cfemail]`; the first hex byte is the XOR key for the
  remaining bytes (decoded live to `info@xgsenergy.com`).
- No per-role pages, no `datePosted`, no `compensation`, no `department`.

## 4. Contract

Per posting, emit `JobPostDto` with:

- `id` / `atsId` = `xgsenergy-{slug-from-title}` (no native ids exist).
- `title` — the text before the ` Location ` marker.
- `companyName` = `XGS Energy`; `companyUrl` = `https://www.xgsenergy.com`.
- `jobUrl` / `jobUrlDirect` = `{careers page}#elementor-tab-title-{NNNN}` —
  the accordion tab id anchors directly to the role.
- `applyUrl` = `mailto:{decoded}` from the item's `data-cfemail` payload;
  fall back to a bare `mailto:` href, then the careers page.
- `location` / `locations[]` — each `/`-separated fragment through
  `parseLocationText`; a `hybrid` fragment is not a location — it sets
  `workFromHomeType: 'Hybrid'` instead.
- `description` — the `.elementor-tab-content` body via `htmlToPlainText`
  (headings + `ul/li` bullets).
- `site` = `Site.XGSENERGY`; `atsType` = `'xgsenergy'`.

Filtering honors `resultsWanted` / `searchTerm` / `location` / `offset`.
Zero accordion items → `empty` diagnostic; index fetch failure →
`classifyScrapeError`.

## 5. Non-Goals

- No `datePosted`, `compensation`, or `department` — the site publishes none.
- No per-role apply targets — a single shared mailbox serves all roles.
- No headless rendering — the DOM is complete in the static response.

## 6. Test Plan

Unit tests on a live-fetched fixture page:

- all 7 items mapped (title/location split, multi-site `locations[]`,
  `Hybrid` marker → `workFromHomeType`);
- anchor `jobUrl` per item;
- cfemail decode → shared mailto;
- description carries section headings + bullets;
- empty / error diagnostics;
- `searchTerm` / `location` / `resultsWanted`+`offset` filters.
