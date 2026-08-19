# Spec: 1685 — the tail cluster returning the accumulator without a reason

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1685                                       |
| Slug           | tail-accumulator-diagnostics               |
| Status         | done                                        |
| Owner          | agent                                      |
| Created        | 2026-08-19                                 |
| Last updated   | 2026-08-19                                 |
| Supersedes     | (none)                                     |
| Related specs  | 1680, 1682, 1683, 1684                     |

## 1. Problem Statement

After Specs 1682-1684, 164 services still reported `empty` for real failures. Clustering them by
what the last catch of the brace-matched `scrape()` body actually does:

| Cluster | Count | Shape |
|---|---:|---|
| **D** | **126** | catch returns the accumulator, no reason ← this spec |
| B | 30 | catch falls through to a later return |
| A | 5 | no catch at all — the throw escapes to the fan-out |
| C/F | 3 | ambiguous |

**Cluster A was never broken.** Those five let the error propagate, and `JobsService`'s `rejected`
branch already calls `classifyScrapeError`. They are the one population where the fan-out's error
path works as designed, and they need no change.

**Cluster D is the shape `source-ats-smartrecruiters` had** before Spec 1680 fixed it by hand:

```ts
      return new JobResponseDto(jobPosts); // partial results
```

Partial results returned with **no signal at all**, so a page-2 failure is indistinguishable from a
complete board. With Spec 1680's `partial` inference, a non-zero count plus a diagnostic now reports
`partial` rather than `ok`.

## 2. Goals

- Close cluster D — the largest remaining mechanical cluster.
- Say honestly what is left, and why it is left.

## 3. Non-Goals

- **Cluster B (30).** Attempted and deliberately abandoned; see §5.
- Clusters C/F (3) — ambiguous, hand review.
- Cluster A (5) — already correct.

## 4. Design

Same validating-transform harness as Specs 1682-1684:

```ts
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
```

Two anchor details, both learned from a failed first attempt:

- **Trailing comments.** The common shape is `return new JobResponseDto(jobPosts); // partial
  results`. An anchor requiring `;$` matched only 2 of 126.
- **Call expressions.** 47 files return `jobPosts.slice(0, resultsWanted)`. The argument is captured
  whole, then verified to have balanced parens and no top-level comma, so an existing second
  argument can never be mangled.

Scope is proved by brace matching and re-derived from the output, per Spec 1684.

## 5. Cluster B: attempted, then abandoned

Cluster B's catch has no return, so the reason must be carried to the terminal return — a
**three-point edit**: declare `let diagnostics`, assign in the catch, pass at the return.

It was built, and its own gate rejected 31 of the 37 candidates because they contain more than one
`err` catch (a per-item catch inside the loop *and* the outer one), making it ambiguous which should
carry the reason. Of the 6 it accepted, **`tsc` rejected 3** with `Cannot find name 'diagnostics'` —
the declaration did not land in the right scope relative to the return.

A novel transform that is wrong half the time, for a yield of 6 files, is not worth shipping. It was
reverted in full (`tsc` back to 0) and the tool deleted rather than left in the tree to be re-run by
someone who trusts it. These 30 want hand edits, not a codemod.

## 6. Acceptance

- 126 services transformed, uniformly `+5/-1`, zero outliers; `tsc --noEmit` clean.
- An independent re-check confirms every inserted call's nearest enclosing catch binds `err`.
- No file carries a `let diagnostics` declaration introduced by the abandoned pass.

## 7. What remains

**38 services**, enumerated rather than rounded away: 30 in cluster B (hand edits), 5 in cluster A
(already correct — no change wanted), and 3 ambiguous. Final state of the whole sequence:
**1,801 of 1,839 services report a real reason, 5 correct by design, 33 documented for hand review.**
