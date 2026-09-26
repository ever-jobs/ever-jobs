# Plan: 1694 — Source plugin: Simplify new-grad and internship lists

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1694       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

A self-contained plugin package with small pure modules around one service, so every rule is
unit-tested without the network and the service stays an orchestrator.

1. **`simplifyjobs.feed-parser.ts`** — `FeedArrayScanner`, an incremental byte-level splitter of
   a JSON array into its top-level object texts, and `compactRow` / `parseFeedBody`, which parse
   one element at a time, keep only live rows, project them to `SimplifyRow`, intern repeated
   strings and sort the result newest first. Malformed bodies throw `SimplifyFeedFormatError`.
2. **`simplifyjobs.feed-cache.ts`** — `FeedCache<T>`: per-key ETag + clamped `max-age` TTL,
   single-flight, stale-on-error, error backoff, bounded key count; clock injected.
3. **`simplifyjobs.robots.ts`** — minimal RFC 9309 parser and matcher.
4. **`simplifyjobs.mapper.ts`** — location pre-normaliser, category, sponsorship, ATS detection,
   posted time (via the Spec 1696 helpers) and `SimplifyRow` → `JobPostDto`.
5. **`simplifyjobs.query.ts`** — job-type routing, tokeniser, word-start search, location facts
   (memoised per label) and matching, freshness, merge of pre-sorted lists, URL dedup, paging,
   and `selectPage`, which does merge + filter + dedup lazily and stops once the page is full.
6. **`simplifyjobs.service.ts`** — per scrape: route; for each needed list in turn, read through
   the cache (robots check, conditional GET as bytes, parse); then filter, merge, dedup, page, map;
   diagnostics per spec §7.2.

The Site value is carried as `SIMPLIFYJOBS_SITE` (`'simplifyjobs' as Site`) until the integrator
adds `Site.SIMPLIFYJOBS`; tests import the package by relative path for the same reason.

## 2. Phases

### Phase 1 — Parsing and cache

- Goal: bounded-heap parsing of a real 13 MB list; conditional-GET cache.
- Deliverables: feed-parser, feed-cache, their suites, the heap-bound test.
- Exit criteria: 8k live rows of a ~15 MB body retained in < 6 MB; nothing larger than one row
  decoded or parsed.

### Phase 2 — Mapping and filters

- Goal: correct DTOs and caller-intuitive filters.
- Deliverables: mapper, query, robots, their suites; synthetic fixtures.
- Exit criteria: the location regression pairs (Cambridge UK/MA, Birmingham AL/UK), aliases,
  multi-part labels and the midnight freshness rule pinned by tests.

### Phase 3 — Service

- Goal: routing, sequential fetches, diagnostics, configuration.
- Deliverables: service, module, barrel, service suite, gated live E2E.
- Exit criteria: service suite green; one live run returns jobs from both lists with no
  diagnostics; plugin type-checks.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-simplifyjobs` | new package |
| `packages/models` | (integrator) `Site.SIMPLIFYJOBS = 'simplifyjobs'` |
| `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` | (integrator) registration |
| `packages/common` | (no change) — uses `createHttpClient`, `parseLocationList`, `parseLocationText`, `canonicalCountryName`, `normalizeCountryOnly`, `normalizeUsState`, `resolveCompanyUrl`, `postedFromTimestamp`, `postedTimeFields`, `toDateOnly` |

## 4. Dependencies

| Library | Version | Rationale |
| ------- | ------- | --------- |
| (none new) | — | Node `crypto` for the id fallback; axios through the shared HTTP client |

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| The internship repository is renamed each season | H (yearly) | M | `SIMPLIFYJOBS_INTERNSHIPS_REPO`; the old name redirects for a while (redirects pinned to the host); a warning when a list stops moving for 14 days |
| The list format changes | L | M | Row-by-row validation drops bad rows; a non-array or malformed body is `fetch_error` and the last good copy is served for up to 6 h |
| Memory pressure on API pods | M | H | D-01/D-03: off-heap body, one row parsed at a time, interning; sequential lists; heap-bound test |
| The host adds a robots.txt policy | L | M | Checked at runtime (D-05) |
| Load on the host | L | L | One conditional GET per list per window per pod, 304s, 2 s spacing, 60 s error backoff |

## 6. Rollback Plan

Remove `SimplifyJobsModule` from `ALL_SOURCE_MODULES` (or the `Site` key from callers). The plugin
keeps no state beyond its in-process cache; nothing is persisted.

## 7. Migration Plan (if applicable)

None: a new source. Each season, bump `SIMPLIFYJOBS_DEFAULTS.internshipsRepo` (or set the env var).

## 8. Open Questions for Plan

See spec §9 (Q-1 shared parser collapses country-only entries; Q-2 visa sponsorship field).
