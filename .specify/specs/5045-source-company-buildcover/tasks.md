# Tasks: 5045 — source-company-buildcover

| Field | Value |
| --- | --- |
| Spec ID | 5045 |
| Slug | source-company-buildcover |
| Status | implemented |

- [x] T1 — Scaffold `source-company-buildcover` package (package.json, tsconfig.json, index.ts, module, constants, types).
      AC: package resolves via tsconfig path; module exports service.
- [x] T2 — Sanity GROQ ingest: build the query URL from projectId/dataset/apiVersion; one GET returns `{ contactEmail, careers[] }`.
      AC: URL encodes the GROQ query; response typed; failure → empty, no throw.
- [x] T3 — Portable-Text walker: block array → markdown-ish text (heading styles, blockquote, bullet/number lists), span text joined, empty skipped.
      AC: a heading + bullet + paragraph render to `## …` / `- …` / plain text.
- [x] T4 — Description assembly in the site's order/labels: Overview, Role, Experience, extraSections (own title), Compensation.
      AC: sections present in the doc appear under their labels; absent sections omitted.
- [x] T5 — DTO mapping: title, companyName (`Cover`), jobUrl `/careers/<slug>/`, location (on-site stripped), isRemote, employmentType + jobType, compensation, datePosted, apply email → mailto.
      AC: a role with `$35.00/hr – $40.00/hr` yields a compensation; `join@buildcover.com` apply; datePosted set.
- [x] T6 — Input handling: searchTerm/location/isRemote/jobType filters; offset/resultsWanted slice.
      AC: searchTerm narrows to matching roles; resultsWanted caps count.
- [x] T7 — Register in four places (Site enum, ALL_SOURCE_MODULES, tsconfig paths, jest mapper).
      AC: `api` build compiles with BuildcoverModule; module import resolves.
- [x] T8 — Unit tests (mocked GROQ): role mapping, Portable-Text rendering, location parse, compensation parse, global apply email, empty path, filters.
      AC: all tests green.
- [x] T9 — Live smoke on buildcover.com.
      AC: current open roles with title/location/type/description/apply/datePosted.
- [x] T10 — Docs: spec/plan/tasks; update `docs/index.md` + `docs/log.md`.
      AC: index lists 5045; log has newest-at-top entry.
