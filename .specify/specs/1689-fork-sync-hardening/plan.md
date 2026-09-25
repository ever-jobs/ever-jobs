# Plan: 1689 — Fork sync hardening: ReDoS, SSRF, shared state, and behaviour the fork removed

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1689        |
| Spec         | spec.md     |
| Status       | Implemented |
| Created      | 2026-09-24  |
| Last updated | 2026-09-25  |

## 1. Approach

Fast-forward first, fix on top. The sync branch `fork-sync/makedeeply-2026-09-24` is a pure
fast-forward of `origin/develop` (`574bd922`) to the fork tip `11c61771`, so the fork's history
lands unchanged and every correction is one reviewable commit (`a243b1b9`) on top of it. Nothing
the fork wrote is reverted: where the fork removed or changed a behaviour, the old behaviour comes
back behind an option or env variable next to the fork's, per the owner's no-removal rule.

The work ran in four steps:

1. **Review, read-only.** Six lanes (supply chain, authorship, prompt injection, dangerous code,
   core packages, plugins) and a merge test against `0bb390ab`. No fork code was executed during
   review; regex timings came from copies of the literal regexes. Output: the defects in spec §1.1–
   §1.7, with severities.
2. **Five fix lanes in one worktree**, each owning a disjoint file set:
   - **A1 core parser** — `location-parser.ts`, `canonical-key.ts`, `normalize.ts`,
     `scripts/proto`.
   - **A2 surfaces** — `apps/mcp`, `apps/api` GraphQL, Lever/Workday, `CanonicalJob`,
     `dedup-hybrid`.
   - **A3 new-plugin security** — new `url-guard.ts`, `octbr_ai` and the nine company plugins
     (including `labs_actor` and `soundryx`, which arrived after the review).
   - **A4 plugin regressions** — Eightfold, Dover, Wellfound, ADP and the 11 per-plugin location
     heuristics.
   - **A5 tooling** — `jest.config.js`, `package.json` scripts, `ci.yml`, the two stale
     `apps/api` specs, `docs-lint`, the diff3 marker.
3. **Review of the fixes** (correctness, security, owner rules), then a fix-up pass for what it
   found (spec §1.8): the `isRemote` hand-off between A1 and A2 that neither lane wired, the
   over-reach of US-state-first, the per-chunk cap, redirect pinning, host-only logging, the
   browser-context cap, the `octbr_ai` `caCert` reversal, the remaining quadratic regexes,
   GraphQL `country`, the PulseSpace default, and the `.env.example` / MCP README docs.
4. **Verification of the final tree** (spec §6.3), then one commit.

Each lane proved its tests with a red control against the fork's code (spec §6.2) and kept
every file's line endings and BOM.

## 2. Phases

### Phase 1 — Review (read-only)

- Goal: know exactly what the fast-forward brings in.
- Deliverables: per-lane findings with evidence and a verdict on `npm ci --ignore-scripts`.
- Exit criteria: every high or medium finding has an owner lane.

### Phase 2 — Core parser, canonical key, dedup (A1, A2)

- Goal: remove the ReDoS and the parser's hot-path cost without changing its output; restore the
  removed outputs as options; make remote postings merge across sources again.
- Deliverables: `matchRemoteInGeo`, the per-chunk cap, linear trims, the static country lookup,
  US-state-first with its vetoes, the `EVER_JOBS_LOCATION_*` and `EVER_JOBS_CANONICAL_KEY_*`
  options, `isRemote` in the dedup key, `countryCode` on `CanonicalJob`.
- Exit criteria: 0 disagreements with the old regex over 300,000 fuzz strings; 0 differences from
  the fork parser over 1,345 fixture labels and 4,000 random lists; every 60/500-character label
  under 50 ms; a real-parser `Remote` merges with an iCIMS `{ city: 'Remote' }`.

### Phase 3 — Outbound safety (A3, fix-up)

- Goal: no caller-supplied or scraped URL reaches an off-domain or private host.
- Deliverables: `url-guard.ts`, pin-or-ignore in nine company plugins, `octbr_ai` slug and detail
  pinning, redirect pinning, host-only logging, `mundane_co`'s browser lifecycle, the
  persistent-context cap.
- Exit criteria: over 60 bypass inputs refused or normalised to the allowed host; a 302 to
  loopback refused and never reached.

### Phase 4 — Regressions and surfaces (A2, A4)

- Goal: every behaviour the fork removed is reachable again; per-process state is per scrape.
- Deliverables: Eightfold/Wellfound per-scrape state, Dover degrade + `DOVER_JOB_URL_STYLE`, ADP
  early stop + `ADP_MAX_LIST_PAGES`, `EVER_JOBS_ATS_COUNTRY_OVERLAY`, `PULSESPACE_STRATEGY`, 11
  `*_LOCATION_HEURISTICS` switches, MCP string locations and camelCase body, GraphQL fields and
  input validation.
- Exit criteria: the new tests fail against the fork's code and pass against the fix.

### Phase 5 — CI and tooling (A5)

- Goal: CI runs the suites nobody ran, sized to our runners; both jest transformers work; the doc
  lint catches the marker that slipped through.
- Deliverables: `Test (Core)`, `test:core`, `test:typed`, `JEST_TRANSFORMER`, the worker and
  runner variables, docs-lint check 8, the two fixed specs.
- Exit criteria: `ci-workflow.spec.ts` fails on the fork's `ci.yml`; `test:core` passes with
  outbound sockets blocked; `lint:docs` reports the marker before its removal and passes after.

### Phase 6 — Fix-up, verification, docs

- Goal: close the review-of-fixes findings, verify the whole tree, document it.
- Deliverables: spec §1.8 fixes; `.env.example`; `apps/mcp/README.md`; Q-094–Q-096; this spec,
  plan, tasks, the log entry and the index row.
- Exit criteria: spec §6.3 all green apart from the documented `dedup-perf` flake; `lint:docs`
  clean.

## 3. Packages Touched

| Package / path | Change |
| -------------- | ------ |
| `packages/common` | `location-parser.ts` (linear matcher, cap, US-state-first, options), `canonical-key.ts` (remote bucket, country normalisation, options), `normalize.ts` (linear `normalizeTitle`, `stripParentheticals`), new `utils/url-guard.ts`, `http/http-client.ts` (`allowedRedirectHosts`), `browser/browser-pool.ts` (context cap) |
| `packages/models` | `CanonicalJob.countryCode`, schema fields |
| `packages/plugins/dedup-hybrid` | `isRemote` in the key input, `countryCode` provenance |
| `packages/plugins/source-ats-*` | `octbr_ai`, `eightfold`, `wellfound`, `dover`, `adp`, `lever`, `workday`, `greenhouse`, and the heuristic plugins `catsone`, `cleverconnect`, `employmenthero`, `harri`, `jobsoid`, `pinpoint`, `umantis`, `workstream` |
| `packages/plugins/source-company-*` | `4earth_tech`, `ampflame`, `getmaxspace`, `labs_actor`, `mundane_co`, `pulsespace` (+ restored fixtures), `soundryx`, `tau-robotics`, `thermwood`; heuristics in `amazon`, `argospace`, `thinkorbital`; `zennoastronautics` |
| `apps/api` | `gql-types.ts`, `jobs.resolver.ts`, two stale specs |
| `apps/mcp` | `tools.ts`, `README.md` |
| `scripts` | `docs-lint.ts`, new `jest-typed.ts`, `proto/location-parser-v2.ts` |
| root | `.github/workflows/ci.yml`, `jest.config.js`, `package.json` (scripts only), `.env.example` |
| `docs` | `questions.md` (Q-094–Q-096, marker removed), `log.md`, `index.md` |
| `packages/plugin` | (no change) |

## 4. Dependencies

None added or bumped by this spec. The sync itself brings the fork's devDependencies
`@swc/core ^1.16.2` and `@swc/jest ^0.2.39`, which the supply-chain review checked against the
registry (21 lockfile entries, all integrity hashes match). `ts-jest` was already present and is
what `JEST_TRANSFORMER=ts-jest` selects.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| The linear matcher parses some label differently from the old regex | L | M | 300,000-string fuzz and 1,345 fixture labels compared with the old code; 22 literal golden values |
| US-state-first misreads a non-US label | M | M | Vetoes for a named non-US country, listed subdivisions, middle region codes and a first part naming the tail's country; regression tests for every label the review raised; `EVER_JOBS_LOCATION_PREFER_US_STATE=false` restores the fork's reading |
| `canonicalJobId` churn duplicates rows in a persistent store | M (only with a persistent store) | M | Documented in `.env.example` and spec §5.6; `EVER_JOBS_CANONICAL_KEY_*=false` restores the Spec 5123 key |
| Remote-only jobs show no location text | H (by default) | L | `isRemote` carries the signal; `EVER_JOBS_LOCATION_REMOTE_CITY=true` restores `Remote`; owner decision Q-094 |
| A pinned site starts redirecting to a legitimate other host | L | L | `EVER_JOBS_HTTP_PIN_REDIRECTS=false` escape hatch; the refusal is logged with the target host |
| The persistent-context cap closes a context a plugin still needs | L | M | Only idle contexts (no open page) are closed; a busy pool launches over the cap and warns |
| A new blocking CI job goes red on day one | L | M | `test:core` passed locally with sockets blocked; worker count sized under the cgroup limit; timing tests take best of 3 |
| `dedup-perf` NFR-1 flakes under local contention | M (locally) | L | CI runs it with `DEDUP_PERF_NFR1_MS=1000`; changed tree measured ~5–10% slower, well inside that budget |
| A later fork sync reintroduces a removed behaviour or a regex | M | M | docs-lint check 8, `ci-workflow.spec.ts`, and timing tests that miss by orders of magnitude on a regression |

## 6. Rollback Plan

Every change to what the parser, the key or a plugin *outputs* has a switch (spec §5.1), so a
production regression there is rolled back by setting one env variable in the deployment
manifests — no revert and no data change. The pure bug fixes have no switch by design: per-scrape
state in Eightfold/Wellfound, Dover's degrade, ADP's early stop, and URL pinning (an off-domain
`companyUrl` stays ignored).

| Symptom | Switch |
| ------- | ------ |
| Location readings differ from the fork's | `EVER_JOBS_LOCATION_PREFER_US_STATE=false`, `EVER_JOBS_LOCATION_MAX_LABEL_LENGTH=0` |
| Dedup keys differ from the fork's | `EVER_JOBS_CANONICAL_KEY_REMOTE_BUCKET=false`, `EVER_JOBS_CANONICAL_KEY_NORMALIZE_COUNTRY=false` |
| Lever/Workday country fill unwanted | `EVER_JOBS_ATS_COUNTRY_OVERLAY=false` |
| A pinned plugin's redirect is refused | `EVER_JOBS_HTTP_PIN_REDIRECTS=false` |
| Browser contexts closed too eagerly | `EVER_JOBS_BROWSER_MAX_PERSISTENT_CONTEXTS=0` |
| MCP output or request shape | `EVER_JOBS_MCP_LOCATION_FORMAT=city`, `EVER_JOBS_MCP_REQUEST_KEYS=snake` |
| A restored per-plugin location heuristic misreads labels | `<PLUGIN>_LOCATION_HEURISTICS=false` (the fork's shared-parser-only output) |
| ADP lists too few or too many pages | `ADP_MAX_LIST_PAGES=<n>` |
| A Mundane-only worker must free the browser between runs | `MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE=true` |

Reverting `a243b1b9` as a whole is possible and touches no data, but it restores the fork tip with
the ReDoS and the SSRF paths, so it is the last resort.

## 7. Migration Plan

- **Persistent stores.** Anyone running `store-sqlite-drizzle` or `store-postgres-prisma` keyed on
  `canonicalJobId` sees one-time duplicates for remote-only postings and labels ending in a
  country; either accept them or set both `EVER_JOBS_CANONICAL_KEY_*=false`.
- **Deployments that want the legacy `Remote` text** set `EVER_JOBS_LOCATION_REMOTE_CITY=true` in
  their manifests (`ever-co/k8s-gitops` for ours) — a live configuration change, made outside this
  repo.
- **CI.** The new repo variables are optional; the defaults work on GitHub-hosted runners and on
  our ARC pools.

## 8. Open Questions for Plan

None blocking. The defaults the code ships are recorded for the owner in `docs/questions.md`:
Q-094 (`emitRemoteCity`), Q-095 (`allowBareStateProvince`) and Q-096 (shared-parser mis-splits).
