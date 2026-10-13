# Spec: 5154

| Field | Value |
| ----- | ----- |
| Status | Done |
| Owner | ever-jobs maintainers |
| Plugin | `source-company-revoy` |
| Site | `Site.REVOY = 'revoy'` |

## 1. Problem Statement

`revoy.com` (Revoy, electric freight) lists openings at
`https://www.revoy.com/join-the-team` — a Webflow splash page whose role
links point to public Google Docs, not an ATS and not per-role pages.
Ever-jobs has no plugin for the site.

## 2. Scope

- New source plugin `source-company-revoy` under
  `packages/plugins/source-company-revoy/`, registered in all four places.
- One static GET of the index + one `export?format=txt` GET per doc link
  (3 fetches today).
- `companyDomains: ['revoy.com']` declared.

## 3. Page Shape (verified live 2026-09-24)

- `/join-the-team` is a ~20 KB server-rendered Webflow page. Each open role
  is a `.text-label-medium` div containing
  `a.link-12[href^="https://docs.google.com/document/d/…/edit"]` — the link
  text is the title and a literal ` — City, ST` follows it.
- 2 live links: Head of Finance — Portland, OR; Lead Supply chain Engineer
  — Portland, OR.
- Each doc is world-readable: `GET
  https://docs.google.com/document/d/{id}/export?format=txt` returns 200
  `text/plain` — the full posting (6.3 KB / 3.7 KB).
- Doc bodies carry semi-structured headers. Doc 2 uses labeled lines
  (`Location: Troutdale, OR (on-site)`, `Reports to: CTO`,
  `Department: Operations / Engineering`, `Type: Full-time`); doc 1 uses
  unlabeled all-caps blocks (`REPORTS TO CEO`, `LOCATION Portland, OR`,
  `FUNCTION Finance`, `STAGE Build from zero`).
- No `datePosted`, no `compensation`, no per-role apply target — the doc
  link itself is the role's canonical URL.

## 4. Contract

Per role:

- `id` / `atsId` = `revoy-{docId}` (doc ids are stable; title edits can't
  break them).
- `title` = the link text.
- `companyName` = `Revoy`; `companyUrl` = `https://www.revoy.com`.
- `jobUrl` / `jobUrlDirect` / `applyUrl` = the doc link (no other apply
  target exists).
- `location` = the doc's `Location:`/`LOCATION` value when labeled
  (on-site qualifier → `workFromHomeType: 'On Site'`), else the link's
  ` — City, ST` — both through `parseLocationText`.
- `department` = the doc's `Department:`/`FUNCTION` value when labeled.
- `employmentType` + `jobType` = the doc's `Type:` value when labeled
  (`extractJobType` for the enum, raw value kept).
- `description` = the doc's plain-text body.
- `site` = `Site.REVOY`; `atsType` = `'revoy'`.

Filtering honors `resultsWanted` / `searchTerm` / `location` / `offset`.
Zero doc links → `empty`; index failure → `classifyScrapeError`; a doc
fetch failure degrades to the link-only fields (title + link location),
never aborts the scrape.

## 5. Non-Goals

- No `datePosted`, `compensation` — the site/docs publish none.
- No headless rendering — index and docs are plain GETs.
- No `Reports to:`/`STAGE` fields — no `JobPostDto` slot; they remain in
  the description text.

## 6. Test Plan

Unit tests on live-fetched fixtures (index + 2 doc text exports):

- both roles mapped (link title + link location);
- doc-text description on each role;
- labeled-header fields override link values (Troutdale vs Portland link,
  `(on-site)` → `workFromHomeType`, `Department`, `Type`);
- doc fetch failure degrades gracefully;
- `id` = `revoy-{docId}`; `jobUrl`/`applyUrl` = doc link;
- empty / error diagnostics; input filters.
