# Tasks: 5071 — Patch high-severity `js-yaml` and `fast-uri`

- [x] T01 — Add `fast-uri` override to `^3.1.4`.
- [x] T02 — Add `js-yaml@^4.3.0` overrides for 4.x consumers.
- [x] T03 — Add `js-yaml@^3.15.0` overrides for 3.x consumers.
- [x] T04 — Regenerate `package-lock.json` with `npm install`.
- [x] T05 — Verify patched versions in `npm ls js-yaml fast-uri`.
- [x] T06 — Run targeted `jest` suites.
- [x] T07 — Run `tsc --noEmit` on affected packages/apps.
- [x] T08 — Run `npm audit --audit-level=high` and confirm only `brace-expansion` remains.
- [ ] T09 — Update `docs/index.md` and `docs/log.md`.
- [ ] T10 — Commit, push, and open PR against `develop`.
