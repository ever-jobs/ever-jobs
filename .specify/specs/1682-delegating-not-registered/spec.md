# Spec: 1682 — 699 delegating plugins report a registry miss as `not_registered`

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1682                                       |
| Slug           | delegating-not-registered                  |
| Status         | done                                        |
| Owner          | agent                                      |
| Created        | 2026-08-19                                 |
| Last updated   | 2026-08-19                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5082, 1679, 1680, 1681                     |

## 1. Problem Statement

PR 3 of 5. The **699** `source-company-*` delegating plugins carry no scraping logic: they resolve a
backend ATS scraper from the registry and return its result verbatim. Spec 1680 fixed the two
backends that reported nothing, so these wrappers now inherit a real reason for every *scrape*
failure.

What remained is their one **independent** failure path — the registry miss:

```ts
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error('SmartRecruiters source plugin is not registered; cannot scrape AbbVie');
      return new JobResponseDto([]);
    }
```

Upstream that is indistinguishable from a board with no postings, though it is a wiring fault where
**no request was ever made**. Spec 1680 added `not_registered` for exactly this; Spec 1681 taught the
generators to emit it. This migrates the plugins that already exist.

The specs were no better. Their generated registry-miss test asserted only
`expect(result.jobs).toHaveLength(0)` — true whatever the plugin reports, so it passed before this
change and would have passed after a botched one.

## 2. Goals

- Every delegating plugin distinguishes a wiring fault from an empty board.
- Every delegating spec actually pins that, rather than re-asserting an empty array.

## 3. Non-Goals

- The 822 canonical-swallow services (PR 4) and the 268-file tail (PR 5).
- Changing delegation behaviour: a plugin that *does* resolve its backend is untouched.

## 4. Design

Two validating codemods under `scripts/codemod/`, run under `ts-node`.

### 4.1 Why a validating transform, not a regex sweep

Silently mis-transforming a subset of 699 files is far worse than transforming none. Every file
passes a **precondition** gate before editing and a **postcondition** gate before writing; anything
not understood is skipped and reported, never partially edited. The run exits non-zero unless the
transformed count equals `--expect` exactly, and `--expect` is mandatory — a codemod that cannot
fail loudly is not safe to run at this scale.

An AST printer was rejected deliberately: `ts-morph` reprints the whole file, normalising formatting
across 699 files and burying two real edits in thousands of cosmetic lines. The TypeScript parser is
still used, as a **verifier** (`createSourceFile` + `parseDiagnostics`), not a printer — AST-grade
safety with a reviewable diff.

### 4.2 Line endings are load-bearing

The tree is mixed: 293 CRLF files and 154 with a BOM, and no `.gitattributes`. Git Bash strips CR in
text mode, which is how that went unnoticed. Files are read as **bytes**, normalised in memory only,
and written back with their original EOL and BOM restored.

### 4.3 The backend label is derived, not hard-coded

Taken from the logger line above the anchor (`'<Label> source plugin is not registered'`), so a new
backend needs no codemod change. It also sidesteps the seven company names containing an escaped
apostrophe (`Raising Cane\'s`), since the capture ends before the company name.

The spec pass reads its label from the sibling **service**, already migrated by pass 1 — the two
passes therefore cannot disagree.

## 5. Acceptance

- 699 services transformed, uniformly `+7/-1`; 699 specs, uniformly `+4/0`; zero outliers.
- `git diff --numstat` identical to `git diff --ignore-all-space --numstat` (no EOL churn).
- Backend split matches the census: Ashby 219, SmartRecruiters 217, Lever 180, Recruitee 83.
- A sabotage run (flipping `not_registered` to `empty` in one service) **fails** its spec.

## 6. Risks

- 1,398 files exceeds Greptile's 100-file review limit, so this PR gets **no bot review**. That is
  the argument for the mechanical gates above carrying the weight instead, and for the diff being
  two shapes and nothing else.
- The codemods are retained under `scripts/codemod/` rather than deleted: they document exactly what
  was done, and PRs 4–5 reuse the harness.
