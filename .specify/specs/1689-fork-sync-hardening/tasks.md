# Tasks: 1689 — Fork sync hardening: ReDoS, SSRF, shared state, and behaviour the fork removed

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Review (read-only)

- [x] T01 — Review the fork tip in six lanes plus a merge test
  - **Files:** none changed (review of `574bd922..0bb390ab`; the later `labs_actor` / `soundryx`
    commits up to `11c61771` were covered in T13).
  - **Acceptance:** supply chain, authorship, prompt injection, dangerous code, core and plugin
    lanes each report findings with evidence; no fork code executed; the fast-forward, install
    (`npm ci --ignore-scripts`), both CI type-checks and the test suites run in the sync worktree,
    with a control run on `origin/develop` for every failure.

## Phase 2 — Core parser, canonical key, dedup

- [x] T02 — Replace the exponential `remoteIn` regex with a linear matcher
  - **Files:** `packages/common/src/utils/location-parser.ts`,
    `packages/common/__tests__/location-parser.spec.ts`
  - **Acceptance:** `matchRemoteInGeo` exported; 0 disagreements with the old regex over 300,000
    fuzz strings (5 seeds) and 0 output differences from the fork parser over 1,345 fixture labels
    plus 4,000 random lists; `Remote Nationwide Opportunities Available` 11.2 s → 3.9 ms; 60- and
    500-character `Remote`/`Hybrid` labels under 50 ms (best of 3).

- [x] T03 — Per-chunk label cap
  - **Files:** `packages/common/src/utils/location-parser.ts`,
    `packages/common/__tests__/location-parser.spec.ts`
  - **Acceptance:** a `;`/`|` chunk over `maxLabelLength` (default 256,
    `EVER_JOBS_LOCATION_MAX_LABEL_LENGTH`, `0` = no cap) is kept verbatim as `{ text, name }`; a
    list longer than 256 characters keeps every structured site.

- [x] T04 — Make the remaining super-linear parser and normalizer patterns linear
  - **Files:** `packages/common/src/utils/location-parser.ts`, `packages/common/src/normalize.ts`,
    `packages/common/__tests__/normalize.spec.ts`
  - **Acceptance:** `affixStrip` trim is an index loop (20 K-character run 544 ms → 5 ms);
    `(?<!\s)` on `QUALIFIER_SUFFIX_RE`, the ` - ` split, `bareLabelWithStateSuffix` and the
    connector regex with identical matches; `splitCityDescriptor` O(n); `normalizeTitle` linear
    (20 K-character `((((` title was 486 ms); `stripParentheticals` and `findUsAddressSnippet`
    exported and equal to the regexes they replace on 3,000–5,000 random inputs.

- [x] T05 — Static country lookup and single-pass part parsing
  - **Files:** `packages/common/src/utils/location-parser.ts`
  - **Acceptance:** no `countryFromString` throw on the parse path; alpha-2 lookups memoised; each
    distinct part parsed once per call; `addEntry` uses a `Map` index; fixture labels parse
    224 ms → 54 ms; `countryFromString` itself unchanged.

- [x] T06 — US-state-first reading of ambiguous codes, with vetoes
  - **Files:** `packages/common/src/utils/location-parser.ts`,
    `packages/common/__tests__/location-parser.spec.ts`
  - **Acceptance:** `Downtown, Los Angeles, CA` → city `Downtown, Los Angeles`, state `CA`;
    `Springfield, Sangamon County, IL` → state `IL`; `Remote in CO` → state `CO`; `Remote in Texas`
    → state `TX`; `United States, San Diego, CA` → San Diego / CA / United States; still Canada for
    `Toronto, Ontario, CA`; `Bengaluru, KA, IN` → India; `Munich, BY, DE` → Germany (was
    Belarus); `Peru, Miami County, IN` stays US; `Remote, DE` → Germany by default and Delaware
    only with `preferUsStateAfterQualifier`; `EVER_JOBS_LOCATION_PREFER_US_STATE=false` restores
    the fork's reading.

- [x] T07 — Restore removed parser outputs as options
  - **Files:** `packages/common/src/utils/location-parser.ts`,
    `packages/common/__tests__/location-parser.spec.ts`, `docs/questions.md`
  - **Acceptance:** `emitRemoteCity` (`EVER_JOBS_LOCATION_REMOTE_CITY`, default false) and
    `allowBareStateProvince` (`EVER_JOBS_LOCATION_BARE_STATE`, default true); env read once and
    cached, `resetLocationParserEnvCache()` clears it, per-call options win; both legacy behaviours
    covered by tests; the kept fork defaults recorded as Q-094 and Q-095.

- [x] T08 — Canonical key: remote bucket and country normalisation
  - **Files:** `packages/common/src/canonical-key.ts`,
    `packages/common/__tests__/canonical-key.spec.ts`
  - **Acceptance:** `CanonicalKeyInput.isRemote`, `CanonicalKeyOptions { remoteBucket,
    normalizeCountry }` (both default true, `EVER_JOBS_CANONICAL_KEY_*`); `US` / `USA` /
    `United States` / `Country.USA` hash to one country, US state codes untouched; both settings
    tested under both parser settings.

- [x] T09 — Wire `isRemote` into dedup and carry `countryCode`
  - **Files:** `packages/plugins/dedup-hybrid/src/dedup-hybrid.service.ts`,
    `packages/plugins/dedup-hybrid/__tests__/dedup-hybrid.service.spec.ts`,
    `packages/models/src/interfaces/canonical-job.interface.ts`,
    `packages/models/src/schemas/canonical-job.schema.ts`
  - **Acceptance:** a real-parser `Remote`, a `Remote - US` and an iCIMS `{ city: 'Remote' }` merge
    into one canonical record with one id under both `emitRemoteCity` settings; with the new line
    commented out, 2 of the new tests fail; `CanonicalJob.countryCode` set from the first job in
    the cluster that carries one, provenance in `fields.countryCode`; `canonicalJobId` unchanged
    by it.

- [x] T10 — Fix the prototype parser copy
  - **Files:** `scripts/proto/location-parser-v2.ts`,
    `scripts/__tests__/location-parser-v2.spec.ts` (new)
  - **Acceptance:** the prototype imports the shared `matchRemoteInGeo` and carries the same
    lookbehind fixes; its new suite passes under `npm run test:scripts`.

## Phase 3 — Outbound safety

- [x] T11 — Shared URL guard
  - **Files:** `packages/common/src/utils/url-guard.ts` (new),
    `packages/common/src/utils/index.ts`, `packages/common/__tests__/url-guard.spec.ts` (new)
  - **Acceptance:** `pinUrlToHosts`, `isPubliclyRoutableHostname`, `describeUrlForLog` exported;
    userinfo, backslash, `#`/`?`/percent-encoded smuggling, look-alike hosts, non-default ports,
    and decimal/hex/octal/IPv4-mapped/NAT64/6to4/ULA/link-local spellings refused; trailing dots,
    IDNA and `http:`→`https:` (with `upgradeHttp`) normalised; last labels with a hyphen and the
    built-in Kubernetes namespaces refused; the remaining two-label cluster-name gap documented in
    the module header.

- [x] T12 — `octbr_ai`: slug validation, detail pinning, bounded fan-out
  - **Files:** `packages/plugins/source-ats-octbr_ai/src/{octbr_ai.constants.ts,octbr_ai.service.ts}`,
    `packages/plugins/source-ats-octbr_ai/__tests__/octbr_ai.service.spec.ts`
  - **Acceptance:** a slug failing `OCTBR_AI_SLUG_RE` returns `bad_input` with no request; a
    `job.url` off `https://{slug}.octbr.ai` is rebuilt from `job.slug` or skipped; details fetched
    in batches of `OCTBR_AI_DETAIL_CONCURRENCY` (5); redirects pinned to `octbr.ai`; the caller's
    `caCert` is not passed.

- [x] T13 — Pin-or-ignore `companyUrl` in the nine company plugins
  - **Files:** `packages/plugins/source-company-{4earth_tech,ampflame,getmaxspace,labs_actor,mundane_co,pulsespace,soundryx,tau-robotics,thermwood}/src/*.{constants,service}.ts`
    and their `__tests__/*.service.spec.ts`
  - **Acceptance:** an on-domain `companyUrl` is used (`http:` upgraded); anything else is logged
    by host only and the default careers page scraped; credentials and query never reach the log;
    each client passes `allowedRedirectHosts`; `soundryx` also refuses off-domain index tiles.

- [x] T14 — Re-pin every redirect hop
  - **Files:** `packages/common/src/http/http-client.ts`,
    `packages/common/__tests__/http-client-redirects.spec.ts` (new)
  - **Acceptance:** with `allowedRedirectHosts`, a 302 to `127.0.0.1` is refused and the target
    never receives a request (real loopback servers); without it, the control follows the
    redirect; `EVER_JOBS_HTTP_PIN_REDIRECTS=false` disables the guard process-wide.

- [x] T15 — `mundane_co` browser lifecycle and host matching
  - **Files:** `packages/plugins/source-company-mundane_co/src/{mundane-co.constants.ts,mundane-co.service.ts}`,
    `packages/plugins/source-company-mundane_co/__tests__/mundane-co.service.spec.ts`
  - **Acceptance:** no `BrowserPool.close()` in `scrape()`; the pool closes in `onModuleDestroy()`;
    the page is closed in a `finally` and its context only when it owns it;
    `MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE=true` restores the fork's per-scrape close;
    Airtable/LinkedIn matched on the parsed hostname, only https Airtable forms opened; the old
    regex constant kept and `@deprecated`; the 2.5 s hydrate wait stubbed in the spec.

- [x] T16 — Cap idle persistent browser contexts
  - **Files:** `packages/common/src/browser/browser-pool.ts`,
    `packages/common/src/browser/__tests__/browser-pool.spec.ts`
  - **Acceptance:** above `EVER_JOBS_BROWSER_MAX_PERSISTENT_CONTEXTS` (default 4, `0` = unbounded)
    the least-recently-used idle context is closed before a launch; a context with an open page is
    never closed; a busy pool launches over the cap and warns.

## Phase 4 — Regressions and surfaces

- [x] T17 — Eightfold endpoint per scrape
  - **Files:** `packages/plugins/source-ats-eightfold/src/eightfold.service.ts`,
    `packages/plugins/source-ats-eightfold/__tests__/eightfold.endpoints.spec.ts`
  - **Acceptance:** on one service instance, a PCSX-only tenant then a v2-only tenant (and the
    reverse, and both concurrently) each get their own endpoint; no endpoint state left on the
    service; 3 of the new tests fail on the fork's code.

- [x] T18 — Wellfound remote-config map per scrape
  - **Files:** `packages/plugins/source-ats-wellfound/src/wellfound_ats.service.ts`,
    `packages/plugins/source-ats-wellfound/__tests__/wellfound_ats.service.spec.ts`
  - **Acceptance:** sequential and concurrent scrapes do not share entries; no state left on the
    service; 2 of the new tests fail on the fork's code.

- [x] T19 — Dover: job-groups degrades; `jobUrl` style selectable
  - **Files:** `packages/plugins/source-ats-dover/src/{dover.service.ts,dover.constants.ts,dover.types.ts}`,
    `packages/plugins/source-ats-dover/__tests__/dover.service.spec.ts`
  - **Acceptance:** any HTTP error, timeout, network error or malformed job-groups payload logs a
    warning and returns jobs without departments; `DOVER_JOB_URL_STYLE` = `apply` (default) or
    `board` (`/jobs/{slug}`), unknown values warn and use `apply`; `applyUrl` always the per-role
    form; 8 of the new tests fail on the fork's code.

- [x] T20 — ADP: stop at `offset + resultsWanted`, cap pages
  - **Files:** `packages/plugins/source-ats-adp/src/{adp.service.ts,adp.constants.ts}`,
    `packages/plugins/source-ats-adp/__tests__/adp.service.spec.ts`
  - **Acceptance:** 1-page and 3-page tenants, offset counting toward the stop, default cap 100,
    `ADP_MAX_LIST_PAGES` from env, `=1` (first page only), invalid values warn and use 100, a
    warning when the cap cuts the list; 6 of the new tests fail on the fork's code.

- [x] T21 — Lever/Workday ATS country overlay
  - **Files:** `packages/plugins/source-ats-{lever,workday}/src/*.{constants,service}.ts`,
    `packages/plugins/source-ats-{lever,workday}/__tests__/*.service.spec.ts`
  - **Acceptance:** a missing `location.country` is filled from the ATS code (never overwriting a
    parsed one, unresolvable codes ignored); `locations[]` filled only for a single site;
    `countryCode` emitted either way; `EVER_JOBS_ATS_COUNTRY_OVERLAY=false` gives the Spec 5118
    output; the fork's tests cover both settings.

- [x] T22 — PulseSpace: both strategies, pinned
  - **Files:** `packages/plugins/source-company-pulsespace/src/{pulsespace.constants.ts,pulsespace.service.ts}`,
    `packages/plugins/source-company-pulsespace/__tests__/pulsespace.service.spec.ts`,
    `packages/plugins/source-company-pulsespace/__tests__/fixtures/{bundle.js,careers-bundle-shell.html,principal-avionics-architect.html}`
  - **Acceptance:** `PULSESPACE_STRATEGY` = `rendered` (default), `bundle` or `auto`, aliases
    accepted, unknown values warn and use the default; fixtures restored byte-identical from
    `574bd922`; bundle `<script src>` on `pulsespace.com` only; detail links same-origin only;
    detail rendering stops at `offset + resultsWanted` when no filter is set; the page's own
    context closed; the bundle literal capped at 2,000,000 characters.

- [x] T23 — Restore the per-plugin location heuristics Spec 5125 removed
  - **Files:** `src/*.{constants,service}.ts` and a new or extended `__tests__` spec in
    `source-company-{thinkorbital,argospace,amazon}` and
    `source-ats-{harri,workstream,pinpoint,catsone,employmenthero,umantis,cleverconnect,jobsoid}`;
    `source-ats-pinpoint/src/pinpoint.constants.ts` (new)
  - **Acceptance:** each heuristic fills only gaps the shared parser leaves; each
    `<PLUGIN>_LOCATION_HEURISTICS=false` gives the shared-parser-only output; `amazon` and
    `harri` stamp `US` only for a real US state code; `catsone` / `argospace` parse with
    `emitRemoteCity: false` so `Remote (Paris, FR)` still gives Paris.

- [x] T24 — Linear, size-capped regexes in plugins
  - **Files:** `source-company-{4earth_tech,labs_actor,tau-robotics,soundryx,zennoastronautics,argospace,thinkorbital}`,
    `source-ats-{catsone,cleverconnect,greenhouse,umantis,workstream,harri}` services, constants and
    specs
  - **Acceptance:** `scalarField` (4earth_tech, labs_actor) handles 64 backslashes in ~0.007 ms;
    `tau-robotics` bracket scanner handles 40 items (and double-quoted items) under 50 ms;
    `LABS_ACTOR_CHUNK_MAP_RE` handles 40 comma-less pairs under 50 ms; `*_MAX_LITERAL_CHARS`
    1,000,000; a 20 K-character timing test in each of `catsone`, `cleverconnect`, `argospace`,
    `greenhouse`, `umantis`, `thinkorbital` and `zennoastronautics`, 110 KB for `workstream` and
    55 KB for `harri`; the old `catsone` regex misses its 50 ms budget (~400 ms) and the old
    `workstream` regex takes 19 s.

- [x] T25 — MCP renders strings and sends camelCase
  - **Files:** `apps/mcp/src/tools.ts`, `apps/mcp/__tests__/tools-api-contract.spec.ts` (new),
    `apps/mcp/README.md`
  - **Acceptance:** `formatJobLocation` never returns an object; `EVER_JOBS_MCP_LOCATION_FORMAT`
    (`full` / `city`) and `EVER_JOBS_MCP_REQUEST_KEYS` (`camel` / `snake` / `both`); tool input
    schema unchanged; 4 of the new wire-contract tests fail on the original `tools.ts`; both
    variables in the README env table.

- [x] T26 — GraphQL fields, input validation and `country`
  - **Files:** `apps/api/src/jobs/gql-types.ts`, `apps/api/src/jobs/jobs.resolver.ts`,
    `apps/api/src/jobs/__tests__/gql-types.schema.spec.ts` (new),
    `apps/api/src/jobs/__tests__/jobs.resolver.spec.ts`
  - **Acceptance:** `JobPostGql.{countryCode,locations,offices}`, `LocationGql.{name,text,streetAddress,postalCode}`,
    `OfficeGql`, all nullable; `SearchJobsInput` survives the real whitelist pipe;
    `resolveSearchCountry` maps enum values, names/aliases and alpha-2 (`DE` → `GERMANY`), and the
    resolver drops anything else with a warning; `LocationGql.text` described as what the parser
    emits.

## Phase 5 — CI and tooling

- [x] T27 — Both jest transformers
  - **Files:** `jest.config.js`, `package.json`, `scripts/jest-typed.ts` (new),
    `scripts/__tests__/jest-transformer.spec.ts` (new)
  - **Acceptance:** `swc` default; `JEST_TRANSFORMER=ts-jest` restores the pre-sync config; an
    unknown value throws; `npm run test:typed` fails a spec with a type error (TS2322) that the
    default run passes, including with 2 workers; the `moduleNameMapper` block is unchanged.

- [x] T28 — CI sized to our runners, and a blocking core job
  - **Files:** `.github/workflows/ci.yml`, `package.json`, `scripts/__tests__/ci-workflow.spec.ts`
    (new)
  - **Acceptance:** unit shards use `JEST_SOURCE_UNIT_MAX_WORKERS` (5) on `RUNNER_SOURCE_UNIT`
    (then `RUNNER_LINUX_X64_8`, then `ubuntu-latest`); `Test (Core)` runs `npm run test:core` with
    `JEST_CORE_MAX_WORKERS` (3), `needs: build`, no `continue-on-error`; `legitimacy-detector` in
    the Feature Plugins job; `ci-workflow.spec.ts` fails on the fork's `ci.yml` and on any non-e2e
    core spec outside `test:core`; `test:core` passes with outbound sockets blocked.

- [x] T29 — Fix the two stale `apps/api` specs
  - **Files:** `apps/api/__tests__/jobs/corpus-signals.spec.ts`,
    `apps/api/__tests__/integration/source-ats-batch-1.integration.spec.ts`
  - **Acceptance:** the `corpus-signals` stub provides `searchJobs` and `searchJobsWithDiagnostics`
    typed from the real `JobsService`, plus a test that the controller calls the latter; the Gem
    test expects one list call plus one detail call per posting (4 for 3), citing Spec 5035.

- [x] T30 — docs-lint catches conflict markers; remove the stray one
  - **Files:** `scripts/docs-lint.ts`, `scripts/__tests__/docs-lint.spec.ts`, `docs/questions.md`
  - **Acceptance:** check 8 (`conflictMarkers`) reports line 45 of the pre-fix `docs/questions.md`;
    a setext `=======` underline is not flagged; only the `||||||| 062a1346` line is deleted;
    `npm run lint:docs` passes.

## Phase 6 — Verification and docs

- [x] T31 — Document every switch
  - **Files:** `.env.example`, `apps/mcp/README.md`, `docs/questions.md`
  - **Acceptance:** every env variable the commit introduces is in `.env.example` with its
    default, including the `canonicalJobId` warning for persistent stores; Q-094, Q-095, Q-096
    recorded with defaults.

- [x] T32 — Verify the final tree
  - **Files:** none changed
  - **Acceptance:** both `tsc` type-checks clean; `lint:docs` and `test:scripts` (15/15 suites,
    241 tests) green; `packages/(common|models|plugin)` 751/751 and `apps/(api|mcp)` 316/316;
    all 30 touched plugin dirs 665/665; `packages/plugins/source-` 1,626/1,626 suites and
    16,226/16,226 tests; the `dedup-perf` NFR-1 contention flake measured and recorded (spec §6.4).

- [x] T33 — Spec, plan, tasks, log and index
  - **Files:** `.specify/specs/1689-fork-sync-hardening/{spec.md,plan.md,tasks.md}`,
    `docs/log.md`, `docs/index.md`
  - **Acceptance:** `docs/log.md` entry at the top (newest first); `docs/index.md` row after 1688
    and footer updated; `npm run lint:docs` clean.

## Notes

- Each lane's new tests were run against the fork's code first where a fork version existed, so
  a green test proves the fix rather than the absence of the case.
- Every changed file kept its line endings (LF) and BOM.
