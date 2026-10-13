# Spec: 5156

| Field | Value |
| ----- | ----- |
| Status | Done |
| Owner | ever-jobs maintainers |
| Plugin | `source-company-int-dyn` |
| Site | `Site.INT_DYN = 'int-dyn'` |

## 1. Problem Statement

`int-dyn.com` (Integrated Dynamics, chemicals / precision fermentation)
is a one-page Webflow site whose `#Careers` section lists open roles as
reused pricing-cell cards — no ATS, no per-role pages, minimal published
data. Ever-jobs has no plugin for the site.

## 2. Scope

- New source plugin `source-company-int-dyn` under
  `packages/plugins/source-company-int-dyn/`, registered in all four places.
- One static GET of `int-dyn.com` — the careers section is fully in the
  served HTML.
- `companyDomains: ['int-dyn.com']` declared. `Site.INT_DYN = 'int-dyn'`
  keeps the literal dash per Spec 5069 (only dots become underscores).

## 3. Page Shape (verified live 2026-09-25)

- `int-dyn.com` is a ~15 KB single-page site; `div#Careers.careerpage`
  holds the board.
- `div.efi-pr-07-pricing-cell` — 2 live cards: Synthetic Biologist,
  Fermentation Specialist.
- Per card: `h4.efi-h4-3` → title; `p.efi-big-paragraph-4` → tagline
  (`Make microbes do what we want.`); `ul.list li.list-item` → 3 bullets
  of responsibilities.
- The only apply target anywhere on the page is the generic
  `Contact → mailto:hmarkarian@int-dyn.com?subject=I'm interested.`.
- No `location`, `department`, `datePosted`, `compensation` — not
  published. Chicago, IL is company HQ, not a stated job location.

## 4. Contract

Per card:

- `id` / `atsId` = `int-dyn-{title-slug}` (no native ids).
- `title` = `h4.efi-h4-3`.
- `description` = tagline + bullets (`- ` prefixed), `\n\n`-joined.
- `jobUrl` / `jobUrlDirect` = `https://www.int-dyn.com/#Careers`.
- `applyUrl` = the shared contact mailto.
- `site` = `Site.INT_DYN`; `atsType` = `'int-dyn'`.

Filtering honors `resultsWanted` / `searchTerm` / `offset`. `companyUrl`
input is de-fragmented for the fetch (the board is a `#Careers` anchor on
the one-pager). Zero cards → `empty`; fetch failure →
`classifyScrapeError`.

## 5. Non-Goals

- No `location` (HQ default would be invented data), `department`,
  `datePosted`, `compensation`, `jobType`, `workFromHomeType` — not
  published.
- No per-role apply deep-links — only the shared mailto exists.
- No headless rendering — one static GET.

## 6. Test Plan

Unit tests on a live-fetched fixture (the one-pager):

- both cards mapped with titles, tagline + bullet descriptions;
- `id` = `int-dyn-{slug}`; `jobUrl` = `/#Careers`;
  `applyUrl` = the contact mailto;
- `companyUrl` fragment stripped for the fetch;
- empty / error diagnostics; input filters.
