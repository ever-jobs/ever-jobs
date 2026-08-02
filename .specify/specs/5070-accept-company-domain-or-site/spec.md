# Spec: 5070 — Search accepts a company domain or a `Site` token

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5070                               |
| Slug           | accept-company-domain-or-site      |
| Status         | in-progress                        |
| Owner          | agent                              |
| Created        | 2026-07-27                         |
| Last updated   | 2026-07-27                         |
| Supersedes     | (none)                             |
| Related specs  | 5069                               |

## 1. Problem Statement

Callers of `POST /api/jobs/search` must already know the exact registered `Site` token for a company plugin. The token is derived from the company's domain by a simple rule, but today that rule is duplicated in every caller. When the rule and the ever-jobs `Site` enum drift, the call silently 400s or returns zero jobs. The rule and its exceptions should live in ever-jobs so a caller can pass the raw domain and let the server resolve it.

## 2. Goals

- Add an optional `companyDomain?: string[]` field to `ScraperInputDto` that is parallel to `siteType`.
- Provide a single source of truth inside ever-jobs for mapping a company domain to a registered `Site` token.
- Resolve `companyDomain` values into `Site` tokens and union them with any explicit `siteType` values.
- Return a hard 400 for any unresolved domain, with a clear message naming the domain and the derived token that was tried.
- Keep the existing `siteType` enum contract intact.

## 3. Non-Goals

- No change to `companyUrl` (the custom-domain career-portal URL used by ATS plugins).
- No support for multi-label TLDs such as `co.uk` in this spec.
- No renaming of upstream `divergent` or `nuro` plugins; they stay as hardcoded exceptions.
- No removal of the existing `siteType` field or `Site` enum.
- No CLI flag for `--company-domain` in this spec; JSON stdin is the supported CLI path.

## 4. User / Caller Stories

- As an API caller, I want to pass `companyDomain: ["boomsupersonic.com"]` instead of `siteType: ["boomsupersonic"]`, so I do not have to duplicate the token-derivation rule.
- As a fetch-app sidecar, I want to send the employer's domain and have ever-jobs resolve the right company plugin, so token drift cannot hide jobs.

## 5. Functional Requirements

| ID   | Requirement                                                                 | Priority |
| ---- | --------------------------------------------------------------------------- | -------- |
| FR-1 | `ScraperInputDto` gains `companyDomain?: string[]`.                         | must     |
| FR-2 | `siteFromDomain(domain)` implements the Spec 5069 rule: lower/trim, strip trailing `.com`, replace remaining `.` with `_`, with exceptions `divergent.us` → `divergent` and `nuro.ai` → `nuro`. | must |
| FR-3 | If `companyDomain` is provided and a domain cannot be resolved, `searchJobs` throws `BadRequestException` naming the domain and the derived token. | must |
| FR-4 | Blank/empty `companyDomain` entries are ignored, not errors.                | must     |
| FR-5 | Resolved domains are unioned with any explicit `siteType` values; if only `companyDomain` is provided, the resolved set becomes the effective `siteType`. | must |
| FR-6 | `siteFromDomain` tolerates a full URL (`https://`) and a leading `www.` prefix. | should |

## 6. Non-Functional Requirements

| ID    | Requirement                                       | Target |
| ----- | ------------------------------------------------- | ------ |
| NFR-1 | Domain resolution is pure string math; no I/O.  | -      |
| NFR-2 | No measurable latency added to search dispatch.   | < 1 ms |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/common/src/utils/site-from-domain.ts
export function siteFromDomain(domainOrUrl: string): Site | undefined;

// packages/models/src/dtos/scraper-input.dto.ts
export class ScraperInputDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  companyDomain?: string[];
}
```

### 7.2 Errors

| Status | Message                                                                 |
| ------ | ------------------------------------------------------------------------- |
| 400    | `domain 'foo.io' → token 'foo_io' is not a registered plugin` (one or more) |

## 8. Test Plan

- Unit `siteFromDomain`: `.com` strip, non-`.com` underscore, exceptions, URL and `www.` tolerance, unknown domain returns `undefined`.
- Unit `JobsService`: `companyDomain` resolves to a company plugin; union with explicit `siteType`; hard 400 on unresolved; default routing unchanged when neither is provided.
- Integration `JobsController`: returns a 400 with a clear message when `companyDomain` cannot be resolved.
- Build: `tsc --noEmit` for `packages/common`, `packages/models`, and `apps/api`.

## 9. Open Questions

(none)

## 10. Decisions

- **Option A (separate `companyDomain` field)**, not overloading `siteType`, keeps the enum validation strict and makes intent explicit.
- **Hard 400 on unresolved domain** surfaces token drift instead of silently returning no jobs.
- **Remove the default `siteType = Object.values(Site)` assignment** in `ScraperInputDto`'s constructor. The constructor default made `companyDomain`-only requests behave as a union with all sites. Leaving `siteType` undefined by default lets the existing routing logic fall back to search+company scrapers, and lets `companyDomain` alone drive the resolved set.
- **Keep the `divergent.us` / `nuro.ai` exceptions** in `siteFromDomain` so upstream plugins continue to resolve.

## 11. References

- Spec 5069 — company-plugin domain-derived `Site` token rename
- `docs_fetch1/ever-jobs-accept-domain-or-site-SPEC.md` (private caller context kept out of the fork)
