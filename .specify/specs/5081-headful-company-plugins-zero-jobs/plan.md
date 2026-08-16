# Plan: 5081 — Headful browser for company plugins blocked on Cloudflare/Wix

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-08-05                         |
| Last updated | 2026-08-05                         |

## 1. Approach

Apply the Spec 5076 `BrowserPool` `headful` opt-in to the two company-page plugins that are currently blocked by Cloudflare or Wix anti-bot protection. Each change is a single option added to `BrowserPool.getPage`, plus matching JSDoc and a small unit test. The two plugins do not import one another and no shared abstraction is needed.

## 2. Phases

### Phase 1 — Desktop Metal

- Goal: `DesktopmetalService.fetchListingHtml` requests `BrowserPool.getPage({ proxy, stealth: true, headful: true })`.
- Deliverables: updated `desktopmetal.service.ts`, JSDoc fix, and a new unit test asserting the call options.
- Exit criteria: `npx jest --testPathPatterns=source-company-desktopmetal` passes.

### Phase 2 — True Metal Supply

- Goal: `TrueMetalSupplyService.fetchOpenings` requests `BrowserPool.getPage({ proxy, stealth: true, headful: true })` and `collectDialogs` reads each Wix popup by `data-popupid`/`id`.
- Deliverables: updated `truemetalsupply.service.ts` (headful opt-in + popup selector + skip hidden triggers), JSDoc updates, and a new unit test asserting the `BrowserPool.getPage` call options.
- Exit criteria: `npx jest --testPathPatterns=source-company-truemetalsupply` passes.

### Phase 3 — Typecheck and docs

- Goal: ensure both plugins typecheck and the spec is indexed/logged.
- Deliverables: `docs/index.md` entry, `docs/log.md` entry, `npm run lint:docs`.
- Exit criteria: `npx tsc --noEmit --project tsconfig.base.json` and `npm run lint:docs` are clean.
