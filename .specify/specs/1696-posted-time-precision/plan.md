# Plan: 1696 — Posted-time precision

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1696       |
| Status       | in-progress |
| Last updated | 2026-09-25 |

## 1. Approach

Model first, then one pure helper module, then adoption. The enums and the three optional DTO
fields go into `@ever-jobs/models`; `@ever-jobs/common` gains `converters/posted-time.ts`, which
already sits beside `toDateOnly` and imports the models package the same way `helpers.ts` does.

The helper is split by source shape rather than by plugin: an absolute value
(`postedFromTimestamp`), an age label with an optional date attribute (`postedFromRelativeLabel`)
and a day bucket (`postedFromAgeInDays`). Each returns the same `PostedTime` record, and
`postedTimeFields` spreads it onto a `JobPostDto` so a date-only job serialises exactly as before
plus, at most, precision and basis. Time is always a parameter, so every rule is testable against
the probe's own fetch instant.

`postedSortKey` is the ordering primitive for the aggregate sort; it is always finite, which also
fixes the `NaN`-comparator instability. The freshness-filter contract lives in its JSDoc and in the
spec, not in code, because no such filter exists.

## 2. Phases

### Phase 1 — Core (this change)

- Deliverables: `date-posted.enum.ts` + export; three optional `JobPostDto` fields;
  `posted-time.ts` + barrel export; `posted-time.spec.ts`.
- Exit criteria: suite green; `tsc --project tsconfig.typecheck.json` clean for these files.

### Phase 2 — Plugins

- `source-linkedin`: `fetchedAt` after the search response; `postedFromRelativeLabel(timeText,
  fetchedAt, datetimeAttr)`; detail-page `JobPosting` upgrade gated on `postedAtAgreesWithDate`;
  one debug counter line per scrape.
- `source-indeed`: `postedFromTimestamp(datePublished ?? dateOnSite ?? null)`.
- `source-glassdoor`: `fetchedAt` after the graph response; `postedFromAgeInDays(ageInDays,
  fetchedAt)`.
- Exit criteria: plugin specs with synthetic fixtures; `datePosted` byte-identical for every card
  that has a date attribute.

### Phase 3 — Surfaces

- `jobs.service.ts` sort via `postedSortKey`; GraphQL fields; tool manifest; MCP `date_posted_at`;
  CLI CSV columns appended at the end; `docs/API_CHANGELOG.md` "Added" entry.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/models` | `DatePostedPrecision`, `DatePostedBasis`; three optional `JobPostDto` fields |
| `packages/common` | `converters/posted-time.ts`, barrel export, spec |
| `packages/plugins/source-linkedin`, `-indeed`, `-glassdoor` | Phase 2 |
| `apps/api`, `apps/mcp`, `apps/cli` | Phase 3 |

## 4. Dependencies

None. Pure TypeScript over the built-in `Date`.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| A board changes its label format or localises it | M | L | Labels only upgrade precision; an unrecognised label falls back to the date attribute. The LinkedIn debug counter makes a silent downgrade visible. |
| A consumer with a strict schema rejects the new keys | L | M | Keys are optional and omitted when null; `EVER_JOBS_POSTED_TIME_DETAIL=false` removes them without a deploy of code. |
| False precision from a label | L | M | Minute flooring, hour precision for hour labels, and the ±1-day consistency guard against the attribute. |
| Host time zone leaks into an instant | L | M | Offset-less datetimes never yield an instant; offsets are parsed from their parts. |

## 6. Rollback Plan

Set `EVER_JOBS_POSTED_TIME_DETAIL=false` to drop the three keys at once. A full revert is safe: the
fields are optional, nothing reads them yet, and `datePosted` returns to its previous values.

## 7. Migration Plan

None. Old clients ignore the new keys. Follow-ups (separate specs): adopt `postedFromTimestamp` in
the plugins that already parse `JobPosting` blocks or offset-bearing ATS timestamps, and move the
bespoke "N days ago" parsers onto `postedFromRelativeLabel`.

## 8. Open Questions for Plan

None.
