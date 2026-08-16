# Tasks: 5081 — Headful browser for company plugins blocked on Cloudflare/Wix

- [ ] Pass `headful: true` to `BrowserPool.getPage` in `DesktopmetalService.fetchListingHtml` and update JSDoc.
- [ ] Pass `headful: true` to `BrowserPool.getPage` in `TrueMetalSupplyService.fetchOpenings` and update JSDoc.
- [ ] Fix `TrueMetalSupplyService.collectDialogs` to skip hidden triggers and read each Wix popup by `data-popupid`/`id`.
- [ ] Update the `source-company-truemetalsupply` `fakePage` helper for the new `collectDialogs` flow.
- [ ] Add unit test in `source-company-desktopmetal` asserting `BrowserPool.getPage` is called with `headful: true`.
- [ ] Add unit test in `source-company-truemetalsupply` asserting `BrowserPool.getPage` is called with `headful: true`.
- [ ] Update `docs/index.md` and `docs/log.md` for Spec 5081.
- [ ] Run focused jest suites for both plugins.
- [ ] Run `npx tsc --noEmit --project tsconfig.base.json`.
- [ ] Run `npm run lint:docs`.
