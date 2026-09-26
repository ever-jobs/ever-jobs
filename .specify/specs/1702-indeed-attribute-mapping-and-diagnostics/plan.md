# Plan: 1702 — Indeed: remote, job type and location from the right fields, and no silent empty results

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1702       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

The fix stays inside `source-indeed` and leaves the request alone. Every live POST from our egress
was edge-blocked, so the only things that can be fixed with confidence are the ones that read the
response: the mapping rules, the location, the posted time and the diagnostics.

1. **Constants.** The attribute codes (`DSQF7`, the four employment-type codes), the legacy key
   and prefix, three `EVER_JOBS_INDEED_*` switches and their readers. The document, headers and
   key are untouched.
2. **Utils.** `detectWorkplace` (anchored whole-label rules plus a head-of-location rule; remote
   wins over hybrid), `getJobType` (code map, then whole-label alias), `buildLocation` (structured
   first, formatted label verbatim in `text`, parsed only when there is no geography, with the
   workplace head and a US ZIP split off first). Each takes `IndeedMappingOptions`; `false` runs
   the pre-1702 rule verbatim. `isJobRemote` stays as a thin wrapper.
3. **Diagnostics.** A new `indeed.diagnostics.ts` turns a thrown client error, a GraphQL error
   envelope or a 200 without `data.jobSearch` into a `ScrapeDiagnostics`, enriching the generic
   client message with the GraphQL error and a block-page marker before `classifyScrapeError` sees
   it, and letting a known GraphQL code decide first.
4. **Service.** Reads the switches per scrape, captures `fetchedAt` after each response, uses the
   helpers above and the Spec 1696 `postedFromTimestamp` / `postedTimeFields`, counts mapping
   failures per page, keeps GraphQL errors that came with data for the zero-job case, caps pages,
   and sleeps only when another page will be fetched.

## 2. Phases

### Phase 1 — Mapping

- Goal: correct `isRemote`, `workFromHomeType`, `jobType`, `location`.
- Deliverables: constants, utils, `indeed.utils.spec.ts`.
- Exit criteria: the HEAD regressions (`DSQF7`, `CF3CP`, label-only `Temporary`) pass; skill and
  description false positives stay negative; the legacy options reproduce HEAD.

### Phase 2 — Diagnostics and posted time

- Goal: no silent empty result; exact posting instant.
- Deliverables: `indeed.diagnostics.ts`, service changes, `indeed.diagnostics.spec.ts`,
  `indeed.service.spec.ts`, fixtures.
- Exit criteria: every row of spec §7.3 is covered; the request is pinned byte-for-byte.

### Phase 3 — Live check and docs

- Goal: one live run; the spec folder.
- Deliverables: extended `indeed.e2e-spec.ts`; `spec.md`, `plan.md`, `tasks.md`.
- Exit criteria: the live run returns a diagnostic, not a silent empty; type-check clean for the
  plugin.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-indeed` | constants, utils, new diagnostics module, service, four fixtures, three new specs, extended e2e |
| `packages/common` | (no change — uses the Spec 1696 posted-time helpers and `parseLocationText`) |
| `packages/models` | (no change — uses `ScrapeDiagnostics`, `classifyScrapeError`, `looksLikeChallenge`, `getJobTypeFromString`) |
| `apps/*` | (no change) |

## 4. Dependencies

None added.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| A workplace label spelled differently from the anchored set | M | L | The attribute code and the location head are independent signals; unknown spellings fall back to on-site, as before |
| A benefit/skill label that is exactly a job-type alias | L | L | Whole-label, label-mode lookup only; `EVER_JOBS_INDEED_ATTRIBUTE_MAPPING=false` reverts |
| The page cap truncates a very large `resultsWanted` | M | L | Logged; `EVER_JOBS_INDEED_MAX_PAGES=0` restores the uncapped loop |
| The synthetic response shape differs from the live one | M | M | Every helper is total; a shape change shows up as the "every job failed to map" diagnostic instead of silence |

## 6. Rollback Plan

Set `EVER_JOBS_INDEED_ATTRIBUTE_MAPPING=false`, `EVER_JOBS_INDEED_FORMATTED_LOCATION=false`,
`EVER_JOBS_INDEED_MAX_PAGES=0` and (Spec 1696) `EVER_JOBS_POSTED_TIME_DETAIL=false` for the
pre-1702 output. The diagnostics are additive. Reverting the commit restores HEAD exactly.

## 7. Migration Plan

None. Output fields are additive (`workFromHomeType`, `location.text`, `location.postalCode`,
`datePostedAt`, `datePostedPrecision`, `datePostedBasis`); `isRemote`, `jobType` and
`location.country` change value where the old rules were wrong.

## 8. Open Questions for Plan

See spec §9 (Q-1702-1 … Q-1702-6). None blocks this change.
