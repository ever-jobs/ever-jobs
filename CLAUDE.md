# CLAUDE.md — Operating Notes for Claude Code

> Claude-specific addendum. **Read [`AGENTS.md`](./AGENTS.md) first** — it contains the
> authoritative rules for every coding agent (including Claude). This file only adds
> Claude-Code-specific operating guidance.

---

## 1. Operating Mode

This repository is driven by an **hourly scheduled task** invoked under the name
`ever-jobs` from `~/.claude/scheduled-tasks/ever-jobs/SKILL.md`. Each run is an
**autonomous, non-interactive** session:

- The user is **not present**. Do not ask clarifying questions.
- Use `docs/questions.md` to record ambiguities and continue with a defensible default.
- Always inspect previous progress (`docs/log.md`) before starting new work.
- Always commit and push at the end of a run when tests are green.

---

## 2. Per-Run Checklist

1. Read `docs/log.md` (top entries) to see what last run accomplished.
2. Update / health-check docs (`docs/index.md`, `docs/log.md`, `docs/questions.md`).
3. Pick the **next pending task** from `.specify/specs/*/tasks.md` (lowest unchecked).
4. If a task is too large, decompose it further before starting.
5. Implement, write/extend tests, run the relevant test suite.
6. Update `docs/log.md` with what you did, then commit + push.

---

## 3. Tooling Conventions

- Prefer **dedicated tools** (Read/Edit/Write/Glob/Grep) over Bash for file ops.
- Use **Bash** only for: git, npm, jest, docker, gh, fs listings.
- **TypeScript only** for any production source. Scripts/tooling under `scripts/`
  may be `.ts` (run via `ts-node`) — never `.js` or `.py`.
- Spawn **Agent (Explore)** for codebase questions that span >3 queries.

---

## 4. Plugin Authoring (TL;DR)

```bash
# scaffold
packages/plugins/<plugin-id>/
  package.json
  tsconfig.json
  src/{index.ts,<plugin>.module.ts,<plugin>.service.ts}
  __tests__/<plugin>.service.spec.ts
```

Register in **four** files for **source plugins**:

1. `packages/models/src/enums/site.enum.ts` — `Site.<KEY> = '<plugin-id>'`
2. `packages/plugins/index.ts` — append to `ALL_SOURCE_MODULES`
3. `tsconfig.base.json` — path alias under `compilerOptions.paths`
4. `jest.config.js` — matching `moduleNameMapper` entry

For **feature plugins** (dedup, merge resolver, persistence, AI, etc.) only
steps 3 and 4 apply — they bind under a dedicated DI token, not `Site`.

Then add a spec under `.specify/specs/<NNN>-source-<plugin-id>/` (spec.md, plan.md, tasks.md).

---

## 5. Forbidden in this repo

| ❌ Don't                                | ✅ Do                                       |
| -------------------------------------- | ------------------------------------------ |
| Add `.js` / `.cjs` / `.mjs` runtime    | TypeScript everywhere                      |
| Hardcode source list in core modules   | Discover via `PluginRegistry`              |
| Reach across plugins (`import` peer)   | Talk through interfaces in `@ever-jobs/models` |
| Skip tests because "it's small"        | At least one happy-path unit test          |
| Delete a doc to "clean up"             | Move it under `docs/_archive/` if outdated |
| `console.log` in production code       | Use `Logger` (`@nestjs/common`)            |
| Block on a question                    | Add to `docs/questions.md` + default       |

---

## 6. House Style

- File names: `kebab-case.ts`. Class names: `PascalCase`. Methods: `camelCase`.
- Imports: external → `@ever-jobs/*` → relative.
- Prefer `async/await` over raw `.then`.
- Always `Promise.allSettled` for fan-out; never `.all` (a single failure must not nuke the batch).
  *Since Spec 1690:* `allSettled` isolates failures but does not limit load on a host — the
  crawl-policy per-host limiter in `HttpClient` does. Do not add sleeps or retry loops for
  politeness; declare site needs in `@SourcePlugin({ crawl })`, fetch detail pages of
  fragile sites sequentially (`for … await`), and never set a browser User-Agent (by
  default a declared UA is only sent with a `userAgentMode: 'plugin'` opt-in and a
  `userAgentReason`). See `docs/CRAWL_POLICY.md` §19.

---

_Last revised: 2026-09-25 (Spec 1690: crawl-policy note in §6 House Style)_
