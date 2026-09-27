# Plan: 1750 — a SmartRecruiters job links to its posting page, not to the API

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1750        |
| Spec         | spec.md     |
| Status       | Implemented |
| Created      | 2026-09-25  |
| Last updated | 2026-09-25  |

## Approach

1. Confirm the wire shape before changing anything: three polite live GETs (AbbVie list,
   one detail, the id-only public page). Findings are in `spec.md` §1.
2. Map links in `processJob` (shared by the public and the authenticated path): identity
   first (posting id, company identifier — `ref` parsed only as a fallback), then
   `jobUrl = firstPublicUrl(postingUrl) ?? public pattern`, `applyUrl = firstPublicUrl(applyUrl)`.
3. Add a real unit suite with fixtures cut from the live responses (custom fields and the
   job-ad body trimmed; no personal data).
4. Make the 217 delegating plugins' fixtures and assertions honest with one mechanical
   rewrite (the only line that changes in each spec is the `jobUrl` assertion), and fix the
   scaffold so new plugins are generated the same way.

## Files

- `packages/plugins/source-ats-smartrecruiters/src/smartrecruiters.service.ts` — mapping.
- `packages/plugins/source-ats-smartrecruiters/src/smartrecruiters.constants.ts` —
  `SMARTRECRUITERS_PUBLIC_JOBS_URL`.
- `packages/plugins/source-ats-smartrecruiters/src/smartrecruiters.types.ts` — `postingUrl`,
  `applyUrl`, and what `ref` really is.
- `packages/plugins/source-ats-smartrecruiters/__tests__/smartrecruiters.service.spec.ts`
  + `fixtures/smartrecruiters-{list,detail}.json` — new.
- `packages/plugins/source-company-*/__tests__/*.service.spec.ts` (217) and
  `…/fixtures/*-jobs.json` (217) — assertion + `ref` rewrite.
- `scripts/scaffold-smartrecruiters-company-source.ts` — fixture `ref` + assertion template.

## Verification

- `npx jest packages/plugins/source-ats-smartrecruiters/__tests__/smartrecruiters.service.spec.ts`
- `npx jest --testPathPatterns "packages/plugins/source-company-" -t "SmartRecruiters"`
  (the 217 delegating suites)
- `npx jest scripts/__tests__/plugin-job-url-hosts.spec.ts scripts/__tests__/scaffold-delegating-company-source.spec.ts`
- Red control: with `job.ref ??` put back in front of the mapping, the plugin suite, the
  AbbVie delegating suite and the guard fail (10 of 31 tests); restored, 31/31 pass.
- `npx tsc --project tsconfig.typecheck.json --noEmit` and
  `npx tsc --project apps/api/tsconfig.build.json --noEmit`.
