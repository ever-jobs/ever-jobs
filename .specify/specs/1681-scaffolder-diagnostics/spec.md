# Spec: 1681 — Stop the generators minting the swallowed-error shape

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1681                                       |
| Slug           | scaffolder-diagnostics                     |
| Status         | done                                       |
| Owner          | agent                                      |
| Created        | 2026-08-19                                 |
| Last updated   | 2026-08-19                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5082, 1679, 1680                           |

## 1. Problem Statement

Spec 1680 settled the diagnostics semantics. This is PR 2 of 5: fix the **generators**, so the
codemods that follow are not racing a machine that keeps re-creating the defect.

Six scaffolders produce the company-source catalogue, with **no shared template module** — each
carries its own copy of the emitted code.

### 1.1 The greenhouse scaffolder emitted the canonical swallow

`scripts/scaffold-company-source.ts` emitted, verbatim, the shape found in **822** services:

```ts
    } catch (err: any) {
      this.logger.error(`… scrape failed: ${err.message}`);
    }

    return { jobs };
```

It also emitted a bare object literal rather than a `JobResponseDto`. That type-checks — both DTO
members are public and `diagnostics` is optional, so structural typing accepts it — which is
precisely why 822 files drifted without the compiler noticing.

### 1.2 The five delegating scaffolders reported a registry miss as an empty board

`scaffold-{ashby,lever,recruitee,smartrecruiters,workable}-company-source.ts` produced the **699**
delegating plugins. A delegating plugin has exactly one independent failure path — it cannot resolve
its backend from the registry — and it emitted `return new JobResponseDto([]);` for it. Upstream
that is indistinguishable from a board that genuinely had no postings, though it is a wiring fault
where no request was ever made. Spec 1680 added `not_registered` for exactly this.

### 1.3 Nothing tested five of the six

Only `scaffold-company-source.ts` had a spec, and it asserted URLs and class names — **not** the
catch block, the logger text, or the return shape. The other five had **no tests at all**. So the
template change breaks nothing, and would also have been caught by nothing.

## 2. Goals

- No generator emits `return { jobs };` or a bare empty registry-miss result again.
- Every scaffolder's emitted contract is pinned by a test.
- A generated plugin proves itself end to end: scaffold → wire → its own tests pass.

## 3. Non-Goals

- The 822 existing canonical-swallow services (PR 4), the 699 delegating services (PR 3), and the
  268-file tail (PR 5).
- `scripts/wire-company-source.ts`, which touches only `site.enum.ts`, `packages/plugins/index.ts`,
  `tsconfig.base.json` and `jest.config.js`, and emits no error handling.

## 4. Design

### 4.1 Greenhouse scaffolder

Emits `classifyScrapeError` in the models import, returns the diagnostic from the catch, and
returns a real `JobResponseDto` on the success path:

```ts
    } catch (err: any) {
      this.logger.error(`… scrape failed: ${err.message}`);
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
```

`jobs` is passed, not `[]`. The catch sits outside the accumulation loop, so a board that parsed 30
postings before failing still returns those 30 — preserving that is a non-regression requirement,
not an improvement.

### 4.2 Delegating scaffolders

All five emit `ScrapeDiagnostics` in the import and report the registry miss as
`new ScrapeDiagnostics('not_registered', '<Backend> source plugin is not registered')`.

### 4.3 The generated test now asserts the reason

The emitted failure test asserted `expect(result.jobs).toEqual([])`, which stays true whatever the
plugin reports — it passed before this change and would pass after a botched one. It now also
asserts `expect(result.diagnostics?.reason).toBe('fetch_error')`, matching the 500 its own mock
throws.

### 4.4 Tests for the generators

`scaffoldOne` is exported from the five delegating scaffolders (it was module-private, which is why
they were untestable), and one parameterised spec covers all five rather than five near-identical
files — a table makes drift between backends obvious.

## 5. Acceptance

- No scaffolder emits `return { jobs };`.
- Each delegating scaffolder emits its own `not_registered` message.
- Generated plugin passes its own tests after wiring.

## 6. Risks

- Emitted comments must contain **no backticks**: the templates are TypeScript template literals, so
  a backtick terminates the string. Hit twice while writing this, each time caught by the compiler
  via the scaffolder's own suite. The spec now asserts the emitted text, which is the cheaper guard.
- Newly generated plugins differ from the 1,521 already in the tree until PRs 3–4 land. That
  divergence is the point, and is temporary.
