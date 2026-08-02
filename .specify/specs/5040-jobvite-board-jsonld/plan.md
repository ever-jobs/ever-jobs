# Plan: 5040 — jobvite-board-jsonld

| Field | Value |
| --- | --- |
| Spec ID | 5040 |
| Slug | jobvite-board-jsonld |
| Status | implementing |

## Phases

### Phase 1 — Constants and types

- Rewrite `jobvite.constants.ts`: board host + `jobviteBoardUrl(slug)` /
  `jobviteJobDetailUrl(slug, jobId)` builders, headers, timeout / results /
  concurrency caps, `JOBVITE_JOB_ID_REGEX`, `JOBVITE_TITLE_COMPANY_REGEX`,
  `JOBVITE_REMOTE_REGEX`.
- Remove the dead private-feed endpoint + auth constants.
- Rewrite `jobvite.types.ts`: `JobviteListItem` (list row) and
  `JobviteDetailData` (fields pulled from the detail JSON-LD).

### Phase 2 — Service rewrite (scrape flow)

- `scrape()`: resolve slug → `fetchText(/{slug}/jobs)` → `parseBoard()` →
  slice to `resultsWanted` → `fetchDetails()` (bounded fan-out) → map to
  `JobPostDto[]`.
- `parseBoard(html, slug)`: Cheerio — iterate `table.jv-job-list`, department =
  nearest preceding `<h3>`, rows from `tbody tr`; de-dupe by jobId; also pull the
  company name from `<title>`.
- `fetchDetails(client, slug, items)`: `Promise.allSettled` batches, one detail
  fetch per role, `parseJobPostingLd(html)[0]` → `JobviteDetailData`.
- `toJobPost(item, slug, company, detail, format)`: merge list + detail →
  `JobPostDto`.
- Remove the old private-feed + authenticated + headless-browser paths.

### Phase 3 — Field enrichment

- `buildLocation()`: detail JSON-LD structured location first, list cell text
  fallback, bare `Remote` marker last.
- `isRemote`: JSON-LD `TELECOMMUTE` OR text heuristic on list location / title.
- compensation via shared `jobPostingLdToCompensation(posting.baseSalary)`.
- company name: detail `hiringOrganization`, board `<title>` fallback,
  de-slugified slug last.

### Phase 4 — Tests

- Rewrite the E2E spec to the new architecture (live board shape; moved-off
  tenant → `[]`).
- Add mocked-HTTP unit tests covering every path (grouped board, department
  grouping, remote, compensation, de-dupe, resultsWanted, redirect, slug
  resolution, description formatting, emails, company name).

### Phase 5 — Docs

- Update `docs/index.md`, `docs/log.md`, `docs/questions.md`.

## Risks

- **Board HTML structure change**: parsing relies on `table.jv-job-list` +
  `<h3>` grouping and `td.jv-job-list-name` / `td.jv-job-list-location` cells.
  Mitigated: selectors are lenient; an unrecognised board yields `[]`.
- **Detail JSON-LD absent**: some roles may lack a `JobPosting` block. Mitigated:
  the role is still emitted from list fields with detail-only fields null.
- **Tenant migration**: a tenant can move off Jobvite (board redirects away).
  Mitigated: `maxRedirects: 0` + degrade to `[]`.
- **Large boards**: all roles render on one page. Mitigated: slice to
  `resultsWanted` before the detail fan-out; concurrency-capped batches.
