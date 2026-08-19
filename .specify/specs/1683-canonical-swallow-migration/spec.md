# Spec: 1683 — 822 services stop swallowing their errors

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1683                                       |
| Slug           | canonical-swallow-migration                |
| Status         | done                                        |
| Owner          | agent                                      |
| Created        | 2026-08-19                                 |
| Last updated   | 2026-08-19                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5082, 1679, 1680, 1681, 1682               |

## 1. Problem Statement

PR 4 of 5, and the one this whole sequence exists for. **822** plugin services end `scrape()` with:

```ts
    } catch (err: any) {
      this.logger.error(`… scrape failed: ${err.message}`);
    }

    return { jobs };
```

The error is logged and then discarded. A 403, a DNS failure, a Cloudflare challenge, a dead slug
and a genuinely empty board all arrive at the API as the same thing — `reason: 'empty'` — because
`JobsService` can only infer `empty` when a plugin returns zero jobs with no diagnostics.

That is the root cause behind the ≥98% `ok`/`empty` noise measured in Spec 1679, and the reason the
per-source diagnostics were far less informative than they looked.

`return { jobs }` also type-checks against `Promise<JobResponseDto>` — both DTO members are public
and `diagnostics` is optional, so structural typing accepts a bare object literal. That is exactly
why 822 files drifted without the compiler ever noticing.

Spec 1681 stopped the generators emitting this. This migrates the services that already exist.

## 2. Goals

- Every canonical-swallow service reports a categorized reason.
- Its spec actually verifies that, rather than re-asserting an empty array.

## 3. Non-Goals

- The 268-file tail (PR 5), whose catch shapes vary and need clustering.
- `source-company-tiktok`, the one canonical-bucket file whose nested try/finally fails the anchor;
  left for the tail so it gets a deliberate hand edit rather than a forced regex.
- Recovering partial results where the accumulator is declared *inside* the `try`. That is a
  different (and rarer) defect; see Spec 1680 §3.

## 4. Design

Two validating transforms under `scripts/codemod/`, same harness as Spec 1682.

### 4.1 The shape

```ts
    } catch (err: any) {
      this.logger.error(`… scrape failed: ${err.message}`);
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
```

**`jobs` is passed, never `[]`.** The accumulator is declared before the `try`, filled inside it, and
the catch sits outside the loop — so a board that parsed 30 postings before failing returns those 30
*today*. Emitting `JobResponseDto([], …)` would bundle silent data loss into a diagnostics fix.
Precondition **P4** enforces `decl < try < catch` and the presence of `jobs.push(` per file, rather
than trusting the census: all 822 passed independently.

**The plugin keeps resolving.** `CircuitBreakerService` counts failures only on rejection, so this
cannot trip a breaker. Making 822 plugins throw would trip breakers on any merely-403ing source
within five fan-outs and overflow `MAX_SITES = 250` against 1,832 registered sites.

### 4.2 Every file in this population is CRLF

The probe found **822/822 CRLF**, 16 with a BOM. Byte-level handling is therefore not a precaution
here, it is the only thing that works: read bytes, normalise in memory only, restore EOL and BOM on
write.

### 4.3 The spec pass is gated on its sibling service

809 specs match the failure-test anchor but only **806** belong to services in the canonical bucket;
the surplus are tail-bucket plugins sharing the generated shape. Asserting `fetch_error` against a
service that still swallows would produce a red test that looks like a real regression, so the
codemod migrates a spec only when its sibling service carries the new catch. 52 were skipped as
`SERVICE_NOT_MIGRATED`.

## 5. Acceptance

- 822 services uniformly `+7/-1`; 806 specs uniformly `+3/0`; zero outliers.
- `git diff --numstat` identical to `--ignore-all-space --numstat` (no EOL churn).
- `tsc --noEmit` clean.
- Sabotage: reverting one migrated service to the swallow makes its spec fail
  (`Expected: "fetch_error", Received: undefined`).

## 6. Risks

- 1,628 files exceeds Greptile's 100-file limit, so **no bot review**. The mechanical gates and the
  two-shape diff carry the weight instead.
- 16 canonical services have no spec at all (`stripe`, `openai`, `amazon`, … plus `comeet` and
  `pinpoint`); they are covered only by `apps/api/src/jobs/__tests__/jobs.service.spec.ts`.
- Sources that were silently failing will now report `blocked` / `bad_input` / `fetch_error` instead
  of `empty`. Dashboards will show a step change — that is the defect being fixed, not a regression,
  but it is visible.
