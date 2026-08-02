# Tasks: 5038 — iCIMS board rework

- [x] T1 — `icims.constants.ts`: `buildIcimsBoardUrl(subdomain, page)` for the
      embeddable `?ss=1&in_iframe=1&pr={page}` form; page-size/default/ceiling
      constants; headers; `Page X of N`, `Job Listings at {Company}`, numeric
      job-id regexes.
      AC: `pr` omitted for page 0, present for later pages; constants exported.
- [x] T2 — `icims.types.ts`: `IcimsListItem` (id/title/url/location parts/
      department/snippet/isRemote) + `IcimsBoardPage` (items/totalPages/company).
      AC: parse layer has no `JobPostDto` coupling.
- [x] T3 — Parse `.iCIMS_JobCardItem` via Cheerio: title (`h3`, anchor-title
      fallback with id prefix stripped), canonical URL + numeric id, location
      cell, Category header field, listing snippet; company from `<title>`;
      total pages from the pager.
      AC: query-stripped `jobUrl`; `atsId` = numeric id.
- [x] T4 — Walk `pr` from 0: de-dupe by id; stop on short/empty page, pager
      total, or `resultsWanted`; `ICIMS_MAX_PAGES` ceiling.
      AC: no request past the pager total; repeated ids de-duped.
- [x] T5 — Map to `JobPostDto`: `{country}-{state}-{city}` split (hyphenated
      cities preserved; `Remote` → `isRemote`), department, snippet description,
      company display name (subdomain fallback), canonical URL/id.
      AC: `companyName` is the board title, not the slug.
- [x] T6 — Resolve subdomain from `companySlug` (bare or URL) or `companyUrl`
      (`*.icims.com`); empty input → `[]`; unknown tenant (HTTP 4xx) → `[]`.
      AC: never throws on a single bad tenant.
- [x] T7 — Unit tests (mocked HTTP) per the spec test plan.
      AC: `npx jest source-ats-icims` green.
