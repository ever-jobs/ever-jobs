# AGENTS.md — Ever Jobs (Authoritative Rules for AI Agents)

> This file is the single source of truth for agents (Claude Code, OpenAI Codex, Cursor, etc.)
> working on the **Ever Jobs** monorepo. Cross-check every spec, doc, and code file you create
> or edit against the rules in this document.

---

## 0. North Star

Ever Jobs is a **modular, plugin-driven, TypeScript-only NestJS monorepo** for multi-source
job scraping & analysis. It must be:

1. **Modular** — plugins/adaptors for almost every feature (sources, ATS, AI, exports, UI).
2. **Replaceable** — every plugin can be enabled / disabled / swapped at runtime.
3. **Performant** — extreme runtime performance: streaming, pooling, caching, parallelism.
4. **Documented for AI** — `docs/` and `.specify/` answer every reasonable agent question.

---

## 1. Source-of-Truth Documents

| File / Folder                | Role                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `AGENTS.md` (this file)      | Authoritative rules for all coding agents.                          |
| `CLAUDE.md`                  | Claude-specific operating notes (loads `AGENTS.md` by reference).   |
| `docs/`                      | All long-form specs, plans, ADRs, runbooks, glossaries.             |
| `docs/index.md`              | Full index of every doc — keep in sync.                             |
| `docs/log.md`                | Append-only changelog of doc/spec changes (newest at top).          |
| `docs/questions.md`          | Open questions; agents add options & a default; humans review.      |
| `.specify/`                  | GitHub Spec Kit directory: `memory/`, `specs/`, `templates/`.       |
| `tool_manifest.json`         | Machine-readable description of API endpoints & sources.            |
| `README.md`                  | User-facing overview; do not duplicate spec content here.           |

---

## 2. Hard Rules (do not violate)

1. **TypeScript only.** No JavaScript runtime sources, no Python, no shell-pipeline logic
   beyond build/devops scripts. Tests, CLI commands, plugins → all `.ts`.
2. **Spec-Kit-first.** No coding without a written spec under `docs/specs/` (or `.specify/specs/`)
   that includes: problem statement, scope, non-goals, contracts, test plan.
3. **Plugin-by-default.** New features = new package under `packages/plugin/` or
   `packages/plugins/<plugin-id>/`. The core (`apps/api`, `apps/cli`) only orchestrates.
4. **Replaceable contracts.** Every plugin implements an interface from `@ever-jobs/models`
   or `@ever-jobs/plugin`; no plugin imports another plugin directly.
5. **Latest deps.** Always prefer the latest stable versions of dependencies; record
   non-trivial bumps in `docs/log.md`.
6. **Reuse existing libs** when popular & well-maintained (Cheerio, Playwright, Axios,
   Cache Manager, BullMQ, Zod, etc.) — do not reinvent.
7. **Tests required.** Unit tests live next to plugin source (self-contained packages);
   e2e tests collocate under `apps/api/__tests__/e2e/` or `apps/<app>/__tests__/e2e/`.
8. **Performance.** Default to: streaming responses, async iterators, connection pools,
   bounded concurrency (`p-limit`/`Promise.allSettled`), Redis cache, structured indexes.
9. **No deletion.** Do not delete user-authored files; *move* or *improve* in place.
   Mark deprecated code with `@deprecated` and a removal target.
10. **Security.** All HTTP I/O goes through `@ever-jobs/common` HTTP client (UA rotation,
    timeouts, retries, redacted logging). Never log secrets.
11. **Be exhaustive.** Don't summarize — write full specs, full task lists, full test plans.

---

## 3. Repository Layout (canonical)

```
ever-jobs/
├── AGENTS.md                # this file
├── CLAUDE.md                # Claude operating notes
├── README.md
├── package.json             # npm workspaces (apps/* + packages/*)
├── tsconfig.base.json       # path aliases for every package
├── nx.json                  # nx task graph
├── .specify/                # GitHub Spec Kit
│   ├── memory/              #   constitution, principles
│   ├── specs/               #   per-feature specs (ID-prefixed)
│   └── templates/           #   spec/plan/tasks templates
├── docs/
│   ├── index.md             # auto-maintained doc index
│   ├── log.md               # append-only changelog of doc edits
│   ├── questions.md         # open questions for the human owner
│   ├── adr/                 # architectural decision records
│   ├── plans/               # implementation plans (one per feature)
│   ├── specs/               # functional specs (mirror or alias of .specify/specs/)
│   ├── runbooks/            # operational guides
│   └── *.md                 # legacy / reference docs (keep, never delete)
├── apps/
│   ├── api/                 # NestJS HTTP/GraphQL/MCP server
│   ├── cli/                 # nest-commander based CLI
│   ├── mcp/                 # standalone MCP server (AI-agent integration)
│   └── web/                 # (future) frontend dashboard plugin host
├── packages/
│   ├── plugin/              # core plugin infra (registry, decorator, discovery)
│   ├── plugins/             # all source/feature plugins (1 dir per plugin)
│   │   ├── source-*/        # search-source plugins
│   │   ├── source-ats-*/    # ATS plugins
│   │   ├── source-company-*# company-page plugins
│   │   ├── ai-*/            # AI/LLM enrichment plugins (future)
│   │   ├── export-*/        # exporters (CSV, JSON, Parquet, …)
│   │   ├── store-*/         # persistence adaptors (Redis, Postgres, S3)
│   │   └── ui-*/            # frontend-feature plugins (future)
│   ├── common/              # shared HTTP client + utils
│   ├── models/              # DTOs, enums, interfaces (Zod-validated)
│   └── analytics/           # job-data analytics core
└── scripts/                 # build/devops scripts (TS or Bash; never required at runtime)
```

---

## 4. Spec Kit Workflow (mandatory before code)

Every change follows the **Specify → Plan → Tasks → Implement** loop popularised by GitHub
Spec Kit. The four artefacts live in `.specify/specs/<NNN>-<slug>/`:

| File           | Author    | Purpose                                                    |
| -------------- | --------- | ---------------------------------------------------------- |
| `spec.md`      | agent     | Functional spec: what, why, scope, non-goals, contracts.   |
| `plan.md`      | agent     | Implementation plan: phases, packages touched, risks.      |
| `tasks.md`     | agent     | Ordered task list (each ≤ 1 day, with acceptance criteria).|
| `notes.md`     | optional  | Free-form research, links, dead-ends.                      |

A doc-mirror in `docs/specs/<NNN>-<slug>.md` may summarize the spec for human readers.

**Rule:** if a feature lacks at least `spec.md` + `plan.md` + `tasks.md`, do not write code for it.

---

## 5. Plugin Contract (must implement)

```ts
// packages/models/src/interfaces/scraper.interface.ts
export interface IScraper {
  scrape(input: ScraperInputDto): Promise<JobResponseDto>;
}

// packages/plugin/src/interfaces/plugin-metadata.interface.ts
export interface IPluginMetadata {
  site: Site;             // unique enum value
  name: string;           // human-readable
  category: PluginCategory;
  isAts?: boolean;
  companyDomains?: string[]; // company domains this plugin serves
  description?: string;
}
```

**Company plugins:** callers may address a plugin by the company's domain
(`companyDomain`), which is otherwise resolved by deriving a token from the
domain (Spec 5069: strip `www.`, strip a trailing `.com`, dots → underscores).
If a new company plugin's `Site` token is **not** what that rule derives from the
company's domain — e.g. the plugin is named after an ATS board slug — declare the
domain so the plugin stays reachable (Spec 5086):

```ts
@SourcePlugin({
  site: Site.STOKE_SPACE,      // token: 'stokespacetechnologies'
  name: 'Stoke Space',
  category: 'company',
  companyDomains: ['stokespace.com'],
})
```

List every host the company answers on (acquisitions, rebrands, legacy domains).
Two plugins must never declare the same host; the first claim wins and the second
is logged and ignored.

A plugin package MUST contain:

```
packages/plugins/<plugin-id>/
├── package.json            # name "@ever-jobs/<plugin-id>", "main": "src/index.ts"
├── tsconfig.json           # extends ../../../tsconfig.base.json
├── src/
│   ├── index.ts            # barrel: re-export module + service
│   ├── <plugin>.module.ts  # NestJS @Module
│   └── <plugin>.service.ts # @Injectable + @SourcePlugin({ ... })
└── __tests__/              # unit tests for THIS plugin (jest)
```

Then register in **four** places for **source** plugins (failure to do so makes the
plugin invisible):

1. `packages/models/src/enums/site.enum.ts` — add the `Site.<KEY>` value.
2. `packages/plugins/index.ts` — append to `ALL_SOURCE_MODULES`.
3. `tsconfig.base.json` `paths` — `@ever-jobs/<plugin-id>: ["packages/plugins/<plugin-id>/src/index.ts"]`.
4. `jest.config.js` `moduleNameMapper` — mirror the path alias.

For **feature plugins** (e.g. `dedup-hybrid`, `merge-default`, `store-postgres`,
`ai-classifier`) only the **last two** apply — feature plugins bind under a
dedicated DI token (e.g. `DEDUP_ENGINE_TOKEN`) rather than the `Site` enum,
and they are imported by the consumer module directly, not via
`ALL_SOURCE_MODULES`.

---

## 6. Performance Mandates

- **Concurrency.** Use `p-limit` or `Promise.allSettled` w/ a configured limit per source.
- **Timeouts.** Every external call: connect 3 s, total 12 s, configurable per plugin.
- **Caching.** Default 5-min TTL; per-source override via `getCacheTTL()`. Redis when set,
  in-memory LRU otherwise.
- **Retry.** Exponential backoff w/ jitter; max 3 retries; circuit-break after 5 consecutive
  failures (per source).
- **Parsing.** Stream HTML through Cheerio when possible; reuse `Turndown` instance.
- **JSON.** Use `JSON.parse` only on validated payloads; prefer `Zod.parse` for shape.
- **Memory.** Bound result-set size per source (`maxResults`), enforce it in the plugin.

---

## 7. Test Strategy

| Layer        | Location                                       | Tooling   |
| ------------ | ---------------------------------------------- | --------- |
| Unit         | `packages/<pkg>/__tests__/` *(self-contained)* | Jest      |
| Integration  | `apps/api/__tests__/integration/`              | Jest      |
| E2E          | `apps/api/__tests__/e2e/` (collocated)         | Jest+Supertest |
| Smoke        | `apps/api/__tests__/health/`                   | Jest      |
| Lint         | `npm run lint`                                 | ESLint    |
| Type check   | `npm run build` (tsc via nx)                   | tsc       |

CI gating order: lint → typecheck → unit → integration → e2e → smoke.

---

## 8. Commit & PR Conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- Scope is the package or app: `feat(plugin/source-foo): add Foo scraper`.
- Each commit must leave the repo in a green-CI state.
- After every successful run, *commit and push* (per scheduled-task instructions).
- Never `git push --force` to `develop` or `main`.

---

## 9. The "questions.md" Loop

Whenever you encounter an ambiguity:

1. Add it to `docs/questions.md` with **Options A/B/C**.
2. Pick the most defensible default and mark it **`(default — proceeding)`**.
3. Continue with the default; the human owner will revise later.

This keeps the schedule unblocked while preserving an audit trail.

---

## 10. Cross-Check Before Committing

Before opening a commit, verify:

- [ ] `AGENTS.md` rules satisfied (this file).
- [ ] Spec exists (`.specify/specs/<id>/spec.md`).
- [ ] `docs/index.md` updated.
- [ ] `docs/log.md` appended (newest entry at top).
- [ ] `docs/questions.md` reflects any new ambiguities.
- [ ] Tests added/updated and passing.
- [ ] No new `console.log` outside dev/scripts.
- [ ] No JavaScript or non-TS source added.
- [ ] Plugin registered in *all four* places (enum, index, tsconfig, jest).

---

_Last revised: 2026-04-26 (scheduled run #6)_
