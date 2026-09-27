# Plan: 1714 — Crawl policy: site-owner caller lock, host-owned policies, gentler pacing knobs

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | [spec.md](./spec.md)               |
| Created      | 2026-09-26                         |
| Last updated | 2026-09-26                         |

## 1. Approach

The audit gaps in the shared layer have one root cause each, and one fix each, all
inside the Spec 1690 machinery; nothing is re-architected.

**The caller lock** is a new optional key, `callerOverrides`, on the override type that
every layer already uses. It is not a policy field: `applyLayer` only copies
`CRAWL_POLICY_FIELDS`, so the key never reaches the resolved policy, and
`filterCallerOverride` already refuses non-fields, so a caller can never send one.
`explainCrawlPolicy` already walks exactly the layers that may carry a lock (the plugin
manifest from the scrape context, the plugin's client options, the builtin host entry,
the operator site and host entries); it now also reduces their `callerOverrides` values
to one effective mode (most restrictive of global / plugin / builtin host, replaced by an
operator value when there is one) and filters the caller layer with it instead of the
global mode. `resolveCallerOverrides()` exposes the same reduction without building a
policy, for `JobsService` (which knows the site but not yet the host).
`getEffectiveCrawlResolution()` returns it next to the policy from the existing memo, so
`HttpClient` gets it for free per request.

**`stricter`** gets four sharper comparators (scope containment, a strict rotation
order, 429/503 kept in `retryStatuses`, `discovery` only towards `sitemap`) and two new
fields; the 1690 table stays selectable with `EVER_JOBS_CRAWL_STRICTER_RULES=1690`
(no-removal rule). Caller proxies and `requestTimeout` are not policy fields, so they are
gated next to the places that consume them: `JobsService.scrapeOne` for the plugin (site
level), `HttpClient.sendUnderPolicy` for a host lock reached by another plugin (proxies
only; see spec D5 for why the timeout needs no per-host clamp). The per-host proxy pick
keys on the scope resolved *without* the caller when that scope is `domain`, so a caller
cannot split one site's tenants across proxies.

**Host-owned policy** reuses the operator `hosts` matcher (`hostMatches`,
`hostPatternSpecificity`) for `BUILTIN_HOST_POLICIES`, so `*.softy.pro` means exactly what
it means in an operator file. Its entry equals the Softy manifest on every pacing, retry
and lock field (a parity test in the Softy suite guards it) and applies to every site —
liveness probes, JSON-LD, anything — because the builtin layer is resolved per request
host, not per plugin.

**Pacing knobs** live where pacing lives: `minGapMs` in the host limiter's `release()`
(the only point that knows when a request completed), `serverErrorCooldownMs` next to the
existing 429/503 penalty in `sendUnderPolicy` and `recordAnswerOutcome` (so browser
navigations get it too), and the fleet multiplier in `crawlAcquireOptions` (shared by
`HttpClient` and `BrowserPool`). robots.txt answers go through `recordAnswerOutcome` like
page answers. `fetchSitemap` learns to stop on push-back from a nested document.

**The API side** is three small switches in known places: the multi-location refusal
predicates (`refusalFromError` / `refusalFromDiagnostics`) recognise 503; the breaker's
`exec` looks at a resolved result before calling `onSuccess`; the controller's liveness
enrichment skips jobs whose plugin fetched `jobUrl` during this request.

Every behaviour change has a named switch that restores the pre-1714 behaviour (spec
§7.4), and a golden test pins the policy resolution of every source without a lock under
the default `any`.

## 2. Phases

### Phase 0 — Contract (CORE, first)

- Goal: freeze every name in spec §7 so the SOFTY and API lanes compile against it.
- Deliverables: T01 (types, presets, builtin Softy entry, env names, new exports with
  their default behaviour, models fields and helpers).
- Exit criteria: `npx tsc -p tsconfig.typecheck.json --noEmit` clean; `npm run
  test:core` green except tests that assert the old builtin/comparator behaviour (listed
  in T01 for the owning lanes).

### Phase 1 — Mechanisms and entry points (CORE and API in parallel; SOFTY runs Spec 1715)

- Goal: every FR implemented with its tests and red controls.
- Deliverables: CORE T02–T10, API T11–T17.
- Exit criteria: each lane's own suites green, each key test's red control reported.

### Phase 2 — Documentation (each lane its own files)

- Goal: operator guide, changelog, questions, index, env example, README.
- Deliverables: CORE T18 (`docs/CRAWL_POLICY.md`), API T19 (changelog, log, index,
  questions, `.env.example`), SOFTY (Spec 1715 T14, `README.md`).
- Exit criteria: `npm run lint:docs` clean.

### Phase 3 — Integration verification (orchestrator)

- Goal: prove the lanes fit.
- Deliverables: typecheck, `test:core`, `test:sources` (Softy + liveness-http + every
  suite touching `*.softy.pro`), `test:scripts`, `lint:docs`; spec status and tasks
  ticked; "As built" section.
- Exit criteria: all green; red controls recorded.

## 3. Lane split and file ownership

Three implementation lanes with **disjoint** file ownership, for both Spec 1714 and
Spec 1715. A lane never edits another lane's files; where a task needs a file outside
its natural area, the file is assigned to exactly one lane below.

| Lane | Owns | Assigned from outside its area |
|---|---|---|
| **CORE** | `packages/common/**`, `packages/models/**`, `packages/plugin/src/interfaces/**` | `docs/CRAWL_POLICY.md` (including the Softy section of Spec 1715) |
| **SOFTY** | `packages/plugins/source-ats-softy/**`, `.github/workflows/ci.yml` | `README.md` ("For website operators"), `scripts/__tests__/ci-workflow.spec.ts` (only if it adds an assertion for the live-Softy gate) |
| **API** | `apps/**` (api, mcp, cli), `packages/plugin/src/circuit-breaker/**`, `packages/plugins/liveness-http/**` | `tool_manifest.json`, `.env.example`, `docs/API_CHANGELOG.md`, `docs/log.md`, `docs/index.md`, `docs/questions.md` (all entries for both specs, including Spec 1715's) |
| none (orchestrator) | `.specify/specs/1714-*/**`, `.specify/specs/1715-*/**` | lanes report task results; the orchestrator ticks tasks and writes "As built" |

Cross-lane contract (who needs what from whom):

| Consumer | Needs from CORE (T01) |
|---|---|
| API | `resolveCallerOverrides`, `crawlCallerProxiesAllowedFor`, `gateCallerRequestTimeout`, `DEFAULT_REQUEST_TIMEOUT_SECONDS`, `crawlStricterRules`, `crawlFleetSize`, the new `CrawlPolicyExplanation` fields, `CrawlPolicyDto.minGapMs` / `serverErrorCooldownMs`, `JobPostDto.jobUrlFetchedAt`, `liveness.reason`, `JOB_LIVENESS_REASON_FRESH_FETCH`, `BUILTIN_SOFTY_HOST_POLICY` |
| SOFTY | `PluginCrawlPolicy.callerOverrides`, `minGapMs` / `serverErrorCooldownMs`, `BUILTIN_SOFTY_HOST_POLICY` (parity test), `preferRefusalError`, `looksLikeChallenge` (exists), `decodeSitemapBody` (exists), `JobPostDto.jobUrlFetchedAt`, `fetchSitemap` default `nestedErrors` |

Existing tests that change expectation because of another lane's code (the owner of the
test file updates it): the API lane's `sources-crawl-policy.controller.spec.ts` and
`apps/api/__tests__/integration/crawl-policy.http.spec.ts` (the builtin `*.softy.pro`
layer now appears for `host=acme.softy.pro`); the SOFTY lane's `softy.policy.spec.ts`
(caller `discovery: 'listing'` is refused by the Softy lock).

## 4. Packages Touched

| Package | Change |
|---|---|
| `packages/common` | `crawl/{types,defaults,env,policy-schema,resolve,scrape-context,host-limiter,proxy-selector,sitemap,index}.ts`, new `crawl/caller-lock.ts`, `http-client.ts`; tests |
| `packages/models` | `CrawlPolicyDto` (2 fields), `JobPostDto` (`jobUrlFetchedAt`, `liveness.reason`), `preferRefusalError` |
| `packages/plugin` | `interfaces/plugin-metadata.interface.ts` (doc comment only), `circuit-breaker/circuit-breaker.service.ts` (refused results) |
| `packages/plugins/liveness-http` | new host-policy test only (no source change) |
| `apps/api` | `jobs.service.ts`, `jobs.controller.ts`, `health.controller.ts`, `crawl-policy.mapping.ts`, `gql-types.ts`, `config/configuration.ts` |
| `apps/mcp` | `tools.ts` (`CRAWL_POLICY_INPUT_SCHEMA`) |
| `apps/cli` | none (the `--crawl` JSON already carries any field) |
| repo root | `tool_manifest.json`, `.env.example` |
| `packages/plugins/source-ats-softy` | Spec 1715 |

## 5. Dependencies

| Library | Version | Rationale |
|---|---|---|
| (none new) | — | `tldts` (registrable domain) and the Spec 1690 matcher are reused. |

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A lane's tests go red because another lane's contract part is late | M | L | Phase 0 lands first; the integration phase runs every suite together |
| An operator relied on the looser 1690 `stricter` (e.g. callers choosing `site` scope) | L | M | `EVER_JOBS_CRAWL_STRICTER_RULES=1690`; documented in the operator guide and changelog |
| The builtin Softy entry loosens a `strict` preset's throttle floor (30 s → 10 s) | L | L | Documented (Q-121); operator `hosts["*.softy.pro"]` wins |
| A plugin marks a stale page as freshly fetched | L | M | Only a network fetch in this scrape sets `jobUrlFetchedAt`; the controller trusts it only when not older than the request start and never on a cache hit; `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` |
| A wrong fleet size slows every paced host | L | M | Bounded 1..1000, shown in the policy API meta and logged at start |
| Breaker opens on sources that legitimately answer `blocked` for one tenant | M | L | Only resolved results with 0 jobs count; the default policy needs 5 in a row; `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` |
| Golden test captured after the change (useless) | L | M | T02 captures the fixture from the unchanged code before any resolver edit and records the capture commit in the fixture header |

## 7. Rollback Plan

Configuration first — each change has its own switch (spec §7.4): `EVER_JOBS_CRAWL_STRICTER_RULES=1690`,
`EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket`, `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false`,
`EVER_JOBS_SEARCH_STOP_ON_503=false`, `EVER_JOBS_BREAKER_COUNT_REFUSALS=false`,
`EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false`; the new fields default to 0 / 1. The
Softy lock is undone by an operator `callerOverrides: "any"` for `sites.softy`,
`hosts["*.softy.pro"]` and `hosts["softy.pro"]`, or by `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`
plus `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false`. Code: revert the branch's commits; no data
or schema migration is involved.

## 8. Migration Plan (if applicable)

None. New policy fields default to today's behaviour; the new job field and
`liveness.reason` are optional and additive; `meta.callerOverrides` keeps its name and now
reports the effective mode (identical to the global mode for every source without a
lock). Callers of the Softy source lose the ability to make its traffic less polite on a
default install — the purpose of the change — and see refused fields in
`meta.caller.rejected` of the policy preview.

## 9. Open Questions for Plan

Q-120..Q-125 (spec §9) carry defaults; none blocks implementation. The docs pass added Q-126..Q-128 (caller-override default for other sources, our deployments' fleet size and contact, Softy's retry numbers), also with defaults.
