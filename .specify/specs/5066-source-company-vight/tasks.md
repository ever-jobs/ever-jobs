# Tasks: 5066 — source-company-vight

- [x] Scaffold `packages/plugins/source-company-vight` (package.json, tsconfig, src barrel/module)
- [x] `vight.constants.ts` — origin, careers URL, Cloudflare email-protection path, defaults
- [x] `vight.types.ts` — `VightOpening`, `VightDetail`
- [x] `vight.service.ts` — two-step listing (card enumeration) + detail parse (`<h1>` title / `.meta` chips / `<section>` → markdown / decoded email), `classifyMeta`, `decodeCfEmail`, mapping, input filters
- [x] On-domain only: nothing off-domain is fetched; apply email carried on `emails`, `applyUrl` unset
- [x] Location: `SF Bay Area, CA` → city `SF Bay Area` / state `CA` via `parseLocationList`; `isRemote=false`; `Full time` → `FULL_TIME` via `getJobTypeFromString`
- [x] Keep the generalist from the card alone (null location/type, card-copy description, `/join-us/` jobUrl)
- [x] Register `Site.VIGHT = 'vight'`
- [x] Append `VightModule` to `ALL_SOURCE_MODULES`
- [x] Add tsconfig path alias + jest `moduleNameMapper`
- [x] Unit tests over the captured `/join-us/` + three `/join-us/{slug}/` fixtures (incl. off-domain-never-fetched guard)
- [x] `docs/index.md`, `docs/log.md`
- [x] Typecheck the package
