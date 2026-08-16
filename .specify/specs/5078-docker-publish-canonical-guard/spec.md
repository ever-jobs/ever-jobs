# Spec: 5078 — Restrict Docker publish workflow to the canonical repository

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5078                               |
| Slug           | docker-publish-canonical-guard     |
| Status         | done                               |
| Owner          | agent                              |
| Created        | 2026-08-05                         |
| Last updated   | 2026-08-05                         |
| Supersedes     | (none)                             |
| Related specs  | (none)                             |

## 1. Problem Statement

`.github/workflows/docker-build-publish.yml` runs on every push to `main`/`stage`/`develop` and pushes images to `ghcr.io/ever-jobs/*` using the built-in `GITHUB_TOKEN`. In the canonical repo this works. In **any fork**, the fork's `GITHUB_TOKEN` cannot write to the `ever-jobs` org's packages, so both jobs build the image (minutes of runner time) and then fail the push with:

```
denied: permission_denied: The requested installation does not exist.
```

Every fork therefore gets a guaranteed-red workflow on each push to those branches — wasted runner minutes and misleading CI status — with no possibility of success as written (the target namespace is hardcoded).

## 2. Goals

- Skip the build/publish jobs when the workflow runs outside the canonical repository.
- Zero behavior change in the canonical repo (`ever-jobs/ever-jobs`).
- No new inputs, secrets, or vars.

## 3. Non-Goals

- Enabling forks to publish their own images (that would require templating the namespace off `github.repository_owner` and is a separate, opinionated change).
- Any change to tags, cache, runners, or trigger paths.

## 4. User / Caller Stories

> As a **fork maintainer**, I want the image-publish jobs to skip on my fork, so that I don't get failing runs and wasted runner minutes for a push I can never authorize.

## 5. Functional Requirements

| ID    | Requirement                                                                 | Priority |
| ----- | --------------------------------------------------------------------------- | -------- |
| FR-1  | Both `build` and `build-mcp` jobs run only when `github.repository == 'ever-jobs/ever-jobs'`. | must     |
| FR-2  | On forks the jobs report as skipped, not failed.                            | must     |
| FR-3  | Canonical-repo behavior (tags, cache, runners, triggers) is unchanged.      | must     |

## 6. Non-Functional Requirements

| ID     | Requirement                            | Target            |
| ------ | -------------------------------------- | ----------------- |
| NFR-1  | Runner minutes consumed on forks       | 0 (jobs skipped)  |

## 7. Contracts

### 7.1 Workflow guard

```yaml
jobs:
  build:
    if: ${{ github.repository == 'ever-jobs/ever-jobs' }}
    ...
  build-mcp:
    if: ${{ github.repository == 'ever-jobs/ever-jobs' }}
    ...
```

### 7.2 Errors

| Code                        | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `denied: permission_denied` | Pre-fix symptom on forks; eliminated by skipping.    |

## 8. Test Plan

- Manual/observational: on a fork, a qualifying push shows both jobs skipped (grey), no `permission_denied`.
- Canonical repo: a qualifying push still runs both jobs and pushes to `ghcr.io/ever-jobs/*`.
- Static: `github.repository` is always the full `owner/repo` of the repo the workflow runs in, so the guard is exact.

## 9. Open Questions

(none)

## 10. Decisions

- Chose a repository guard over templating the namespace off `github.repository_owner`. The guard is the minimal, presumption-free fix: it stops the doomed run for all forks without imposing a fork-publishing model. Owner-based namespacing can be layered on later if forks should publish.

## 11. References

- `.github/workflows/docker-build-publish.yml`
