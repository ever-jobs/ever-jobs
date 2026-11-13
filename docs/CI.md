# Continuous Integration — blocking and non-blocking jobs

The `CI` workflow (`.github/workflows/ci.yml`) runs on every push and pull
request to `main` and `develop` (plus a weekly schedule and manual dispatch).
This page says which jobs can turn a run red and which only report.

Pull requests and branch pushes run in-cluster: the `ci-builds` runner executes
the unchanged workflow with `act` and reports one
commit status, `ci-builds/ci.yml`. It is red when any job fails. act does **not**
read a job-level `continue-on-error`; only the step-level one makes a failure
non-blocking there. The job-level flag still applies on GitHub-hosted runners
(fork pull requests).

## Blocking jobs (a failure fails the run)

These are deterministic: they run offline against code, mocks and fixtures, so a
failure means the change is wrong.

| Job                             | What it checks                                                             |
| ------------------------------- | -------------------------------------------------------------------------- |
| Docs Lint                       | `npm run lint:docs` and the `scripts/` unit tests                          |
| Build & Type-Check              | API and spec type-check, `nest build` for the API and the CLI              |
| Test (Health & Smoke)           | the `apps/api` health endpoint specs                                       |
| Test (Core)                     | `npm run test:core`: common, plugin, models, analytics, API, MCP, CLI unit |
| Test (Feature Plugins)          | dedup, merge, stores, liveness, legitimacy and career-level plugins        |
| Docker Build                    | image build and a `/health` check of the started container                 |
| Test (Source Scrapers unit N/3) | the mocked source-plugin suites; see the note below                        |

## Non-blocking test steps (`continue-on-error: true` on the step)

| Job                            | Why its test steps do not block                             |
| ------------------------------ | ----------------------------------------------------------- |
| Test (E2E - Live APIs)         | sends real requests to live services                        |
| Test (Source Scrapers e2e N/6) | the `*.e2e-spec.ts` suites call live third-party job boards |

Both jobs carry `continue-on-error: true` on the job (read by GitHub-hosted
runners) and on each test step (read by act). Their setup steps (checkout,
`npm ci`) are not covered, so a failed install still fails the run.

### Why live-site jobs are not blocking

A live e2e suite depends on a site we do not control. On any given run some
board may be down, answer 429 or 403 to a shared CI address, or change its
listing markup or ranking. That says nothing about the pull request, and with
roughly 250 live suites a red run became the normal state, which hides real
failures.

So the live shards:

- keep running, and their results stay visible in the job logs (and, on
  GitHub-hosted runners, in the annotations from `--reporters=github-actions`);
- use `strategy.fail-fast: false`, so on GitHub-hosted runners one board's
  failure never cancels the sibling shards (act never cancels sibling legs);
- mark the test step `continue-on-error: true`, so a failing shard does not
  fail the run.

A failing live shard is a signal to fix the affected source (or its test), not a
reason to block unrelated work. The coverage a source needs in order to be
trusted lives in its fixture-based parser unit tests; assert exact behaviour
(URL building, parsing, mapping) there and keep the live test to shape checks
that do not depend on what a board ranks first.

### Note on the unit scraper shards

`Test (Source Scrapers unit N/3)` runs only mocked suites
(`--testPathIgnorePatterns e2e-spec`), so it is deterministic. Its
`continue-on-error: true` is on the job only, so it blocks the in-cluster run
and does not block a GitHub-hosted run.
