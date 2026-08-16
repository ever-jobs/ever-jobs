# Plan: 5082 — Per-source zero-jobs reason diagnostics

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-08-05                         |
| Last updated | 2026-08-05                         |

## Phases

1. **Contract (models).** Add `scrape-diagnostics.dto.ts` (`ScrapeReason`, `ScrapeDiagnostics`, `SourceDiagnosticDto`, `classifyScrapeError`, `looksLikeChallenge`); export it. Add optional `diagnostics` to `JobResponseDto`. Pure, no runtime deps → safe leaf change.
2. **Plugins.** Update the three browser-based plugins to (a) log the real message via `classifyScrapeError`, (b) return diagnostics on catch, (c) mark `blocked` vs `empty` on zero-postings, (d) `bad_input` on no slug.
3. **Service.** Extract `searchJobsWithDiagnostics`; keep `searchJobs` as a thin wrapper. Build `perSource` from the existing settled-results array.
4. **Controller.** Thread `per_source` into the two JSON responses; `[]` on cache hit.
5. **Tests + docs.** Unit tests for classifier/detector/plugins/service; update `docs/index.md`, `docs/log.md`.

## Packages touched

- `packages/models` (contract + helpers + tests)
- `packages/plugins/source-company-desktopmetal`, `source-company-truemetalsupply`, `source-ats-gusto-hosted`
- `apps/api/src/jobs` (service + controller + tests)

## Risks

- Changing `searchJobs`'s return type would break 6 callers → avoided by adding a sibling method.
- Over-eager `blocked` classification → keep challenge patterns specific; default to `empty`/`unknown`.
- Response-shape churn → additive only; no existing field renamed or removed.
