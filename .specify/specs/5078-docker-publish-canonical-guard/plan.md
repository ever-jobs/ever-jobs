# Plan: 5078 — Restrict Docker publish workflow to the canonical repository

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-08-05                         |
| Last updated | 2026-08-05                         |

## 1. Approach

Add a job-level `if:` guard to both jobs in `docker-build-publish.yml` so they run only in the canonical repository. Using a job-level condition (rather than a step-level one) means forks spend zero runner time — the whole job is skipped before checkout, instead of building the image and only then failing the push.

`github.repository` resolves to the full `owner/repo` of the repository the run belongs to, so `github.repository == 'ever-jobs/ever-jobs'` is true only in the canonical repo and false in every fork. No secrets, vars, or inputs are involved, so the guard cannot be misconfigured per-environment.

The change is intentionally minimal: tags, cache, runners, triggers, and permissions are untouched, so canonical-repo publishing is byte-for-byte unchanged.

## 2. Phases

### Phase 1 — Guard both jobs

- Goal: skip publish jobs outside the canonical repo.
- Deliverables: `if:` on `build` and `build-mcp`, with an explanatory comment.
- Exit criteria: canonical behavior unchanged; forks skip the jobs.

## 3. Packages Touched

| Package                                   | Change                                  |
| ----------------------------------------- | --------------------------------------- |
| `.github/workflows/docker-build-publish.yml` | add `if:` guard to both jobs         |

## 4. Dependencies

(none)
