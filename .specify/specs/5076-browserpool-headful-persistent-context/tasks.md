# Tasks: 5076 — BrowserPool headful / persistent-context opt-in

- [ ] Add `headful` and `userDataDir` to `BrowserPageOptions`.
- [ ] Update `BrowserPool.getPage` to use `chromium.launchPersistentContext()` when requested.
- [ ] Preserve default ephemeral/headless behavior when options are omitted.
- [ ] Add unit tests covering both launch paths.
- [ ] Update `docs/index.md` and `docs/log.md`.
- [ ] Run `npx jest packages/common` and `npx tsc --noEmit -p packages/common/tsconfig.json`.
