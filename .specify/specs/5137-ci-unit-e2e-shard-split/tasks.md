# Tasks: 5137 — CI unit/e2e shard split

- [x] Edit `.github/workflows/ci.yml` — replace `test-sources`, add `test-source-e2e`
- [x] Validate YAML parse
- [x] Verify partition counts via `jest --listTests` (1,600 / 253)
- [x] Update `docs/index.md` + `docs/log.md`
- [x] Commit, push, PR to `develop`
- [ ] Record each shard's duration from first CI run; resize shard counts
