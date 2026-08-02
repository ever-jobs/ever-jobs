# Tasks: 5040 — jobvite-board-jsonld

| Field | Value |
| --- | --- |
| Spec ID | 5040 |
| Slug | jobvite-board-jsonld |
| Status | implemented |

## Task list

- [x] T1 — Probe live boards; confirm the private feed endpoint is dead (0 jobs),
  identify the server-rendered `/{slug}/jobs` list + `/{slug}/job/{jobId}`
  JSON-LD detail; verify ground-truth counts (4 boards: 37/16/9/19 = 81)
- [x] T2 — Rewrite `jobvite.constants.ts`: board/detail URL builders, headers,
  caps, job-id / title / remote regexes; remove the dead feed + auth constants
- [x] T3 — Rewrite `jobvite.types.ts`: `JobviteListItem`, `JobviteDetailData`
- [x] T4 — Rewrite `jobvite.service.ts`: server-rendered board parse (Cheerio,
  `<h3>` department grouping) + detail JSON-LD fan-out via the shared
  `parseJobPostingLd` extractor; department, compensation, structured location,
  remote, employmentType, company name
- [x] T5 — Rewrite the E2E spec + add mocked-HTTP unit tests
  (`jobvite.service.spec.ts`): grouped board, department grouping, remote,
  compensation, de-dupe, resultsWanted, redirect, slug resolution, description
  formatting, emails, company name (14 unit tests)
- [x] T6 — Update `docs/index.md`, `docs/log.md`, `docs/questions.md`
