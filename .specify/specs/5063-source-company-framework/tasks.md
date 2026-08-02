# Tasks: 5063 — source-company-framework

- [x] Scaffold `packages/plugins/source-company-framework` (package.json, tsconfig, src barrel/module)
- [x] `framework.constants.ts` — origin, careers URL, `/apply` URL, `/jobs/` role path, JD section names, Location/Salary Framer-name keys, defaults
- [x] `framework.types.ts` — `FrameworkOpening`, `FrameworkDetail`
- [x] `framework.service.ts` — two-step listing (slug enumeration) + detail parse (title/location/salary/JD sections → markdown), mapping (jobUrl on-domain `/jobs/{slug}` / applyUrl shared `/apply`), input filters
- [x] On-domain only: nothing off-domain is fetched; generic `contact@framework.co` is not harvested (`emails=[]`)
- [x] Location: `Los Angeles, CA` via `parseLocationList`; `isRemote=false`; compensation via shared `salaryToCompensation` (yearly `$150k-$200k`)
- [x] Enumerate every role `/hiring` links (two live at implementation time)
- [x] Register `Site.FRAMEWORK = 'framework'`
- [x] Append `FrameworkModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over the captured `/hiring` + two `/jobs/{slug}` fixtures (incl. off-domain-never-fetched guard)
- [x] `docs/index.md`, `docs/log.md`
- [x] Typecheck the package
