# Tasks: 5072 — Migrate transitive `minimatch`/`brace-expansion`

- [x] T01 — Enumerate all `brace-expansion`/`minimatch` consumers with `npm ls`.
- [x] T02 — Determine safe target versions (audit DB shows `minimatch@10.2.5` and `glob@13`).
- [x] T03 — Update root `package.json` devDependencies and `overrides`.
- [x] T04 — Re-install and inspect the new lockfile.
- [x] T05 — Verify no build/test breakages from `glob@13` or `minimatch@10`.
- [x] T06 — Run targeted `npx jest`.
- [x] T07 — Run `npx tsc --noEmit` on affected packages.
- [x] T08 — Confirm `npm audit --audit-level=high` only shows `fork-ts-checker-webpack-plugin` chain.
- [x] T09 — Update `docs/index.md` and `docs/log.md`.
- [x] T10 — Commit and update PR #71 against `develop`.
