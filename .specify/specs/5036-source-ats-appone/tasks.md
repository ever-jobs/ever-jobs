# Tasks: 5036 — source-ats-appone

- [x] T1 — Scaffold `packages/plugins/source-ats-appone` (package.json, tsconfig,
      index, module) and register in the four places (enum, plugins/index,
      tsconfig.base, jest.config).
      AC: `Site.APPONE === 'appone'`; plugin resolves via NestJS DI.
- [x] T2 — Add list/detail endpoints, headers, cap + concurrency constants to
      `appone.constants.ts`; model the list + detail shapes in `appone.types.ts`.
      AC: endpoints build from tenant / jobPostId; types cover mapped fields.
- [x] T3 — Implement `ApponeService.scrape`: resolve tenant, fetch list, cap to
      `resultsWanted`, overlay each detail under bounded concurrency, map to
      `JobPostDto`.
      AC: failed detail → list-only fields; failed list → empty (never throws).
- [x] T4 — Map title / companyName / location (city+state) / jobUrl / datePosted /
      isRemote (+ Hybrid) / employmentType / jobType / description / compensation.
      AC: compensation parsed from the body via `resolveCompensation`.
- [x] T5 — Unit tests (mocked HTTP) per the spec test plan.
      AC: `npx jest source-ats-appone` green.
