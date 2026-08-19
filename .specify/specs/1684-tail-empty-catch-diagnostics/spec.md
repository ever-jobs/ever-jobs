# Spec: 1684 — the tail cluster whose catch returns a bare empty result

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1684                                       |
| Slug           | tail-empty-catch-diagnostics               |
| Status         | done                                        |
| Owner          | agent                                      |
| Created        | 2026-08-19                                 |
| Last updated   | 2026-08-19                                 |
| Supersedes     | (none)                                     |
| Related specs  | 1680, 1681, 1682, 1683                     |

## 1. Problem Statement

PR 5 of 5. Specs 1682 and 1683 migrated the delegating (699) and canonical-swallow (822) buckets.
**264** services remain, and they are not one shape.

The earlier scoping called this "a 268-file tail needing ~128 accumulator hoists". Both halves of
that were wrong, and the correction matters:

- **The classifier was wrong.** Clustering on "the last catch in the file" conflates the outer
  `scrape()` catch with per-item catches inside loops and helper-method catches. Brace-matching the
  actual `scrape()` body gives a different picture: 68 clusters, of which the large ones are mostly
  *inner* catches that are none of this spec's business.
- **The hoisting estimate overstated the work.** Hoisting is only needed to *preserve partial
  results*, which is a separate improvement. For the goal here — reporting a reason — the largest
  cluster needs no restructuring at all.

That cluster: `scrape()` has exactly one catch, binding `err`, whose own block returns
`new JobResponseDto([])`. **100 services.** They become:

```ts
      return new JobResponseDto([], classifyScrapeError(err));
```

## 2. Goals

- Close the largest remaining cluster with a transform that cannot silently mis-fire.
- Leave the genuinely ambiguous remainder documented rather than guessed at.

## 3. Non-Goals

- **Hoisting accumulators.** Many of these declare the accumulator inside the `try`, so it is out of
  scope in the catch — which is *why* they return `[]`. Recovering their partial results needs
  per-file review and is a separate change.
- The remaining 164: 162 with no such return in `scrape()` (their catches sit in loops or helpers,
  or they rethrow), and 2 with more than one bare-empty return, which are ambiguous.

## 4. Design

Same validating-transform harness as Specs 1682/1683, with one hard-won difference.

### 4.1 Brace matching, not a spanning regex

The first version anchored with a regex running from `catch (…) {` to the return. That **silently
crossed the catch's closing brace** and rewrote a *method-level* return in `source-ats-loxo`, where
`err` is out of scope:

```ts
      } catch (err: any) {
        this.logger.error(`Loxo authenticated API also failed …`);
      }
    }

    return new JobResponseDto([], classifyScrapeError(err));   // ← err not in scope
```

It parsed cleanly, so `parseDiagnostics` passed; the count and line-delta gates passed; and the
catch-variable guard allowed enough slack to span the brace. **Only `tsc` caught it.**

The transform now brace-matches each catch block and requires the return to lie strictly inside it,
and a postcondition **re-derives that from the output** rather than trusting the input match. That
postcondition is exactly what the first version lacked.

### 4.2 Catch variable

Only catches binding `err` are eligible, since the call is `classifyScrapeError(err)`. Catches
binding `error`/`e` are left alone rather than renaming someone's variable.

## 5. Acceptance

- 100 services transformed, uniformly `+2/-1`, zero outliers; `tsc --noEmit` clean.
- `source-ats-loxo` is **not** transformed.
- An independent re-check confirms every inserted call's nearest enclosing catch binds `err`.

## 6. Risks

- The 164 untouched services still report `empty` for real failures. They are enumerated here rather
  than silently dropped, and the two `MULTI_ANCHOR` files are flagged for hand review.
- These plugins discard partial results on failure (they return `[]`). This spec does not change
  that; it only makes the failure legible.
