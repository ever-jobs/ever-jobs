# Spec: 5087 — SuccessFactors bare-slug CSB fallback

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 5087                                                    |
| Slug           | source-successfactors-bare-slug-csb-fallback            |
| Status         | in progress                                             |
| Owner          | agent                                                   |
| Created        | 2026-08-30                                              |
| Last updated   | 2026-08-30                                              |
| Supersedes     | (none)                                                  |
| Related specs  | 5085                                                    |

## 1. Problem Statement

`SuccessFactorsService.scrape()` interprets a bare `companySlug` (no colon) as both the OData/instance name and the `companyId`. For an SAP CSB portal whose canonical hostname is `https://<companyId>.jobs.hr.cloud.sap/`, the slug is only the `companyId` — not a resolvable SuccessFactors instance. With no `companyUrl` supplied, the plugin therefore tries:

- OData: `https://<companyId>.successfactors.com/odata/v2/JobRequisitionPosting`
- Native HTML: `https://<companyId>.successfactors.com/career?company=<companyId>`

Both fail at DNS because the tenant does not run at that hostname, even though a working CSB portal exists on the SAP `*.jobs.hr.cloud.sap` domain. The CSB branch is never reached because `resolveCsbBaseUrl(input.companyUrl)` is `null` when `companyUrl` is absent.

## 2. Goals

- Allow `SuccessFactorsService.scrape()` to recover when `companySlug` is bare and `companyUrl` is missing.
- Derive a default SAP CSB origin from the bare `companyId`.
- Verify the candidate origin by checking whether its root page looks like a CSB portal.
- If the candidate does not match, return a clear `bad_input`/`empty` diagnostic instead of a DNS error.

## 3. Non-Goals

- No change to slugs that contain a colon (`instance:companyId`) — those continue through the OData and native HTML paths.
- No change to callers; the fix is purely inside the plugin.
- No support for arbitrary made-up SAP hostnames; only the observed SAP CSB host pattern `https://<companyId>.jobs.hr.cloud.sap/` is used.
- No support for custom-domain CSB portals (e.g. `careers.example.com`); those still require an explicit `companyUrl`.

## 4. Design

### 4.1 Detect a bare slug

`parseSfSlug` already splits on `:`. If the input has no colon, `{ instance, companyId }` are the same token. Treat that token as `companyId` only and set `instance` to empty string for the purposes of `scrape()`.

### 4.2 Default CSB origin

Add a constant set of default CSB host templates in `successfactors.constants.ts`, currently:

- `https://{companyId}.jobs.hr.cloud.sap/`

`buildSfCsbDefaultOrigin(companyId)` expands the first matching template.

### 4.3 Verification before use

`scrape()` probes the candidate origin by fetching its root HTML and running `htmlLooksLikeCsb(html)`. If it matches, that origin is used as the CSB base and `scrapeCsb()` is invoked. If it does not match, the plugin returns an empty result with a diagnostic explaining that no `companyUrl` was provided and no default CSB portal could be verified.

### 4.4 Ordering

For a bare slug the plugin will:

1. Skip OData (no instance).
2. If `companyUrl` is present, use it as before.
3. If `companyUrl` is absent, derive the default origin, verify it, and call `scrapeCsb()`.
4. If the default origin fails verification, return a diagnostic without attempting the native HTML path.

### 4.5 Tests

- Bare slug with a verified default CSB origin returns jobs from the mocked tile/detail pages.
- Bare slug whose default origin does not look like CSB returns zero jobs with a `bad_input` diagnostic.
- Existing colon slug behavior is unchanged.

## 5. Acceptance

- `SuccessFactorsService.scrape({ companySlug: 'acme' })` returns jobs when `https://acme.jobs.hr.cloud.sap/` serves a CSB-like page and the tile/detail endpoints respond.
- `SuccessFactorsService.scrape({ companySlug: 'acme' })` returns zero jobs and a clear diagnostic when `acme.jobs.hr.cloud.sap` does not look like a CSB portal.
- `SuccessFactorsService.scrape({ companySlug: 'instance:companyId' })` continues to try OData/native HTML and CSB as before.
- Existing SuccessFactors unit tests still pass.
- `tsc --noEmit` and the plugin Jest suite are green.

## 6. Risks

- The `*.jobs.hr.cloud.sap` pattern is a heuristic. It covers SAP-hosted CSB tenants but not tenants with custom CSB domains.
- One extra HTTP round-trip per bare-slug scrape when `companyUrl` is absent.
- A tenant whose root page does not contain CSB fingerprints would be rejected even if its tile endpoint is functional; if that proves common, the verification step can be relaxed.
