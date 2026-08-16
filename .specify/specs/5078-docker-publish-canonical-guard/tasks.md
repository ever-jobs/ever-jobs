# Tasks: 5078 — Restrict Docker publish workflow to the canonical repository

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Guard both jobs

- [x] T01 — Add repository guard to `build` and `build-mcp`
  - **Files:** `.github/workflows/docker-build-publish.yml`
  - **Acceptance:**
    - both jobs carry `if: ${{ github.repository == 'ever-jobs/ever-jobs' }}`
    - a short comment explains why (forks can't push to `ghcr.io/ever-jobs/*`)
    - no other keys changed (tags, cache, runners, triggers, permissions)
  - **Estimate:** 0.5 day

## Notes

- No unit test harness applies to a workflow guard; verification is observational (fork run skips; canonical run still publishes).
- Update `docs/log.md` and `docs/index.md` in the same commit.
