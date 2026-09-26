# Ever Jobs — Project Constitution

> Non-negotiable design principles. If a new spec contradicts a clause here, the
> spec must be rejected or the constitution must be amended (with a recorded ADR
> in `docs/adr/`).

## Article 1 — Identity

Ever Jobs is a **TypeScript-only, NestJS-based, plugin-first** platform for unified job
discovery, enrichment, and analytics across hundreds of sources (job boards, ATS,
company pages, niche & regional aggregators).

## Article 2 — Modularity

1. The **core** (NestJS application skeleton, plugin registry, HTTP client, models)
   contains *no* domain feature logic.
2. Every domain feature is a **plugin package** under `packages/plugins/<plugin-id>/`.
3. Plugins MAY depend on `@ever-jobs/common`, `@ever-jobs/models`, `@ever-jobs/plugin`.
   Plugins MUST NOT depend on each other directly — only via published interfaces.
4. Every plugin is **enable/disable-toggleable** at runtime via configuration.
5. Replacing a plugin (e.g. switching `store-redis` for `store-memcached`) MUST require
   no source-code change in the core or in other plugins.

## Article 3 — TypeScript Only

1. All production source is `.ts`.
2. Build/dev scripts may be `.ts` (run via `ts-node`/`tsx`) or `.sh` for OS-level glue.
3. **No** `.js`, `.cjs`, `.mjs` runtime modules in `apps/` or `packages/`.
4. **No** Python, Ruby, Go, or other languages added as runtime dependencies.

## Article 4 — Spec-First Development

1. No code is written for a feature without a `spec.md` and a `plan.md`
   in `.specify/specs/<NNN>-<slug>/`.
2. The spec must answer: *what, why, scope, non-goals, contracts, test plan*.
3. The plan must list: *phases, packages touched, dependencies, risks*.
4. The tasks file must contain ordered, verifiable, ≤1-day work items.

## Article 5 — Performance

1. **Latency budgets:** API median < 250 ms cached, < 1.5 s on-cache-miss aggregated.
2. **Throughput:** scraping pipeline must sustain ≥ 50 concurrent source calls.
   _Amended 2026-09-25 ([ADR 0001](../../docs/adr/0001-crawl-policy.md), Spec 1690):_ across
   sources; toward any one host the crawl policy's per-host limits apply.
3. **Memory:** per scraping batch capped (default 5 000 jobs) with explicit overrides.
4. **I/O:** all network operations use pooled HTTP clients with circuit-breakers.
   _Amended 2026-09-25 ([ADR 0001](../../docs/adr/0001-crawl-policy.md), Spec 1690):_ every
   outbound request through `@ever-jobs/common` is also paced by one process-wide
   limiter per host (or registrable domain / site), resolved from the crawl policy.
5. **Caching:** every read endpoint is cacheable; cache backend is a plugin.

## Article 6 — Reliability

1. Fan-out uses `Promise.allSettled`; one source failure never aborts a request.
   _Amended 2026-09-25 ([ADR 0001](../../docs/adr/0001-crawl-policy.md), Spec 1690):_ the fan-out
   itself does not bound load on a host — the crawl-policy host limiter does; fragile
   sites are read sequentially. Requests of a source abandoned at the search deadline
   are cancelled.
2. Each plugin has a circuit breaker (open after 5 consecutive failures, half-open
   after 30 s).
   _Amended 2026-09-25 ([ADR 0001](../../docs/adr/0001-crawl-policy.md), Spec 1690):_ a scrape we
   aborted at our own deadline is circuit-neutral; the tracked-site cap is
   configurable (`EVER_JOBS_CIRCUIT_MAX_SITES`, default 4096).
3. Each plugin records `success`, `failure`, `duration_ms`, `result_count` metrics
   exported via Prometheus.
4. All errors return structured JSON with a stable `errorCode` enum.

## Article 7 — Documentation

1. `docs/index.md` always lists every doc with a 1-sentence description.
2. `docs/log.md` is append-only (newest at top); every doc/spec change is recorded.
3. `docs/questions.md` is an open ledger; agents add ambiguities + a default choice.
4. Each plugin package has a `README.md` describing inputs, outputs, and limits.

## Article 8 — Testing

1. Every public function has a unit test.
2. Every plugin has at least one happy-path integration test.
3. Every API endpoint has at least one e2e test (request→response).
4. Snapshot tests are allowed only for stable, version-pinned outputs.

## Article 9 — Dependencies

1. Always prefer the latest stable version of each dependency.
2. Prefer popular, maintained libraries over hand-rolled implementations.
3. New direct dependencies require a justification line in the spec's `plan.md`.

## Article 10 — Backwards Compatibility

1. Public API endpoints follow semver. Breaking changes ⇒ major version bump.
2. Plugin interfaces are versioned (`IScraperV1`, `IScraperV2`, …); new majors live
   in parallel until all plugins migrate.

## Article 11 — Security

1. Secrets only via env vars; never in source.
2. All external HTTP calls go through `@ever-jobs/common` HTTP client which redacts
   `Authorization`, `Cookie`, and `*api*key*` headers from logs.
   _Amended 2026-09-25 ([ADR 0001](../../docs/adr/0001-crawl-policy.md), Spec 1690):_ that client
   also refuses loopback / private / link-local / cluster-internal destinations by
   default (egress guard; operators can allow-list or disable it, callers cannot).
3. Rate-limit every public endpoint (`@nestjs/throttler`).
4. Validate every inbound payload with Zod or class-validator.
5. **Crawl politeness** (added 2026-09-25, [ADR 0001](../../docs/adr/0001-crawl-policy.md), Spec 1690):
   by default we identify ourselves honestly (a User-Agent naming Ever Jobs, no browser
   impersonation or UA rotation unless an operator — or a plugin with a stated reason —
   chooses it), pace requests per host, keep one stable origin per site, and never retry
   earlier than a server asks. Every aspect is configurable (preset, env, plugin
   manifest, operator per-site/host policy, per request); the pre-1690 behaviour remains
   available as the `legacy` preset.

---

_Ratified: 2026-04-26._
_Amended: 2026-09-25 — [ADR 0001](../../docs/adr/0001-crawl-policy.md) (Spec 1690): Art. 5.2, 5.4, 6.1, 6.2, 11.2 annotated; Art. 11.5 added. No text removed._
_Amend via ADR in `docs/adr/`._
