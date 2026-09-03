# Plan: 5087 — SuccessFactors bare-slug CSB fallback

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-30   |
| Last updated | 2026-08-30   |

## Phases

1. **Constants (`packages/plugins/source-ats-successfactors`).** Add `SF_CSB_DEFAULT_ORIGIN_TEMPLATE` and `buildSfCsbDefaultOrigin(companyId)` to `successfactors.constants.ts`. The template expands to `https://{companyId}.jobs.hr.cloud.sap/`; it is a list so additional verified SAP CSB host patterns can be added later without a breaking change.
2. **Service logic (`successfactors.service.ts`).** In `scrape()`:
   - Detect a bare slug (`companySlug` with no colon) and treat it as `companyId` only, clearing `instance`.
   - For bare slugs, skip OData and native HTML.
   - If `companyUrl` is absent, derive the default CSB origin and probe it with a root fetch + `htmlLooksLikeCsb`.
   - If the probe succeeds, call `scrapeCsb()` with the derived base.
   - If it fails, return a `bad_input` diagnostic: `missing companyUrl: could not derive SuccessFactors CSB portal for <companyId>`.
3. **Tests (`__tests__/successfactors-csb.service.spec.ts`).** Add a `TestSuccessFactorsService` variant that also stubs the default-origin probe (`fetchCsbProbeHtml`), and tests:
   - bare slug + matching CSB root → jobs returned
   - bare slug + non-CSB root → 0 jobs + diagnostic
   - existing colon slug behavior unchanged
4. **Docs and Spec Kit.** Update `docs/index.md` and `docs/log.md` with the new spec row/entry.
5. **Verification.** Run the plugin Jest suite and `tsc --noEmit` for the package.

## Packages touched

- `packages/plugins/source-ats-successfactors`

## Risks

- The `*.jobs.hr.cloud.sap` pattern is a heuristic derived from observed SAP CSB tenants; it will not fix tenants on custom CSB domains.
- One extra root-HTML fetch per bare-slug scrape when `companyUrl` is absent.
- If a tenant's root page lacks CSB fingerprints, `htmlLooksLikeCsb` may reject a real portal; in that case the diagnostic tells the caller to supply `companyUrl`.
