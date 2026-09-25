# Tasks: 1693 — Source Job Board Plugin: Level (jobsbylevel.com), AI-rated listings

- [x] T0 — Live verification with the honest User-Agent, robots-allowed paths only, ≥ 2 s apart: `/llms.txt`, `/.well-known/api-catalog`, `/developers`, the MCP server card, one `search_jobs`, one `get_job`. Acceptance: every open question of the design answered (spec D-01); fixtures trimmed from the replies.
- [x] T1 — Spec, plan and tasks for 1693. Acceptance: H1 + metadata table on spec and plan.
- [x] T2 — Package scaffold (`package.json`, `tsconfig.json`, barrel, module) copied from a sibling job-board plugin. Acceptance: resolves through Nest DI.
- [x] T3 — Constants, types, pure helpers and process-wide state (cache, pacer, runtime hooks). Acceptance: helper suite green (AI-level bands, country/label normalisation, location matcher, compensation, URL guard, MCP/SSE/structured payloads, RSS, JSON-LD).
- [x] T4 — Service, MCP transport: plan from input and env, paged `search_jobs`, server-side and client-side filters, offset, dedupe, sequential `get_job` within the detail and time budgets, diagnostics. Acceptance: service suite green.
- [x] T5 — Service, feed transport and automatic fallback. Acceptance: feed mapping, listing-page JSON-LD, feed-only filters, `bad_input` rows, fallback with `partial`.
- [x] T6 — Robots guard and pacing. Acceptance: no request to `/api/`, `/feeds/`, `/go/`, `/md/` or with a query string on either transport; ≥ 1.1 s between requests, including two concurrent scrapes.
- [x] T7 — Mutation controls. Acceptance: removing the pacer, the detail cap, the `UK` → `GB` rule, or `/api/` from the disallow list each turns tests red (14 and 3 failures respectively in the run of 2026-09-25).
- [x] T8 — Live e2e (two host requests). Acceptance: non-empty results with `jobsbylevel-` ids, canonical links, levels in 1-4, remote search all remote.
- [x] T9 — (integrator) Register `Site.JOBSBYLEVEL`, the plugin module, the path alias, the jest mapper and the manifest entry; switch `JOBSBYLEVEL_SITE` to `Site.JOBSBYLEVEL`.
- [x] T10 — (integrator) Declare `aiLevel?: number | null` on `JobPostDto`; GraphQL field as a follow-up.
- [ ] T11 — (follow-up) When `@SourcePlugin` gains a crawl manifest, declare `maxConcurrentPerHost: 1, minIntervalMs: 1100` and retire the local pacer.

Integration 2026-09-25: registered as `Site.JOBSBYLEVEL` / `JobsByLevelModule`; `aiLevel?: number | null` declared on `JobPostDto` (GraphQL field still a follow-up); `docs/index.md` / `docs/log.md` rows added.
