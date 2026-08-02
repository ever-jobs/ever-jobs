# Tasks: 5046 — source-company-nanonuclearenergy

| Field | Value |
| --- | --- |
| Spec ID | 5046 |
| Slug | source-company-nanonuclearenergy |
| Status | implemented |

- [x] T1 — Scaffold `source-company-nanonuclearenergy` package (package.json, tsconfig.json, index.ts, module, constants, types).
      AC: package resolves via tsconfig path; module exports service.
- [x] T2 — WP REST ingest: GET `…/wp-json/wp/v2/pages?slug=careers`; take `pages[0].content.rendered`; missing/empty → empty, no throw.
      AC: response typed; failure and no-page paths return empty with a warning.
- [x] T3 — Divi block parser: walk `.et_pb_blurb, .et_pb_text` in order; h4 blurb opens a role, next text module is body, label blurbs fill meta.
      AC: each role block yields one job; a blurb without an h4 never creates a job.
- [x] T4 — Description assembly: subtitle (bolded) + body via shared `markdownConverter`.
      AC: subtitle and body text both present in the description.
- [x] T5 — Salary normalization + yearly interval: repair Word-paste artifacts, rebuild `$min - $max`, parse with `CompensationInterval.YEARLY`.
      AC: `$120,000 - $160,000`, `$1 48 ,000`, `$ 130,000`, and `99,000 - $131,000` all parse to the right yearly min/max.
- [x] T6 — DTO mapping: title, companyName (constant), companyUrl/jobUrl (careers page), location, isRemote, employmentType + jobType, compensation, datePosted null, body emails; subtitle-disambiguated id.
      AC: repeated `Nuclear Engineer` titles get distinct ids; location parses to Oak Brook, IL.
- [x] T7 — Input handling: searchTerm/location/isRemote/jobType filters; offset/resultsWanted slice.
      AC: searchTerm narrows to matching roles; resultsWanted caps count.
- [x] T8 — Register in four places (Site enum, ALL_SOURCE_MODULES, tsconfig paths, jest mapper).
      AC: `api` build compiles with NanonuclearenergyModule; module import resolves.
- [x] T9 — Unit tests (mocked WP REST): role parsing, id disambiguation, clean + artifact salary repair, body email, empty/no-page/failure paths, filters.
      AC: all tests green.
- [x] T10 — Live smoke on nanonuclearenergy.com.
      AC: 14 roles with title/location/type/description/yearly compensation.
- [x] T11 — Docs: spec/plan/tasks; update `docs/index.md` + `docs/log.md`.
      AC: index lists 5046; log has newest-at-top entry.
