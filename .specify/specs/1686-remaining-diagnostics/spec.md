# Spec: 1686 — the last 33, finished by reading them

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1686                                       |
| Slug           | remaining-diagnostics                      |
| Status         | done                                        |
| Owner          | agent                                      |
| Created        | 2026-08-20                                 |
| Last updated   | 2026-08-20                                 |
| Supersedes     | (none)                                     |
| Related specs  | 1680, 1682, 1683, 1684, 1685               |

## 1. Problem Statement

Spec 1685 closed the last cluster a codemod could safely handle and left **33 services** described
as needing "hand review". That phrasing was wrong in a way worth correcting: it reads as *someone
else's* job, when it only ever meant "needs per-file judgement instead of a pattern".

These are the services whose `scrape()` catch has **no return** — it logs and falls through to a
later `return new JobResponseDto(...)` — so the reason has to be carried in a variable. Spec 1685's
automatic attempt guessed the declaration point from "the first top-level try" and `tsc` rejected
half its output with `Cannot find name 'diagnostics'`. The guess is the part that cannot be
automated; everything else can.

## 2. Goal

Every source service either reports a categorized reason or deliberately delegates to the fan-out.
No remainder.

## 3. Design

### 3.1 Judgement supplied, mechanics automated

`scripts/codemod/apply-fallthrough-diagnostics.ts` takes a per-file plan — the exact line to declare
after, the exact accumulator expression, and which catch carries the reason — all read from the file.
It then does the parts that hand-editing 33 files gets wrong: brace-matching the catch, rewriting the
return, adding imports, preserving CRLF/BOM, and verifying the output parses *and* that the
assignment landed inside an `err` catch.

28 went through that path. Five were edited directly because their shape is genuinely singular.

### 3.2 The five singular ones

| Service | Why it needed reading |
|---|---|
| `source-ats-avature` | Accumulator is `collected: AvatureParsedJob[]`, mapped to `jobs` only at the return; the catch is inside the pagination loop and `break`s, discarding the reason. |
| `source-ats-loxo` | Two surfaces (public, then authenticated). Whichever was tried **last** owns the reason — an earlier failure is a routing signal, not the outcome. |
| `source-ats-personio` | Two domains (`.de` then `.com`) plus an XML parse stage; three distinct failure points, each meaning something different. |
| `source-builtin`, `source-dice` | Multi-strategy: API → HTML → Playwright. The API failure is a routing signal, so it is reported **only if every fallback also comes back empty** (`length ? undefined : apiFailure`). |
| `source-company-tiktok` | Nested try/finally, and returned a bare `{ jobs }` object rather than a DTO. The last of the canonical bucket. |

Several guard clauses were upgraded while reading them — a missing `companySlug`, an uninitialised
Exa client, neither Personio domain answering — from a bare empty result to `bad_input`/`empty` with
a detail. Those are inputs and configuration failing, not boards with no postings.

### 3.3 The five with no catch stay untouched

`source-ats-joincom`, `source-careerbuilder`, `source-monster`, `source-simplyhired`, `source-tesla`
let the error propagate, and `JobsService`'s `rejected` branch already calls `classifyScrapeError`.
Changing them would be a regression.

## 4. Acceptance

- Census: **1,827 of 1,832** services report a reason, **5** correctly delegate, **0** unmigrated.
- 33 files changed; `tsc --noEmit` clean; no EOL churn.
- Targeted suites green.

## 5. Risks

- The multi-strategy plugins (`builtin`, `dice`) now report the *primary* surface's failure when all
  fallbacks come back empty. That is deliberate — it is the most useful reason available — but it
  means a Playwright fallback returning nothing is attributed to the API error that preceded it.
