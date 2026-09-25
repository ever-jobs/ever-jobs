# Spec: 1689 — Fork sync hardening: ReDoS, SSRF, shared state, and behaviour the fork removed

| Field          | Value                                                 |
| -------------- | ----------------------------------------------------- |
| Spec ID        | 1689                                                  |
| Slug           | fork-sync-hardening                                   |
| Status         | Implemented                                           |
| Owner          | agent                                                 |
| Created        | 2026-09-24                                            |
| Last updated   | 2026-09-25                                            |
| Supersedes     | —                                                     |
| Related specs  | 1687, 1688, 5118, 5124, 5125, 5134, 5137              |

## 1. Problem Statement

Branch `fork-sync/makedeeply-2026-09-24` fast-forwards `origin/develop` (`574bd922`) to the
MakeDeeply fork tip `11c61771`: 118 commits, 2,132 files, +26,098 / −7,246 lines. The
merge-base is `574bd922`, so the fork is purely ahead and the sync is a fast-forward.

Before anything landed, the fork was reviewed read-only in six lanes (supply chain, authorship,
prompt injection, dangerous code, core packages, plugins) plus a merge test, all against
`0bb390ab` (the first 114 commits). The fork then moved on by four commits (`03053a62` /
`eea2bd64` — `source-company-labs_actor`, Spec 5151; `60506edd` / `11c61771` —
`source-company-soundryx`, Spec 5152); those two plugins were reviewed and fixed in the fix
lanes below rather than in the first pass.

**What the review did not find.** No supply-chain or provenance compromise. The lockfile adds
only `@swc/core`, `@swc/jest` and `@jest/create-cache-key-function` (21 entries, every one from
`registry.npmjs.org`, every `sha512` matching the registry's published integrity); the only new
install script is `@swc/core`'s `postinstall`. The 30 commits authored under the owner's name are
the identical SHAs already on `origin/main`; the 48 fork-only non-merge commits are new work. One
local merge (`8848f449`) added a `Configure Registry` step to the fork's new e2e shard job — byte
for byte the step the other six jobs already carry. No instruction aimed at an AI agent (the
`tau-robotics` fixture's "copy a prompt for your AI agent" text is the company's own
applicant-facing page, read as text and never executed), and no `eval`, subprocess, env reading
or data-sending code in added source.

**What it did find** — defects that would land with the fast-forward:

### 1.1 A merge-blocking ReDoS in the shared location parser

Fork commit `5850d247` (Spec 5124) added, in `parseSingleLabel`:

```ts
const remoteIn = /^(?:remote|hybrid)\b(?:[\s-]*\w+)*?\s+in\s+(.+)$/i.exec(cleaned);
```

`[\s-]*` can match nothing, so `(?:[\s-]*\w+)*?` can split every word 2^(n−1) ways, and with no
` in ` in the label the engine tries all of them. Timed on the regex literal alone (node 24, no
fork code loaded):

| Label | Time |
| ----- | ---- |
| `Remote in Germany` (matches) | 0.1 ms |
| `Remote Opportunity Available Nationwide` (39 chars) | 2,541 ms |
| `Hybrid Washington Metropolitan Area Office` | 7,238 ms |
| `Hybrid Greater Philadelphia Metropolitan Area` (45 chars) | killed after > 15 s |
| `Remote Nationwide Opportunities Available Immediately` (53 chars) | still running at a 60 s timeout |
| `Remote ` + 30 × `a` + `!` / + 32 × `a` + `!` | 2.2 s / 8.1 s (≈ ×2 per character) |

The fork moves about 978 plugins onto this parser (36 used it on `origin/develop`), so every
scraped location label that starts with `Remote`/`Hybrid` reaches it — `affixStrip` only removes
a qualifier followed by a dash, and nothing capped label length. `source-authenticjobs` also runs
it on the caller's own `input.location`, so one API request could block the event loop of the
whole process. A copy of the same regex sits in `scripts/proto/location-parser-v2.ts`.

### 1.2 Parser cost and correctness

- **Throw path on every miss.** `normalizeCountryOnly` called `countryFromString` inside
  `try/catch`; a miss scans 74 entries, builds a 746-character message and throws — 73.6 µs per
  call, at least two misses for an ordinary `San Francisco, CA`.
- **Quadratic trims.** `affixStrip`'s `/^[\s\/&|;,]+|[\s\/&|;,]+$/g` rescans a separator run from
  every position: 113 ms at 10 K characters, 606 ms at 20 K, 2.79 s at 40 K. The fix lanes found
  the same shape in `normalizeTitle` (a 20 K-character `((((` title: 486 ms) and four more
  whitespace-run patterns.
- **Two-letter tails read as ISO countries.** For 3+-part labels the tail went through
  `normalizeCountryOnly`, which now accepts any ISO alpha-2 code: `Downtown, Los Angeles, CA` →
  Canada, `Springfield, Sangamon County, IL` → Israel, `Remote in CO` → Colombia. While fixing
  this, the region code of a correct non-US label was found being re-read as a second country:
  `Munich, BY, DE` → Belarus, `Berlin, BE, DE` → Belgium.

### 1.3 SSRF in the new plugins

- **`source-ats-octbr_ai`** spliced `input.companySlug` (`@IsString()` only) into
  `https://${company}.octbr.ai/`, so `10.0.0.1:6443/?x=` became host `10.0.0.1:6443`, and then
  fetched every `job.url` in the tenant's JSON with no host or scheme check — all at once, bounded
  only by the caller's `resultsWanted`.
- **Six new company plugins** (`4earth_tech`, `ampflame`, `getmaxspace`, `mundane_co`,
  `tau-robotics`, `thermwood`) fetched `input.companyUrl` verbatim, and **`pulsespace`** now opened
  it in a stealth Chromium and followed any `https?://<host>/careers/…` link it rendered.
  `mundane_co` chose which pages the browser opened with the unanchored
  `/(?:airtable\.com|linkedin\.com)\//`, which `http://10.0.0.5/airtable.com/x/pagX` passes.
  `labs_actor` and `soundryx` (the four later commits) carry the same `companyUrl` shape.
- This extends a known weakness rather than creating one: about 13–22 company plugins on
  `origin/develop` already fetch `input.companyUrl || DEFAULT`, and about 21 ATS plugins build
  `https://${slug}.<ats>` unvalidated. None of the new plugins used the Spec 1687 pin-or-ignore
  pattern or the Spec 1688 public-host guard.

### 1.4 Per-process state on singleton services

- **`mundane_co`** called `BrowserPool.close()` in the `finally` of every `scrape()`. The pool is
  process-global, so each Mundane scrape closed every other plugin's in-flight browser page; the
  page it opened itself was never closed.
- **`source-ats-eightfold`** stored the endpoint that worked (`/api/apply/v2/jobs` or
  `/api/pcsx/search`) on the singleton service, so every later tenant was tried only on the first
  tenant's endpoint and could come back silently empty.
- **`source-ats-wellfound`** merged every scrape's remote-config entries into one instance map
  that was never cleared: unbounded growth, and concurrent scrapes reading each other's entries.

### 1.5 Behaviour the fork removed

The owner's standing rule is that nothing is removed — an alternative is kept and made
selectable. The fork removed, with no way back:

- the `{ city: 'Remote', country }` output for remote-only labels (its test "keeps remote-only
  labels visible" was replaced by "never mints a Remote city"), so `Remote` became
  `location: null` on REST, GraphQL `location { city }` and MCP;
- the opt-in default of `allowBareStateProvince` ("Off by default, so every existing caller is
  unaffected") — flipped on;
- Lever/Workday's `applyCountry` (Spec 5118): the ATS country code moved to the new
  `JobPostDto.countryCode`, which no canonical record, dedup key or GraphQL type read;
- PulseSpace's plain-HTTP bundle strategy (Spec 5134 replaced it with a headful browser and
  deleted its fixtures);
- the `ts-jest` transform — `npm test` stopped type-checking specs;
- about 64 plugins' own location heuristics (Spec 5125): `thinkorbital`'s USA default and state
  map, `catsone`'s parenthetical strip, `employmenthero`'s postcode strip, `pinpoint`'s `province`
  fallback, `harri`'s `US`/`GB` inference, and others;
- the canonical key's remote bucket: a parsed `Remote` keyed to `''` and `Remote - US` to
  `united states`, while `source-ats-icims`' `{ city: 'Remote' }` keys to `remote` — the same
  remote job stopped hash-merging across sources.

Plus two changes that turned enrichment into failure or load: Dover's new optional job-groups call
rethrew any 5xx/timeout and failed the whole scrape (and its `jobUrl` changed shape, changing each
job's URL identity), and ADP's new list pagination fetched every page regardless of
`resultsWanted`, with no page cap.

### 1.6 Catastrophic backtracking in new plugins

On third-party JavaScript from fixed hosts: `tau-robotics` `literalArray` — 16 quoted items
163 ms, 20 items 5.5 s, 22 items 42 s; `4earth_tech` `scalarField` — 32 backslashes 260 ms, ×1.6
per character; `labs_actor` `LABS_ACTOR_CHUNK_MAP_RE` (`\s*,?\s*`) — 12 comma-less pairs 6.6 s.

### 1.7 CI and tooling

- Unit shards ran `--maxWorkers=75%`, which jest sizes against the **host's** CPUs; on our
  cgroup-limited ARC pool (6 CPU) that is up to ~27 workers with 30 s per-test timeouts.
- Two `apps/api` suites were red on `origin/develop` and on the fork, and no CI job ran them:
  `corpus-signals.spec.ts` (0/7 — `this.jobsService.searchJobsWithDiagnostics is not a
  function`, a stub from before Spec 1679) and the Gem wire-shape test in
  `source-ats-batch-1.integration.spec.ts` (expected 1 POST, received 4 — Spec 5035 added a
  detail call per posting).
- A diff3 marker, `||||||| 062a1346`, sat at `docs/questions.md:45` with `npm run lint:docs`
  green.
- `mundane-co.service.spec.ts` waited the real 2.5 s Airtable hydrate per job (25.1 s for one test
  against CI's 30 s timeout).

### 1.8 Found by the review of the fixes

The fixes were themselves reviewed (correctness, security, owner rules) before the commit. That
round found: `dedup-hybrid` never passed `isRemote` into the key, so the remote-bucket fix did not
reach production (blocker); the new US-state-first rule misread `Bengaluru, KA, IN` (Indiana),
`Cologne, NW, DE` (Delaware) and `Remote, DE`; the 256-character cap applied to a whole
multi-site list; `createHttpClient` followed a 302 from a pinned host to `127.0.0.1` and returned
the internal body; two-label in-cluster names (`kubernetes.default`) passed the hostname guard;
the refused `companyUrl` was logged verbatim, credentials included; persistent browser contexts
keyed on a caller-supplied proxy grew without bound; passing the caller's `caCert` turned TLS
verification off for `octbr_ai`; `workstream`'s address regex took 21.8 s on a 110 KB page and
the restored heuristics reintroduced quadratic parenthetical strips; GraphQL `country: "DE"`
made the Indeed and Glassdoor sources throw; PulseSpace's `auto` default paid on every scrape for
a bundle fetch known to return nothing; and none of this was documented. Everything in this list
is fixed in `a243b1b9` except the items named in §3.

## 2. Scope

One commit, `a243b1b9`, on top of `11c61771` — 125 files, +10,032 / −481:

- **Core parser, canonical key and dedup** — `packages/common/src/utils/location-parser.ts`,
  `canonical-key.ts`, `normalize.ts`, `scripts/proto/location-parser-v2.ts`,
  `packages/plugins/dedup-hybrid`, `CanonicalJob` in `packages/models`.
- **Outbound safety** — new `packages/common/src/utils/url-guard.ts`, redirect pinning in
  `http/http-client.ts`, the persistent-context cap in `browser/browser-pool.ts`, and the plugins
  `source-ats-octbr_ai` and `source-company-{4earth_tech,ampflame,getmaxspace,labs_actor,mundane_co,pulsespace,soundryx,tau-robotics,thermwood}`.
- **Regressions restored as options** — `source-ats-{eightfold,wellfound,dover,adp,lever,workday}`,
  PulseSpace's bundle strategy, and 11 plugins' location heuristics.
- **API surfaces** — `apps/mcp/src/tools.ts`, `apps/api/src/jobs/{gql-types,jobs.resolver}.ts`.
- **CI and tooling** — `.github/workflows/ci.yml`, `jest.config.js`, `package.json` scripts,
  `scripts/{docs-lint,jest-typed}.ts`, the two stale `apps/api` specs, the diff3 marker.
- **Docs** — `.env.example`, `apps/mcp/README.md`, Q-094–Q-096 in `docs/questions.md`, and this
  spec, its log entry and index row.

## 3. Non-goals

- **The fork's own content beyond these defects.** The mechanical migration of ~1,020 plugins to
  the shared parser is accepted as the fork wrote it, including the `LocationDto` imports it left
  unused and the ~638 specs that take their expected value from `parseLocationText` itself (22
  literal golden-value tests now pin the parser independently — §6).
- **A global SSRF guard.** The older plugins with the same `companyUrl` / slug-to-host shape are
  not touched; neither `createHttpClient` nor `BrowserPool` refuses private addresses on their own.
- **Resolved-IP checks.** `isPubliclyRoutableHostname` judges a name by its shape. DNS rebinding
  and two-label in-cluster names such as `argocd-server.argocd` still pass it; only a connect-time
  `lookup` closes that. The pre-existing `source-ats-recruitee` guard (Spec 1688) has the same gap
  and is not changed here. Playwright navigations (PulseSpace rendered, Mundane's Airtable forms)
  follow redirects unpinned.
- **Caller-supplied `proxies` and `caCert`.** Any non-empty `caCert` makes the shared client skip
  TLS verification, and `proxies` lets a caller aim the pod at any `host:port`. Repo-wide and
  pre-existing; `octbr_ai` simply does not pass `caCert` (as the fork shipped it).
- **The shared-parser mis-splits in Q-096** (`Sarajevo, Bosnia & Herzegovina`, `Austin - TX`,
  `Pune - Maharashtra`, a ZIP in `name`, inconsistent `text`), and the fork's dropping of a second
  country-only entry (`United States; Canada` → the US only), kept so the refactor stays
  output-equivalent.
- **Migrating stored `canonicalJobId` values.** Documented (§5.6), not migrated.
- **Pre-existing failures unrelated to the fork:** `store-sqlite-drizzle` / `store-postgres-prisma`
  are still not in CI (native SQLite build, Prisma client, containers); the `apps/cli` e2e
  `UnknownDependenciesException` is identical on `origin/develop`; MCP `get_job_details` calls a
  `GET /api/jobs/details` route that does not exist.
- **Minor residuals on pinned inputs:** `soundryx` still fetches every detail page one after
  another with no cap; `getmaxspace`'s `indeedJobId` regex is quadratic at worst on input from its
  own pinned site.
- **Deployment configuration.** Changing a default in a running environment (e.g. setting
  `EVER_JOBS_LOCATION_REMOTE_CITY=true`) is a manifest change in `ever-co/k8s-gitops`, not part of
  this repo.

## 4. Decisions

- **D-01 — Replace the regex with a linear scanner that matches the same labels.**
  `matchRemoteInGeo()` is exported and replaces the `remoteIn` regex; `scripts/proto` imports the
  same function. Checked against the old regex on 300,000 fuzz strings across 5 seeds (overlapping
  ` in `, line breaks, untrimmed tails) with 0 disagreements, and against the fork parser on 1,345
  fixture labels plus 4,000 random multi-label lists with 0 differences. There is no switch back
  to the exponential form: the matching semantics did not change, only the cost.
- **D-02 — Cap each site chunk, not the label, and keep the cap configurable.** A `;`/`|` chunk
  longer than `maxLabelLength` (default 256, `EVER_JOBS_LOCATION_MAX_LABEL_LENGTH`, `0` = no cap)
  skips the heuristics and is kept verbatim as `{ text, name }` (`name` omitted when it reads like
  a qualifier). Applying it per chunk keeps a long multi-site list structured. The cap is
  defence in depth; D-01 already removes the blow-up.
- **D-03 — Make every super-linear pattern linear without changing its matches.** `affixStrip`'s
  trim is an index loop (`trimEdgeSeparators`); four whitespace-run patterns gain `(?<!\s)`;
  `splitCityDescriptor` is O(n); `normalizeTitle` strips delimited spans with `indexOf`
  (`stripDelimited`); new linear helpers `stripParentheticals` (`normalize.ts`) and
  `findUsAddressSnippet` (`location-parser.ts`) replace the plugin regexes, each compared with the
  original on 3,000–5,000 random inputs.
- **D-04 — A static country lookup instead of the throw path.** Country names come from a map
  built once; alpha-2 lookups are memoised; each distinct part is parsed once per call; `addEntry`
  uses a `Map` index and the cities-with-state set is built once. Fixture labels parse ~4× faster
  (224 ms → 54 ms). `countryFromString` itself is untouched.
- **D-05 — Read an ambiguous tail as the US state, unless the label says otherwise; keep the
  fork's reading one switch away.** `preferUsStateCode` (default on,
  `EVER_JOBS_LOCATION_PREFER_US_STATE`) reads `CA`/`IL`/`CO`/`IN`… as the US state in 3+-part
  labels and in `Remote in CO`, `Remote - CO`, `Remote CO`. The country reading still wins when
  another part names a non-US country, or a listed subdivision of the country the tail code
  stands for (`Toronto, Ontario, CA` stays Canada), when a middle part is a short region code that is not a US state code
  (`Bengaluru, KA, IN` → India, `Cologne, NW, DE` → Germany), or when the first part names the
  tail's own country (`Colombia, Medellín, CO`); a first part that merely names another country
  does not count (`Peru, Miami County, IN` stays US). With no US part written, `country` stays
  unset rather than invented: `Downtown, Los Angeles, CA` → city `Downtown, Los Angeles`, state
  `CA`. A region code is no longer re-read as a second country (`Munich, BY, DE` → Germany). The
  comma form after a qualifier (`Remote, CA`) keeps the country by default;
  `preferUsStateAfterQualifier` (`EVER_JOBS_LOCATION_PREFER_US_STATE_AFTER_QUALIFIER`, default off)
  reads it as the state.
- **D-06 — Restore the removed parser outputs as options, keeping the fork's defaults.**
  `emitRemoteCity` (`EVER_JOBS_LOCATION_REMOTE_CITY`, default `false`) and `allowBareStateProvince`
  (`EVER_JOBS_LOCATION_BARE_STATE`, default `true`). The review asked for the legacy defaults.
  Flipping `emitRemoteCity` to `true` fails 79 fork plugin spec files (83 tests) that assert a
  remote listing has no city, and neither value reproduces develop for the ~940 migrated plugins
  (they emitted the raw label as `city`). The fork defaults stay, recorded as Q-094 and Q-095.
  The env is read once per process and cached (`resetLocationParserEnvCache()`); a per-call option
  always wins over the env.
- **D-07 — The canonical key keeps the remote bucket and one spelling per country, independent of
  D-06.** `remoteBucket` (default on) keys a remote posting with no concrete site — `isRemote`, or
  a remote token in the flat label or a site — to `remote`; `normalizeCountry` (default on)
  rewrites `US` / `USA` / `United States` / `Country.USA` to one name in site triples and in the
  flat label's last part (US state codes are left alone). `dedup-hybrid` now passes
  `isRemote: raw.isRemote`, so a parsed `Remote`, a parsed `Remote - US` and an iCIMS
  `{ city: 'Remote' }` hash-merge under both `emitRemoteCity` settings. `false` for both
  (`EVER_JOBS_CANONICAL_KEY_REMOTE_BUCKET`, `EVER_JOBS_CANONICAL_KEY_NORMALIZE_COUNTRY`) gives the
  fork's Spec 5123 key.
- **D-08 — One shared URL pin; a company plugin pins or ignores.** `pinUrlToHosts` (new
  `url-guard.ts`) parses with the WHATWG `URL` parser and returns the serialised URL, so the
  consumer fetches exactly the string that was checked. It adds `https://` to schemeless input,
  accepts only `https:` unless `allowHttp` / `upgradeHttp` opt in to `http:`, refuses credentials,
  explicit non-default ports and anything over 4,096 characters, matches subdomains on a dot
  boundary, and also requires `isPubliclyRoutableHostname`. The nine company plugins
  accept an on-domain `companyUrl` (upgrading `http:` to `https:`) and otherwise log the host only
  (`describeUrlForLog`) and scrape their default careers page — the Spec 1687 D-02 shape. There is
  deliberately no switch that re-opens an off-domain `companyUrl`: the feature (an on-domain URL)
  is kept, the SSRF is not.
- **D-09 — `octbr_ai` refuses a bad slug and pins every detail URL to the tenant.** `companySlug`
  must match `OCTBR_AI_SLUG_RE` (`^[a-z0-9-]{1,63}$`, one DNS label) or the scrape returns
  `bad_input` with no request. A `job.url` is used only when it resolves to https on exactly
  `{slug}.octbr.ai`; otherwise it is rebuilt from `job.slug`, or the job is emitted without a
  description. Details are fetched in batches of `OCTBR_AI_DETAIL_CONCURRENCY` (5). The caller's
  `caCert` is not passed, so TLS verification stays on, as the fork shipped it.
- **D-10 — Re-pin every redirect hop.** `HttpClientOptions.allowedRedirectHosts` installs a
  `beforeRedirect` hook (`redirectPinGuard`) that re-runs `pinUrlToHosts` on each hop and rejects
  the request otherwise. The nine company plugins and `octbr_ai` pass it.
  `EVER_JOBS_HTTP_PIN_REDIRECTS=false` turns it off process-wide as an escape hatch.
- **D-11 — Harden the hostname guard where it is cheap, document where it is not.**
  `isPubliclyRoutableHostname` expands every IP spelling the URL parser accepts (decimal, hex,
  octal, IPv4-mapped/compatible, NAT64, 6to4, ULA, link-local…) and refuses dotless names,
  `*.svc`, reserved TLDs, a last label with a hyphen (except `xn--`) and the built-in Kubernetes
  namespaces. Other two-label cluster names are a documented gap (§3).
- **D-12 — A plugin never closes shared browser state.** `mundane_co` closes only its own page, and
  the page's context only when it belongs to that page (a shared persistent context stays open); the
  pool is closed in a new `onModuleDestroy()`. The fork's per-scrape pool shutdown stays reachable
  as `MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE=true` — kept for the no-removal rule, unsafe with
  concurrent scrapes. Airtable/LinkedIn are matched on the parsed hostname (`MUNDANE_APPLY_HOSTS`,
  `MUNDANE_AIRTABLE_HOSTS`); the old regex constant stays exported and `@deprecated`.
  `BrowserPool` closes the least-recently-used **idle** persistent context above
  `EVER_JOBS_BROWSER_MAX_PERSISTENT_CONTEXTS` (default 4, `0` = unbounded, the previous
  behaviour); a context with an open page is never closed under its caller.
- **D-13 — Per-scrape state, not instance state.** Eightfold resolves its endpoint per scrape and
  Wellfound builds its remote-config map per scrape. Both are bug fixes with no switch: the
  fork's fallback behaviour is unchanged, only its scope.
- **D-14 — Optional calls degrade; paging stops when the caller has enough.** Dover: any failure
  of the optional job-groups call logs a warning and the jobs come back without departments;
  `DOVER_JOB_URL_STYLE` picks `jobUrl` — `apply` (default, the fork's `/apply/{slug}/{jobId}`) or
  `board` (the old `/jobs/{slug}` identity); `applyUrl` is always the per-role form. ADP stops
  listing once it holds `offset + resultsWanted` requisitions (it filters nothing after listing),
  under a page cap `ADP_MAX_LIST_PAGES` (default 100; `1` = the old first-page-only behaviour),
  with a warning when the cap cuts the list short.
- **D-15 — Restore the ATS country overlay and carry the code through dedup.** Lever and Workday
  fill `location.country` from the posting's ATS code only when the parser found none, never
  overwriting it; `locations[]` is filled too only when there is a single site, because the code
  applies to the whole posting, not to one of several sites. `countryCode` is still emitted
  either way. `EVER_JOBS_ATS_COUNTRY_OVERLAY=false` gives the fork's Spec 5118 behaviour.
  `CanonicalJob` gains `countryCode` (the first job in the cluster that carries one, provenance in
  `fields.countryCode`); `canonicalJobId` does not read it.
- **D-16 — Both PulseSpace strategies stay in code; the default is the one the live site needs.**
  `PULSESPACE_STRATEGY`: `rendered` (default — the fork's browser path; aliases `render`, `dom`,
  `browser`), `bundle` (plain HTTP, the pre-Spec-5134 `wve` map; alias `http`) or `auto` (bundle
  first, browser fallback). The bundle `<script src>` must be on `pulsespace.com`, detail links
  must share the list page's origin, detail rendering stops at `offset + resultsWanted` when no
  filter is set, and the page's own context is closed. The deleted fixtures are restored
  byte-identical from `574bd922` (the old `careers.html` as `careers-bundle-shell.html`).
- **D-17 — Restore each removed per-plugin location heuristic on top of the shared parser.**
  Fields the parser finds always win; the heuristics only fill gaps. Each has an env switch
  (`<PLUGIN>_LOCATION_HEURISTICS`, default on; `false` = shared-parser output only):
  `thinkorbital` (USA default; a US state name after the city fills a missing state), `harri`
  (`US`/`GB` from the address shape, `US` only for a real US state code), `workstream` (`US` from
  `City, ST ZIP` with a real US state code), `pinpoint` (a province-only location also gives the
  city), `catsone` (parenthetical strip, falling back to the full label when the parenthetical is
  the only geography), `argospace` (parenthetical strip plus a `USA` default), `umantis`
  (`Munich (Germany)`), `employmenthero` (postcode stripped only when it has a digit),
  `cleverconnect` and `jobsoid` (`City - Region`), `amazon` (`US` only for a real US state code —
  the old blanket `?? 'US'` mislabelled non-US jobs). `catsone` and `argospace` parse the stripped
  label with `emitRemoteCity: false`, so `Remote (Paris, FR)` still falls back to Paris whatever
  the env says.
- **D-18 — Plugin regexes on third-party text are linear and size-capped.** `4earth_tech` and
  `labs_actor` `scalarField` use disjoint alternatives; `tau-robotics` `literalArray` is a linear
  bracket scanner that also reads double-quoted items; `LABS_ACTOR_CHUNK_MAP_RE` uses
  `\s*(?:,\s*)?`; `labs_actor`'s `·` tail and `soundryx`'s parenthetical strip are linear helpers.
  Sliced literals are capped (`*_MAX_LITERAL_CHARS`: 1,000,000; PulseSpace bundle 2,000,000).
  `catsone`, `cleverconnect`, `argospace`, `greenhouse`, `umantis`, `thinkorbital`,
  `zennoastronautics`, `workstream` and `harri` drop their quadratic patterns for
  `stripParentheticals`, `(?<!\s)` or `findUsAddressSnippet`.
- **D-19 — MCP renders a string and sends what the API accepts.** `formatJobLocation()` returns
  `city, state, country`, falling back to `name`, then `text`, then `null` — never an object.
  `EVER_JOBS_MCP_LOCATION_FORMAT=city` gives the legacy city-only string. `buildSearchRequestBody()`
  sends camelCase keys (`searchTerm`, `siteType`, `companySlug`, `resultsWanted`) — the global
  `ValidationPipe({ whitelist: true })` was stripping the snake_case ones, so MCP searches ran with
  no search term. `EVER_JOBS_MCP_REQUEST_KEYS` = `camel` (default), `snake` (the legacy shape) or
  `both`. The MCP tool input schema is unchanged. A side effect: an invalid `source` now returns a
  400 instead of quietly searching every source.
- **D-20 — GraphQL exposes the new fields and validates its input.** All additions are nullable.
  `SearchJobsInput` had no class-validator decorators, so the same whitelist pipe stripped it to
  `{}` — every GraphQL search ran without a term and shared one cache key; it now carries
  decorators matching its GraphQL types. `country` is resolved by `resolveSearchCountry()` (enum
  value, name or alias, or ISO alpha-2 — `DE` → `GERMANY`); an unrecognised value is dropped with a
  warning instead of reaching the country-scoped sources.
- **D-21 — Both jest transformers, and CI sized to the runner.** `swc` stays the default;
  `JEST_TRANSFORMER=ts-jest` restores the exact pre-sync config (`preset: 'ts-jest'` + `ts-jest`
  over `tsconfig.base.json`); an unknown value throws. `npm run test:typed` forces `ts-jest`
  through a small TypeScript wrapper (a `node -e` wrapper restarted jest in every worker). Unit
  shards take `--maxWorkers=${{ vars.JEST_SOURCE_UNIT_MAX_WORKERS || '5' }}` on
  `${{ vars.RUNNER_SOURCE_UNIT || vars.RUNNER_LINUX_X64_8 || 'ubuntu-latest' }}`; the fork's deleted
  sharding rationale is restored in the workflow comment.
- **D-22 — A blocking job for the suites no job ran.** `Test (Core)` (`needs: build`, no
  `continue-on-error`, 45 min) runs `npm run test:core` with
  `--maxWorkers=${{ vars.JEST_CORE_MAX_WORKERS || '3' }}`. The path list lives in the `test:core`
  script so local and CI cannot drift; every suite in it was run with outbound sockets blocked and
  opened none. `legitimacy-detector` (hermetic, used by `corpus-signals`) joins the Feature Plugins
  job. The two stale specs are fixed, not skipped: the `corpus-signals` stub is typed from the real
  `JobsService`, and the Gem test expects one list call plus one detail call per posting.
- **D-23 — docs-lint catches conflict markers.** Check 8 (`conflictMarkers`) flags lines starting
  with `<<<<<<<`, `|||||||` or `>>>>>>>` followed by a space or end of line; a bare `=======`
  counts only between an opening marker and a later `>>>>>>>`, so a setext underline never trips
  it. The stray line in `docs/questions.md` is deleted and nothing else in that file changes.

## 5. Contracts

### 5.1 Runtime environment variables

All are optional. Unset means the default shown.

| Variable | Default | Accepted values | Meaning |
| -------- | ------- | --------------- | ------- |
| `EVER_JOBS_LOCATION_MAX_LABEL_LENGTH` | `256` | integer ≥ 0; other values warn and use the default | A `;`/`\|` site chunk longer than this is kept verbatim. `0` = no cap. |
| `EVER_JOBS_LOCATION_REMOTE_CITY` | `false` | `true/false`, `1/0`, `yes/no`, `on/off`; other values warn | `true` = legacy `{ city: 'Remote', country }` for remote-only input (Q-094). |
| `EVER_JOBS_LOCATION_BARE_STATE` | `true` | as above | `false` = a bare `Virginia` / `VA` stays a city, the pre-fork opt-in default (Q-095). |
| `EVER_JOBS_LOCATION_PREFER_US_STATE` | `true` | as above | `false` = the fork's ISO-country-first reading of ambiguous tails. |
| `EVER_JOBS_LOCATION_PREFER_US_STATE_AFTER_QUALIFIER` | `false` | as above | `true` = `Remote, CA` / `Hybrid, DE` read as the US state. |
| `EVER_JOBS_CANONICAL_KEY_REMOTE_BUCKET` | `true` | as above | `false` = no remote bucket (the Spec 5123 key). Changes `canonicalJobId` (§5.6). |
| `EVER_JOBS_CANONICAL_KEY_NORMALIZE_COUNTRY` | `true` | as above | `false` = countries hashed as written. Changes `canonicalJobId` (§5.6). |
| `EVER_JOBS_ATS_COUNTRY_OVERLAY` | on | `false`, `0`, `no`, `off` turn it off; anything else is on | Lever/Workday fill a missing `location.country` from the ATS code. Off = Spec 5118 (`countryCode` only). |
| `EVER_JOBS_HTTP_PIN_REDIRECTS` | on | `false`, `0`, `no`, `off` turn it off | Off = clients with `allowedRedirectHosts` follow redirects anywhere again. |
| `EVER_JOBS_BROWSER_MAX_PERSISTENT_CONTEXTS` | `4` | integer ≥ 0; other values use the default | Idle persistent Chromium contexts closed LRU-first above this. `0` = unbounded. |
| `EVER_JOBS_MCP_LOCATION_FORMAT` | `full` | `city`; anything else is `full` | `full` = `city, state, country` (then `name`, `text`); `city` = legacy city-only. |
| `EVER_JOBS_MCP_REQUEST_KEYS` | `camel` | `snake`, `both`; anything else is `camel` | Search request key style the MCP server sends to the API. |
| `PULSESPACE_STRATEGY` | `rendered` | `rendered` (`render`, `dom`, `browser`), `bundle` (`http`), `auto`; unknown warns and uses the default | How PulseSpace reads its board (D-16). |
| `MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE` | off | only `true` (case-insensitive) turns it on | The fork's per-scrape shutdown of the shared browser pool. Unsafe with concurrent scrapes. |
| `DOVER_JOB_URL_STYLE` | `apply` | `apply`, `board`; unknown warns and uses `apply` | `board` = the pre-apply-link `jobUrl` `/jobs/{slug}`. |
| `ADP_MAX_LIST_PAGES` | `100` | positive integer; invalid warns and uses 100 | List pages per scrape, first page included. `1` = first page only. |
| `AMAZON_`, `ARGOSPACE_`, `CATSONE_`, `CLEVERCONNECT_`, `EMPLOYMENTHERO_`, `HARRI_`, `JOBSOID_`, `PINPOINT_`, `THINKORBITAL_`, `UMANTIS_`, `WORKSTREAM_LOCATION_HEURISTICS` | on | `false`, `0`, `off`, `no` turn it off | The plugin's restored pre-Spec-5125 heuristic (D-17). Off = shared-parser output only. |

All of them are listed in `.env.example`; the two MCP variables are also in `apps/mcp/README.md`.

### 5.2 Test and CI switches

| Name | Kind | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `JEST_TRANSFORMER` | env | `swc` | `ts-jest` = type-checked run. Any other value throws. |
| `JEST_CORE_MAX_WORKERS` | repo variable | `3` | Workers for `Test (Core)`. |
| `JEST_SOURCE_UNIT_MAX_WORKERS` | repo variable | `5` | Workers per source unit shard (one under the pool's 6-CPU limit). |
| `RUNNER_SOURCE_UNIT` | repo variable | `RUNNER_LINUX_X64_8`, then `ubuntu-latest` | Runner for the source unit shards. `expect-vip` follows whichever is set. |

New npm scripts: `test:typed` (`ts-node --project tsconfig.base.json -T scripts/jest-typed.ts`,
passes extra jest arguments through) and `test:core` (`jest --testPathPatterns
"(packages/(common|plugin|models|analytics)|apps/api/src|apps/api/__tests__/(jobs|integration)|apps/mcp/__tests__)/"
--testPathIgnorePatterns e2e-spec`).

### 5.3 Per-call options

```ts
// @ever-jobs/common — location-parser.ts: ParseLocationOptions gains
// (unset fields fall back to the EVER_JOBS_LOCATION_* env defaults)
emitRemoteCity?: boolean;              // default false
preferUsStateCode?: boolean;           // default true
preferUsStateAfterQualifier?: boolean; // default false
maxLabelLength?: number;               // default 256; 0 = no cap
// allowBareStateProvince?: boolean    // existing option; default now read from the env (true)

// canonical-key.ts
interface CanonicalKeyInput { /* title, company, location, locations, */ readonly isRemote?: boolean | null; }
interface CanonicalKeyOptions { remoteBucket?: boolean; normalizeCountry?: boolean; }
function canonicalKey(input: CanonicalKeyInput, options?: CanonicalKeyOptions): string;
function canonicalJobId(input: CanonicalKeyInput, options?: CanonicalKeyOptions): string;

// http/http-client.ts — HttpClientOptions gains
allowedRedirectHosts?: readonly string[];  // pin every redirect hop (D-10)

// utils/url-guard.ts
interface PinUrlOptions {
  allowHttp?: boolean;       // default false
  upgradeHttp?: boolean;     // default false; ignored when allowHttp is set
  allowSubdomains?: boolean; // default true (dot boundary)
  allowPort?: boolean;       // default false
}
```

### 5.4 New exports

| Module | Exports |
| ------ | ------- |
| `@ever-jobs/common` — `location-parser.ts` | `matchRemoteInGeo`, `canonicalCountryName`, `findUsAddressSnippet`, `resetLocationParserEnvCache`, `LOCATION_PARSER_ENV`, `DEFAULT_MAX_LOCATION_LABEL_LENGTH` |
| `@ever-jobs/common` — `canonical-key.ts` | `CANONICAL_KEY_ENV`, `resetCanonicalKeyEnvCache`, types `CanonicalKeyOptions`, `CanonicalKeySite` |
| `@ever-jobs/common` — `url-guard.ts` (new, re-exported from `utils/index.ts`) | `pinUrlToHosts`, `isPubliclyRoutableHostname`, `describeUrlForLog`, `PIN_URL_MAX_LENGTH`, type `PinUrlOptions` |
| `@ever-jobs/common` — `normalize.ts` | `stripParentheticals(value, replacement = ' ', { space })` |
| `@ever-jobs/common` — `http-client.ts` | `redirectPinGuard`, `HTTP_PIN_REDIRECTS_ENV` |
| `@ever-jobs/common` — `BrowserPool` | `BrowserPool.DEFAULT_MAX_PERSISTENT_CONTEXTS` (4) |
| `apps/mcp` — `tools.ts` | `formatJobLocation`, `buildSearchRequestBody`, `readLocationFormat`, `readSearchRequestKeyStyle`, `MCP_LOCATION_FORMAT_ENV_VAR`, `MCP_REQUEST_KEYS_ENV_VAR`, types `LocationFormat`, `SearchRequestKeyStyle` |
| `apps/api` — `gql-types.ts` | `resolveSearchCountry`, `OfficeGql` |
| Plugin constants | `OCTBR_AI_SLUG_RE`, `OCTBR_AI_DETAIL_CONCURRENCY`; `*_ALLOWED_HOSTS` in the nine company plugins; `*_MAX_LITERAL_CHARS` (4earth_tech, labs_actor, tau-robotics) and `PULSESPACE_MAX_BUNDLE_LITERAL_CHARS`; `MUNDANE_APPLY_HOSTS`, `MUNDANE_AIRTABLE_HOSTS`, `MUNDANE_CLOSE_BROWSER_POOL_ENV`, `readMundaneClosePoolAfterScrape`; `PULSESPACE_STRATEGY_ENV`, `PULSESPACE_DEFAULT_STRATEGY`, `readPulsespaceStrategy`, type `PulsespaceStrategy`, `PULSESPACE_BUNDLE_MARKERS`; `DOVER_JOB_URL_STYLE_ENV`, `DOVER_BOARD_URL_TEMPLATE`, `parseDoverJobUrlStyle`; `ADP_MAX_LIST_PAGES_ENV`, `ADP_DEFAULT_MAX_LIST_PAGES`, `parseAdpMaxListPages`; `ATS_COUNTRY_OVERLAY_ENV_VAR`, `readAtsCountryOverlay` (Lever, Workday); `<PLUGIN>_LOCATION_HEURISTICS_ENV` and its reader in each of the 11 plugins; new `source-ats-pinpoint/src/pinpoint.constants.ts` |

### 5.5 Data model and API surface

All additive; nothing renamed or removed.

- **`CanonicalJob.countryCode?: string`** (`packages/models`); `CanonicalJobSchema.countryCode` is
  an optional non-empty string, `RawJobSchema.countryCode` optional and nullable.
- **GraphQL.** `JobPostGql` gains `countryCode`, `locations: [LocationGql!]` and
  `offices: [OfficeGql!]`; `LocationGql` gains `name`, `text`, `streetAddress`, `postalCode`; new
  `OfficeGql` (the location fields plus `id`). `LocationGql.text` is described as what the parser
  actually emits — the per-site segment it read, not the raw label (see Q-096).
  `SearchJobsInput` is validated field by field; `country` accepts an enum value, a name/alias or
  an ISO alpha-2 code.
- **MCP.** Tool outputs keep `location: string | null`. The search request body is camelCase by
  default.
- **`octbr_ai` output.** `jobUrl` / `applyUrl` are the tenant-pinned detail URL, falling back to
  the board origin.

### 5.6 `canonicalJobId` migration note

`remoteBucket` and `normalizeCountry` are on by default and change `canonicalJobId` for remote-only
postings and for labels ending in a country code or name. The in-memory store is rebuilt per
process, so this is transient there. A persistent store keyed on `canonicalJobId`
(`store-sqlite-drizzle`, `store-postgres-prisma`) sees one-time duplicates for those jobs. Setting
both `EVER_JOBS_CANONICAL_KEY_*=false` gives the fork's Spec 5123 key — which itself already
differs from `574bd922` for migrated plugins, so no setting reproduces develop's ids exactly.

## 6. Test Plan and Results

### 6.1 Suites added or extended

- **Parser** (`packages/common/__tests__/location-parser.spec.ts`): ReDoS hardening (60- and
  500-character `Remote`/`Hybrid` labels and 20 K-character separator runs under 50 ms, best of 3,
  with the cap on and off), `findUsAddressSnippet`, the per-chunk label cap (lists over 256
  characters stay structured), throughput (5,000 typical labels), US-state-first (every label in
  §1.2 and §1.8 plus `Toronto, Ontario, CA`, `Peru, Miami County, IN`,
  `United States, San Diego, CA`, `Remote in Texas`), restorable legacy behaviour under each
  option, and 22 literal golden values.
- **Canonical key / normalize / dedup**: `canonical-key.spec.ts` (both options, both parser
  settings), `normalize.spec.ts` (linear `normalizeTitle` / `stripParentheticals`),
  `dedup-hybrid.service.spec.ts` (a real-parser `Remote`, a `Remote - US` and an iCIMS
  `{ city: 'Remote' }` merge into one record with one id, under both `emitRemoteCity` settings;
  `countryCode` provenance; `canonicalJobId` unchanged by `countryCode`).
- **Outbound safety**: new `url-guard.spec.ts` (bypass spellings, IP encodings, cluster names),
  new `http-client-redirects.spec.ts` (real loopback servers: a 302 to `127.0.0.1` is refused and
  never reached; a control shows it is followed without the option), `browser-pool.spec.ts` (LRU
  cap, busy contexts never closed), and each of the nine company plugins plus `octbr_ai` (pinning,
  host-only logging, redirects, slug refusal, batching).
- **Regressions**: Eightfold (PCSX-only then v2-only tenant on one instance, the reverse, two
  concurrent, no state left), Wellfound (sequential, concurrent, no state left), Dover (every
  failure mode of job-groups, both URL styles), ADP (1 and 3 pages, offset, the default cap, the
  env value, `=1`, invalid values), Lever/Workday (overlay on and off), PulseSpace (all three
  strategies; the bundle path on the restored fixtures), and a `*.location.spec.ts` or extended
  spec for each of the 11 heuristic plugins. The nine plugins whose quadratic regexes were
  replaced (D-18) each carry a 20 K-character timing test (110 KB for `workstream`, 55 KB for
  `harri`).
- **Surfaces**: new `tools-api-contract.spec.ts` (MCP wire contract and location rendering), new
  `gql-types.schema.spec.ts` (inputs run through the real whitelist pipe), `jobs.resolver.spec.ts`
  (`country` resolution).
- **Tooling**: `docs-lint.spec.ts` (check 8), new `jest-transformer.spec.ts`, new
  `ci-workflow.spec.ts` (fails on a `%` worker count, a missing or non-blocking Core job, or any
  non-e2e spec under `apps/` or the core packages that falls outside `test:core`, listed from
  disk), new `scripts/__tests__/location-parser-v2.spec.ts`.

Timing assertions take the best of 3 runs so a GC pause or CFS throttle on a cgroup-limited
runner does not fail the blocking job; an exponential or quadratic regression still misses its
budget by orders of magnitude.

### 6.2 Red controls

Each fix was shown to be what turns its test green:

| Control | Result |
| ------- | ------ |
| Fork parser on `Remote Nationwide Opportunities Available` | 11.2 s → 3.9 ms (5 ms in the security review) |
| New lane tests against the fork's plugin code | Eightfold 3, Dover 8, Wellfound 2, ADP 6 failures (the Wellfound concurrency test also passes on fork code — a regression guard, not a reproduction) |
| New MCP contract tests against the original `tools.ts` | 4 failures |
| `isRemote: raw.isRemote` commented out in `dedup-hybrid` | 2 of the new dedup tests fail |
| Old `catsone` / `workstream` regexes in the new timing tests | ~400 ms against a 50 ms budget / 19 s |
| `createHttpClient` without `allowedRedirectHosts` | follows the 302 to loopback |
| `docs-lint` on the pre-fix `docs/questions.md` | reports line 45 |
| `ci-workflow.spec.ts` against the fork's `ci.yml` | fails as intended |
| A throwaway spec with a type error | passes by default, fails under `test:typed` with TS2322 (also with 2 workers) |
| `emitRemoteCity` default flipped to `true` | 79 fork plugin spec files (83 tests) fail — why the default stayed (Q-094) |

### 6.3 Verification of the committed tree

| # | Command | Result |
| - | ------- | ------ |
| 1 | `npx tsc --project tsconfig.typecheck.json --noEmit` (packages, apps, scripts) | exit 0, 0 errors |
| 2 | `npx tsc --project apps/api/tsconfig.build.json --noEmit` | exit 0, 0 errors |
| 3 | `npm run lint:docs` | passed |
| 4 | `npm run test:scripts` | 15/15 suites, 241/241 tests |
| 5 | jest `packages/(common\|models\|plugin)/`, e2e excluded | 28/28 suites, 751/751 tests |
| 6 | jest `apps/(api\|mcp)/`, e2e excluded | 22/22 suites, 316/316 tests |
| 7 | jest `packages/plugins/(dedup-hybrid\|merge-default\|store-memory\|liveness-http)/`, 4 workers | 221/222 on the first run; 4 of 6 reruns green (§6.4) |
| 8 | unit suites of all 30 touched plugin dirs, e2e excluded | 38/38 suites, 665/665 tests |
| 9 | jest `packages/plugins/source-`, e2e excluded, 10 workers | 1,626/1,626 suites, 16,226/16,226 tests (28 min 20 s) |

`git diff --check` is clean, no changed file gained CR line endings, the four BOM-carrying service
files kept their BOMs, and no `console.*`, `.only`, `.skip` or `@ts-ignore` was added.

### 6.4 Known flake: `dedup-perf` NFR-1 under contention

`dedup-perf.spec.ts` "NFR-1: 1 000 jobs in under 250 ms (max over 5 runs)" failed 2 of 6 runs
(284 ms, 278 ms) when four workers ran together on a host at ~72% CPU from other processes. It
passed 3/3 in isolation, 3/3 at the fork tip, and in check 8. With the budget forced to 1 ms to
expose the real worst-of-5: isolated 191–229 ms (fork tip 185–194 ms). A steady-state benchmark
puts the changed tree ~5–10% slower for 1 K jobs and ~8–10% for 10 K, from
`flatWithCanonicalCountry` rewriting every flat label before `normalizeLocation`. CI runs this
suite in the Feature Plugins job with `DEDUP_PERF_NFR1_MS=1000`; `Test (Core)` does not run it.

## 7. Open Questions

Recorded in [`docs/questions.md`](../../../docs/questions.md), each with a default that the code
ships:

- **Q-094** — `emitRemoteCity` default: the fork's no-Remote-city (**default A**, `false` in code;
  deployments set `EVER_JOBS_LOCATION_REMOTE_CITY=true` for the legacy text) or the legacy
  `{ city: 'Remote' }` (B, which means rewriting 79 fork plugin specs now and on every later sync).
- **Q-095** — `allowBareStateProvince` default: the fork's on (**default A**) or the pre-fork off
  (B, `EVER_JOBS_LOCATION_BARE_STATE=false`).
- **Q-096** — the shared-parser mis-splits carried in from the fork (§3), and what
  `LocationDto.text` means (**default C**, leave as is until a spec is written).

## 8. References

- Commits: `574bd922` (`origin/develop` before the sync), `0bb390ab` (the reviewed fork tip),
  `11c61771` (the fork tip merged), `a243b1b9` (this spec's fix).
- [Spec 1687](../1687-headful-plugin-navigation-allowlist/spec.md) — the pin-or-ignore shape for
  company plugins; [Spec 1688](../1688-recruitee-public-board-host/spec.md) — the public-host guard
  `isPubliclyRoutableHostname` generalises.
- Fork specs this one amends: [5118](../5118-ats-posting-country-code/spec.md) (ATS country code),
  [5124](../5124-location-parser-rewrite/spec.md) (parser rewrite),
  [5125](../5125-positional-location-parsers/spec.md) (per-plugin parsers),
  [5134](../5134-pulsespace-rendered-dom/spec.md) (PulseSpace rendered DOM),
  [5137](../5137-ci-unit-e2e-shard-split/spec.md) (CI shard split); also 5123 (canonical key),
  5035 (Gem detail calls), 5138 / 5145 (Eightfold fallback).
