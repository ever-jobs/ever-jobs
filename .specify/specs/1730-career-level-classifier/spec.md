# Spec: 1730 — Career-Level Classifier (intern / new-grad / seniority)

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 1730                               |
| Slug           | career-level-classifier            |
| Status         | done                               |
| Owner          | agent                              |
| Created        | 2026-09-24                         |
| Last updated   | 2026-09-25                         |
| Supersedes     | (none)                             |
| Related specs  | 003, 740, 5024                     |

## 1. Problem Statement

Consumers of `POST /api/jobs/search` (first among them the Hust job site, whose audience is
students and early-career engineers) need to know *what level* a posting is for: is it an
internship, a new-grad role, or a senior/staff/management position? Today the only level data
on a `JobPostDto` is whatever a few sources happen to provide:

- `jobType` carries `internship` for a handful of boards;
- `jobLevel` is LinkedIn-only free text ("Entry level", "Mid-Senior level");
- `experienceRange` is Naukri-only ("0-2 Yrs").

For the ~1,800 other plugins — most notably the 181 ATS adapters and the company-page plugins
that make up the bulk of every response — there is no level at all. The level is almost always
*in the title* ("Software Engineer Intern", "Engineer II", "Senior Director, Product"), but every
consumer would have to re-implement the same brittle keyword matching, and naive matching is
wrong in well-known ways: `intern` matches *Internal Audit Manager* and *International Sales*,
`staff` matches *Staff Nurse*, `senior` matches *Senior Living*, `associate` is entry-level in
*Associate Engineer* but director-level in *Associate Director*, and `VP` is an executive at a
tech company but a senior individual contributor at a bank.

## 2. Goals

- A deterministic, explainable classifier that assigns every job one of eleven career levels
  with a confidence and short human-readable reasons (contract C7).
- Precise rules: word-boundary matching plus negative guards for the known false friends.
  Target precision **≥ 0.95 on `internship` and `new_grad`** on a labelled evaluation fixture.
- Applied **once, server-side, after dedup**, so every output format (JSON, paginated JSON,
  CSV, NDJSON, GraphQL) carries it without per-format code.
- An optional request filter `careerLevels` and an operator kill-switch
  `EVER_JOBS_CLASSIFY_CAREER_LEVEL`.
- Cheap: no network, no LLM, bounded work per job.

## 3. Non-Goals

- Machine-learned or LLM-based classification (a future plugin can bind the same DI token).
- Mutating the source-provided `jobType` / `jobLevel` / `experienceRange` fields.
- Classifying occupation (engineer vs nurse) or inferring seniority from occupation alone —
  *Barista* or *Warehouse Associate* carry no explicit level and stay `unknown`.
- Persisting the level in the canonical store (the store persists `CanonicalJob` records built
  by the dedup engine; a later spec can add a column).
- Output-format work (CSV column layout, NDJSON framing) — owned by the output-format lane;
  this spec only guarantees the field is on every `JobPostDto` those formats serialise.
- CLI (`apps/cli`) output, which calls `JobsService.searchJobs` directly and bypasses the
  aggregator.

## 4. User / Caller Stories

> As the **Hust ingester**, I want every job to carry `careerLevel`, so that I can show an
> "Internships" / "New grad" filter without writing my own title parser.

> As an **API caller**, I want `careerLevels: ["internship","new_grad"]` in the search body, so
> that the server returns only early-career postings and I don't page through senior roles.

> As an **operator**, I want `EVER_JOBS_CLASSIFY_CAREER_LEVEL=false`, so that I can switch the
> enrichment off without a deploy of new code if it misbehaves.

> As a **reviewer of a misclassified job**, I want `reasons[]`, so that I can see which rule fired
> and fix the rule rather than guess.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `JobPostDto.careerLevel?: { level, confidence, reasons }` — `level` ∈ `internship \| new_grad \| entry \| mid \| senior \| staff \| principal \| manager \| director \| executive \| unknown`; `confidence` ∈ `high \| medium \| low`; `reasons` is a short `string[]` (≤ 5 entries). | must |
| FR-2  | Classification is deterministic and pure: same input → same verdict; no I/O, no clock, never throws. | must |
| FR-3  | Inputs: `title` (primary; first 300 characters, cut at a word boundary), `description` (the first 3,000 *visible* characters after stripping tags / entities / markdown, found by scanning raw windows of 4.5 KB, 16 KB and at most 64 KB; secondary), source `jobType`, `employmentType` and `jobLevel` (capped like the title: 300 characters at a word boundary), `experienceRange` (first 120 characters). Every scraped string is capped before analysis, so no single field can make one `classify` call expensive. | must |
| FR-4  | Title signals beat structured source fields, which beat description signals. A lower-priority signal that disagrees by ≥ 2 rungs lowers confidence one step; a structured field that agrees raises it one step. | must |
| FR-5  | `unknown` (confidence `low`) when no signal is found anywhere. | must |
| FR-6  | Applied in `JobsAggregator.aggregateRaw` after dedup (and on the no-dedup / no-engine paths), once per returned job, before the response is shaped — so JSON, pagination, CSV, NDJSON and GraphQL all see it. Not applied in the controller. | must |
| FR-7  | `EVER_JOBS_CLASSIFY_CAREER_LEVEL` (default `true`); `false` → `careerLevel` is absent from every job. | must |
| FR-8  | Optional `ScraperInputDto.careerLevels?: string[]`; unknown values are a 400 (class-validator `@IsIn`). When non-empty, only jobs whose level is in the set are returned. Applied after classification. The filter is honoured even when FR-7 disabled attachment (the level is computed transiently), and it fails closed: when it cannot be applied the request is a 503, never an unfiltered 200 — see Q-106. It is not part of the raw fan-out cache key. | must |
| FR-9  | GraphQL: `JobPostGql.careerLevel` (`CareerLevelGql { level, confidence, reasons }`) and `SearchJobsInput.careerLevels: [String!]` with the same validation. Every `SearchJobsInput` field carries a class-validator decorator, because the global `ValidationPipe` (`whitelist: true`) also runs on GraphQL `@Args` and strips undecorated fields. | should |
| FR-10 | Source `jobType` / `jobLevel` / `experienceRange` are never mutated. | must |
| FR-11 | A labelled fixture of ≥ 250 titles (+ description / structured-field cases) is evaluated in CI with per-class precision/recall thresholds. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Cost per job | O(capped fields + raw description scanned); the scan stops at 3,000 visible characters (4.5 KB of raw input for plain text) and never exceeds 64 KB, so no allocation is proportional to the full description |
| NFR-2  | Throughput | 30,000 jobs (typical keyword-less fan-out) classified in < 2 s on one core (measured figure in §12.4); CI keeps load-robust tripwires only |
| NFR-3  | Precision on `internship` and `new_grad` over the fixture | ≥ 0.95 |
| NFR-4  | Default payload | unchanged except for the additive `careerLevel` field |

## 7. Contracts

### 7.1 Models (`@ever-jobs/models`)

```ts
export const CAREER_LEVEL_CLASSIFIER_TOKEN = 'CAREER_LEVEL_CLASSIFIER';
export const CAREER_LEVELS = ['internship','new_grad','entry','mid','senior','staff',
  'principal','manager','director','executive','unknown'] as const;
export type CareerLevel = (typeof CAREER_LEVELS)[number];
export type CareerLevelConfidence = 'high' | 'medium' | 'low';

export interface CareerLevelVerdict {
  level: CareerLevel;
  confidence: CareerLevelConfidence;
  reasons: string[];
}

export interface CareerLevelInput {
  title?: string | null;
  description?: string | null;
  jobType?: ReadonlyArray<string> | null;
  employmentType?: string | null;
  jobLevel?: string | null;
  experienceRange?: string | null;
}

export interface ICareerLevelClassifier {
  classify(input: CareerLevelInput): CareerLevelVerdict;
  classifyBatch(inputs: ReadonlyArray<CareerLevelInput>): CareerLevelVerdict[];
}

// JobPostDto
careerLevel?: CareerLevelVerdict | null;
// ScraperInputDto
careerLevels?: CareerLevel[];
```

### 7.2 Plugin (`@ever-jobs/career-level-classifier`)

Feature plugin at `packages/plugins/career-level-classifier`: `classifyCareerLevel(input)` (pure
function), `CareerLevelClassifierService` (implements `ICareerLevelClassifier`),
`CareerLevelClassifierModule` (binds the service under `CAREER_LEVEL_CLASSIFIER_TOKEN`).
Registered in `tsconfig.base.json` paths and `jest.config.js` `moduleNameMapper` only (feature
plugin — no `Site` enum entry, not in `ALL_SOURCE_MODULES`).

### 7.3 Aggregator

```ts
interface AggregateOptions {
  // … existing
  readonly careerLevels?: ReadonlyArray<string>;   // FR-8
}
interface AggregateResult {
  // … existing; `jobs` / `outputCount` are post-filter
  readonly careerLevelFilteredOut?: number;        // set only when a filter ran
}
```

`aggregate(input, options)` reads `input.careerLevels` when `options.careerLevels` is absent.
`aggregateRaw` callers (REST controller, GraphQL resolver, future NDJSON path) pass
`careerLevels: input.careerLevels`. `aggregateRaw` never sees the request DTO, so its options type
(`AggregateRawOptions`) makes `careerLevels` a **required key** whenever options are passed
(`careerLevels: undefined` means no filter): a call site rebuilt as `{ dedup, persist }`, by a
refactor or by a merge resolved against a branch that predates the filter, does not compile
instead of silently serving the unfiltered set. The filter is applied after the raw fan-out cache, so both the
REST controller and the GraphQL resolver leave `careerLevels` out of the cache key: the same search
with a different (or no) filter reuses the cached fan-out instead of re-scraping every source.

**Cooperative classification (NFR-2).** Classification runs on the thread that answers
`GET /health`, straight after dedup. `aggregateRaw` therefore classifies in 16-job chunks and
yields to the event loop (`setImmediate`) whenever a 10 ms slice is spent, using `YieldBudget` /
`yieldToEventLoop` from `@ever-jobs/common` (the helpers `dedup-hybrid` introduced after its
10.6 s synchronous-dedup incident, now shared so core code need not import a plugin). A chunk
whose verdict count or shape is wrong is a classifier failure.

**Fail closed (Q-106).** A `careerLevels` filter that cannot be applied is a
`ServiceUnavailableException` (503), never an unfiltered 200: with no classifier bound
`aggregateRaw` throws before dedup runs; if classification throws it throws after. Without a
filter, a classifier failure only leaves the jobs unclassified (the field is additive).

### 7.4 Configuration

| Env | Config key | Default | Meaning |
| --- | ---------- | ------- | ------- |
| `EVER_JOBS_CLASSIFY_CAREER_LEVEL` | `careerLevel.classify` | `true` | `false` → no `careerLevel` on any job |

### 7.5 Classification rules

Title is normalised (NFKD, diacritics stripped, lower-cased, dashes unified) and split into
*segments* at `, ; | : ( ) [ ] /` and spaced dashes. Title rules, in precedence order (first
matching class wins; within a class the strongest confidence wins):

| # | Level | Title cues (word-bounded) | Guards (cue ignored) |
| - | ----- | ------------------------- | -------------------- |
| 1 | `internship` | `intern(s)`, `internship(s)`, `extern(ship)`, `co-op`/`coop`, `summer analyst/associate/intern/student/clerk`, *season + year* (`Summer 2026`, `Fall '26`), `working student`, `werkstudent`, `student worker/assistant/researcher/…`, `praktikant/praktikum`, `stagiaire`, `becario`, `pasante`, `prácticas`, `estagiário`, `tirocinante`, `thesis`, industrial/year/summer `placement`, `year in industry`, `spring week`, French `stage` (segment start + French preposition, or a whole segment), `research experience for undergraduates` / `REU`, `graduate research/teaching assistant`, `graduate assistant`, `undergraduate research/student`, 实习, インターン, 인턴 | never `internal`, `international`, `internet`, `interne`, `internist`, `cooperative`; co-op followed by retail nouns (`food`, `store`, `funeral`, `pharmacy`, `cashier`, `clerk`, `deli`, `produce`, …) or preceded by a co-operative business (`food`, `grocery`, `credit`, `housing`, `farm`, …); **season + year** (the weakest cue, see *Season + year* below); **program-admin context** (below) |
| 2 | `new_grad` | `new grad(uate)`, `NCG`, `recent grad(uate)`, `university/college/campus grad/graduate/hire`, `early career(s)`, `early in career`, `early talent`, `class of 20xx`, `fresher(s)`, `graduate` + role/program noun (`Graduate Engineer`, `Graduate Programme`, `Graduate Nurse`), trailing `… Graduate`, `20xx graduate`, `nurse resident/residency`, `rotational program` | `post-graduate`; `graduate school/studies/admissions/medical`; program-admin context |
| 3 | `executive` | `vice president`, `VP`, `SVP`, `EVP`, `AVP`, `president`, `chief … officer`, `CEO/CFO/CTO/COO/CIO/CMO/CISO/CHRO`, other `chief …`, `executive director`, `managing director`, `managing/general/founding/senior/equity partner` when *partner* is the head noun (end of the segment, or followed by `at` / `of` / `in` / `and` / `or` / `&`), bare `Partner`, `founder`/`co-founder` | **bank corporate title**: VP/AVP together with an IC role noun (`Vice President, Software Engineer`) → `senior`; `chief of staff` → `director`; `business/HR/talent/finance… partner`, `account/sales executive`, `executive assistant` never executive; `senior partner` before a role noun is the partner / channel function of an IC (*Senior Partner Manager*, *Senior Partner Solutions Architect* → `senior`); **someone else's title** (rows 3–5, below); `founder's …` / `founders office|fund|…` (a function, not a founder) |
| 4 | `director` | `director`, `head of`, `chief of staff`, school `principal` / `assistant principal` | `funeral director` |
| 5 | `manager` | `manager`/`mgr` (not an IC-manager compound), `supervisor`, `foreman`, `team/shift/crew lead(er)`, `head chef/coach`, `executive chef` | IC-manager compounds: `product`, `program`, `project`, `account`, `case`, `community`, `customer/client success`, `relationship`, `portfolio`, `partner`, `territory`, `category`, `campaign`, `content`, `engagement`, `product marketing`, `partner marketing` + manager |
| 6 | `principal` | `principal` + role, `distinguished …`, `technical fellow`, `associate principal` | school principal (→ director) |
| 7 | `staff` | `staff` + tech role (`software`, `engineer`, `data`, `ML`, `research`, `designer`, `product`, `security`, `SRE`, …) | `staff nurse/RN/pharmacist/attorney/writer`, `member of technical staff`, `staff accountant/auditor` (→ entry), `chief of staff` |
| 8 | `senior` | `senior`, `sr`, `snr`, `lead` + role / `tech lead` / `… lead`, numerals `III`/`3` (low), `IV`/`V`/`4`/`5` (medium) | `senior living/care/center/services/home/housing/community/citizen/high/secondary/school`; `lead generation`, `lead abatement/paint` |
| 9 | `mid` | `mid-level`, `mid level`, `mid` + role, `intermediate`, `journeyman`/`journeyperson`/`journey level`, numerals `II`/`2`/`level 2` | `mid-market`, `intermediate school` |
| 10 | `entry` | `junior`, `jr`, `jnr`, `entry level`, `associate` + role (`Associate Engineer`, `Associate Product Manager`), numerals `I`/`1`/`level 1`, `trainee`, `apprentice(ship)`, `staff accountant/auditor`, `postdoc(toral)` | `junior high`, `junior college`; `associate director/principal/partner/professor/dean/counsel/vp` |

**Numerals** count only directly after a role noun (`engineer`, `analyst`, `SDE`, `nurse`, …) or
`level`; `Tier N` and `Level N support` are support tiers, not seniority. A numeral range
(`Engineer I/II`) resolves to the lower bound with `low` confidence. A keyword range
(`Junior/Mid`, `Senior/Staff`, `Mid-Senior`) resolves to the lower level with `low` confidence;
stacked modifiers without a separator (`Senior Staff`, `Senior Principal`) are not ranges and
take the higher level.

**Season + year** (`Summer 2026`, `Fall '26`, `2027 Spring`) is the weakest title cue: it yields
`internship` only when it is the title's *only* evidence, and always at **low** confidence with
the reason `"fall 2026" (season + year only)`: what survives the guards below is still ambiguous
(*Software Engineer, Fall 2026* or *Quantitative Trader - Fall 2026* is as often a new-grad or
quant start date), so a consumer can threshold it out. Independent evidence (an internship
description, `jobType` internship) lifts it to medium. Any other title signal — an
intern / new-grad cue or an explicit ladder word at any level — drops it, so *Senior Software Engineer
(Fall 2026)* is `senior` and *Director of Marketing - Summer 2026* is `director`. It is also
ignored when it is a start date (`… Fall 2026 Start`, `intake`), a seasonal job or an academic /
coaching term (`camp`, `seasonal`, `lifeguard`, `pool`, `counselor`, `adjunct`, `faculty`,
`lecturer`, `instructor`, `professor`, `teacher`, `coach`, `tutor`, `ski`), the start date of an
`associate` / `staff` / `assistant` / `analyst` hire (Big Four and law-firm new-grad classes: *Audit
Associate - Fall 2026*, *Assurance Staff - Fall 2026*), or the term of a role that names an admin or
leadership noun (*Internship Coordinator - Summer 2026*). Those titles are `unknown` unless another
cue decides (Q-105 item 10).

**Someone else's title.** Rules 3–5 name a title-holder. The rule is skipped, with an
`ignored "…" (someone else's title)` reason, when `to` / `for` — or `to` / `for` / `of` followed by
`the` / `our` — comes at most two modifier words before the match (*Executive Assistant to the VP of
Sales*, *Assistant to the Regional Director*, *Office of the Founders*, *Recruiter for Store
Managers*), or a bare `of` comes right before it (*Board of Directors*). A bare `of` further back is
part of a compound noun and does not count (*Front of House Manager* is `manager`).

**Program-admin context.** An intern / new-grad cue describes the *program the role administers*,
not the role itself, when (a) an admin noun (`recruiter`, `coordinator`, `manager`,
`director`, `specialist`, `partner`, `advisor`, `liaison`, `administrator`, `officer`,
`lead`, `admissions`, `relations`, `outreach`, …) follows it within three tokens of the same
segment (`manager` counts only when not part of an IC-manager compound other than
`program`), (b) it is preceded by `of`/`for` in a title that also names an admin/leadership
noun (`Head of Early Careers`), (c) it is plural and the title names an admin/leadership noun
(`Director, Internships`), or (d) the title names a recruiting or programme-staff role
(`recruiter`, `sourcer`, `admissions`, `registrar`, `dean`, `educator`, `preceptor`) in a
different segment (`Campus Recruiter - New Grad`, `Nurse Educator - New Graduate Residency`).
A recruiting word in the *same* segment as the cue is the role (`Talent Acquisition Intern`).
So *Senior Intern Program Manager* is `senior`, *Internship Coordinator* is `unknown`, while
*Program Manager Intern* and *Talent Acquisition Intern* stay `internship`.

**Structured fields** (medium confidence): `jobType` containing `internship`, an
`employmentType` matching an internship cue → `internship`; `jobLevel` (LinkedIn vocabulary:
`Internship`, `Entry level`, `Associate` → entry/low, `Mid-Senior level` → mid/low, `Director`,
`Executive`; otherwise the title rules); `experienceRange` minimum years (`0–1` → entry,
`2–4` → mid, `≥ 5` → senior, `Fresher` → new_grad).

**Description** (low confidence, first 3,000 characters, HTML stripped): targeted phrases only —
`this … internship`, `N-week internship`, `as an intern`, `interns will`; `class of 20xx`,
`(open to|for|seeking…) recent/new graduates`, `new grad role/position/program`,
`early-career candidates`; `entry-level role`, `no experience required`; `team of N` / `direct
reports` (manager); and *years of experience* (the largest lower bound among mentions ≤ 30:
`0–1` → entry, `2–4` → mid, `≥ 5` → senior). Incidental mentions (`mentor junior engineers and
new grads`, `our internship program`) do not fire.

Years are a *lower bound*: they conflict with the title only when the title is much more junior
(`Intern` + `5+ years`) or when `0–1` years meets a `senior`+ title.

### 7.6 Errors

| Case | Result |
| ---- | ------ |
| `careerLevels` contains a value outside `CAREER_LEVELS` | 400 (REST) / `BAD_REQUEST` error, `data: null` (GraphQL), both from the global `ValidationPipe` (`@IsIn(CAREER_LEVELS)`) before any scraping; the resolver re-checks for callers that bypass the pipe |
| Classifier throws or returns a malformed batch (must not happen), no filter | aggregator logs a warning and returns the jobs unclassified |
| Same, with a `careerLevels` filter | 503 `ServiceUnavailableException` ("careerLevels filter could not be applied …"), never an unfiltered result (Q-106) |
| `careerLevels` filter with no classifier bound | 503, raised before dedup / persistence run (Q-106) |

## 8. Test Plan

- **Unit — rules** (`packages/plugins/career-level-classifier/__tests__/career-level.rules.spec.ts`):
  one table per class, every guard from §7.5 as a negative case, numerals and ranges, structured
  fields, description cues and incidental mentions, confidence adjustment, determinism,
  robustness to `null`/empty/garbage input.
- **Evaluation** (`career-level.evaluation.spec.ts` + fixture `fixtures/career-level.fixture.ts`,
  ≥ 250 labelled titles + structured/description cases): per-class precision/recall and the
  confusion matrix; CI thresholds: precision ≥ 0.95 on `internship` and `new_grad`, recall
  ≥ 0.90 on both, overall accuracy ≥ 0.90.
- **Performance** (tripwires, not the NFR measurement): over 5,000 jobs with 3 KB descriptions the
  classifier costs < 15x a reference workload timed in the same process on the same inputs (one
  `normalizeCareerText` pass over title + description; best of three interleaved rounds; measured
  4.8-5.7, so a 3x slowdown sits at the bound; controls running the classifier 4x per job
  measured 19.1 and 22.4 and failed), with an absolute < 2 ms/job backstop; each of nine adversarial inputs (repeated cue words, 5,000-char
  titles, 3,000 digits, nested separators, tag floods, "<" with no ">", 64 KB of markup, entity
  floods) classifies in < 250 ms, which rules out catastrophic regex backtracking; and ~60 KB
  `employmentType` / `jobLevel` / `experienceRange` values classify in < 250 ms with every reason
  ≤ 160 characters.
- **Service / module**: `classifyBatch` preserves order; the module binds the token.
- **Aggregator wiring** (`apps/api/src/jobs/__tests__/jobs.aggregator.career-level.spec.ts`):
  every returned job gets `careerLevel` on the dedup, no-dedup and no-engine paths; toggle off →
  absent; `careerLevels` filter keeps only matching jobs, updates `outputCount`, reports
  `careerLevelFilteredOut`, does not mutate the raw (cached) array, and still works with the
  toggle off; `aggregate()` reads `input.careerLevels`; source `jobType`/`jobLevel` untouched;
  a filter with no classifier, a throwing classifier or a short batch is a 503 (Q-106).
  **Event-loop liveness:** a self-rescheduling `setImmediate` probe must tick while a 300-job batch
  with a ≥ 1 ms/job classifier runs (≥ 5 ticks, worst stall < 250 ms, override
  `CAREER_LEVEL_LOOP_MAX_STALL_MS`), and while 3,000 real jobs with 3 KB descriptions are
  classified, with verdicts identical to a synchronous pass. A synchronous pass ticks 0 times.
  **REST cache key:** `careerLevels` is not part of it; a cache hit is filtered per request.
- **Shared helpers** (`packages/common/__tests__/cooperative.spec.ts`): `yieldToEventLoop`
  resumes after a queued `setImmediate`; `YieldBudget` expires, renews and yields only when spent.
- **DTO validation**: `careerLevels` with an unknown value fails `class-validator`.
- **GraphQL resolver**: filter passed through; unknown value rejected.
- **Through the production pipe** (`apps/api/__tests__/integration/search-input-pipe.integration.spec.ts`):
  boots Apollo, `JobsResolver` and `JobsController` with `createGlobalValidationPipe()` (the factory
  `main.ts` uses) and the production exception filter, and sends real requests. GraphQL: the
  filtered count, `BAD_REQUEST` for an unknown level before scraping, every search field reaching
  `JobsService`, and every `SearchJobsInput` field (read from schema introspection) carrying a
  class-validator decorator. REST: the same filter and a 400. Unit tests that call the resolver
  directly cannot see a pipe that strips the input; only this suite can.
- **Call-site guard**: a `@ts-expect-error` test fails the build if `careerLevels` ever becomes an
  optional key of `AggregateRawOptions` again.
- **CI**: the classifier's three suites run in the gating *Feature Plugins* job, and the pipe suite
  plus the aggregator / resolver career-level specs in the same job's *career-level API* step.

## 9. Open Questions

Recorded in `docs/questions.md`:

- **Q-105** — taxonomy boundary decisions (apprenticeship, graduate assistantships, banking
  corporate titles, distinguished/fellow, partner, IC-manager titles, level numerals).
- **Q-106** — `careerLevels` filter semantics when the classifier is switched off, and whether
  `unknown` is filterable.

## 10. Decisions

- D-01: Apprenticeship → `entry`, not `internship` (Q-105): an apprenticeship is a paid,
  employed training contract, often multi-year, not a temporary student placement.
- D-02: Graduate research/teaching assistant → `internship` (student appointment), never
  `new_grad` (Q-105).
- D-03: `VP`/`AVP` next to an IC role noun (`Vice President, Software Engineer`) → `senior`
  (bank corporate title); otherwise `executive` (Q-105).
- D-04: Distinguished engineer / technical fellow → `principal` (top IC rung); the taxonomy's
  `executive` is reserved for management (Q-105).
- D-05: Level numerals: `I` → entry, `II` → mid, `III` → senior (low), `IV`/`V` → senior
  (medium) (Q-105).
- D-06: Product/program/project/account-type "manager" titles are IC roles; without another
  modifier they are `unknown` (Q-105).
- D-07: Classification lives in the aggregator, not the controller, so every output format
  (including the NDJSON stream being added in parallel) inherits it.
- D-08: With `EVER_JOBS_CLASSIFY_CAREER_LEVEL=false`, an explicit `careerLevels` filter is still
  honoured by classifying transiently; the field is not attached (Q-106).
- D-09: A `careerLevels` filter that cannot be applied (no classifier bound, classifier failure)
  is a 503, not an unfiltered 200 (Q-106, review 2026-09-25).
- D-10: Classification yields to the event loop every 10 ms (shared `YieldBudget` in
  `@ever-jobs/common`), so it can never block `/health` (review 2026-09-25).

## 11. References

- `packages/plugins/legitimacy-detector` (Spec 740) — the pure/explainable feature-plugin pattern
  this follows.
- `apps/api/src/jobs/jobs.aggregator.ts` — wiring point.
- Evaluation report: §12 below; regenerate with
  `npx ts-node --project tsconfig.base.json -r tsconfig-paths/register scripts/career-level-eval.ts [all|design|holdout]`.

## 12. Evaluation results (2026-09-25)

The fixture (`packages/plugins/career-level-classifier/__tests__/fixtures/career-level.fixture.ts`)
has three parts:

| Part | Cases | How it was built |
| ---- | ----: | ---------------- |
| Design titles | 332 | Written alongside the rules, including every tricky negative named in the task. |
| Context cases | 17 | Title silent or conflicting; `jobType` / `employmentType` / `jobLevel` / `experienceRange` / description decide, plus incidental-mention negatives. |
| Held-out titles | 174 | Labelled under the same policy **before the classifier was first run on them**. |
| Review regressions | 32 | Added after the 2026-09-25 code review: reviewer probes that the rules got wrong, plus controls (§12.5). Not blind. |

The design set scores 100% by construction, so it proves the guards work but says nothing about
generalisation. **The held-out first run is the honest estimate:**

### 12.1 Held-out set — first run, before any rule change

Cases: **174** — correct: **170** — accuracy: **0.977**

| Level | Support | Predicted | TP | Precision | Recall |
| ----- | ------: | --------: | -: | --------: | -----: |
| `internship` | 32 | 30 | 30 | **1.000** | 0.938 |
| `new_grad` | 22 | 21 | 21 | **1.000** | 0.955 |
| `entry` | 13 | 13 | 13 | 1.000 | 1.000 |
| `mid` | 9 | 9 | 9 | 1.000 | 1.000 |
| `senior` | 16 | 16 | 16 | 1.000 | 1.000 |
| `staff` | 7 | 7 | 7 | 1.000 | 1.000 |
| `principal` | 7 | 7 | 7 | 1.000 | 1.000 |
| `manager` | 16 | 15 | 15 | 1.000 | 0.938 |
| `director` | 9 | 9 | 9 | 1.000 | 1.000 |
| `executive` | 11 | 11 | 11 | 1.000 | 1.000 |
| `unknown` | 32 | 36 | 32 | 0.889 | 1.000 |

The four misses were all recall gaps (a level fell to `unknown`), never a wrong level:

- "Stage - Assistant(e) Chef de Projet Marketing" (French *stage* = internship) → `unknown`
- "Research Experience for Undergraduates (REU)" → `unknown`
- "Early Talent - Software Engineer" → `unknown`
- "Executive Chef" (runs the kitchen) → `unknown`

Rules added afterwards (so the held-out set is no longer blind): French `stage` only at the start of
a segment followed by a French preposition or as a whole segment (never *Stage Manager* /
*Stage Hand*); `research experience for undergraduates` / `REU`; `early talent` (with the usual
program-admin guard); `executive chef` → manager; and `educator` / `preceptor` as programme-staff
nouns (*Nurse Educator - New Graduate Residency* is not a new-grad role).

### 12.2 Whole fixture after those fixes

Cases: **523** — correct: **523** — accuracy: **1.000**

| Level | Support | Predicted | TP | Precision | Recall |
| ----- | ------: | --------: | -: | --------: | -----: |
| `internship` | 87 | 87 | 87 | 1.000 | 1.000 |
| `new_grad` | 62 | 62 | 62 | 1.000 | 1.000 |
| `entry` | 46 | 46 | 46 | 1.000 | 1.000 |
| `mid` | 31 | 31 | 31 | 1.000 | 1.000 |
| `senior` | 55 | 55 | 55 | 1.000 | 1.000 |
| `staff` | 19 | 19 | 19 | 1.000 | 1.000 |
| `principal` | 22 | 22 | 22 | 1.000 | 1.000 |
| `manager` | 42 | 42 | 42 | 1.000 | 1.000 |
| `director` | 28 | 28 | 28 | 1.000 | 1.000 |
| `executive` | 29 | 29 | 29 | 1.000 | 1.000 |
| `unknown` | 102 | 102 | 102 | 1.000 | 1.000 |

Confusion matrix (rows = gold label, columns = prediction): the diagonal only —
`int 87, ng 62, ent 46, mid 31, sen 55, stf 19, prn 22, mgr 42, dir 28, exe 29, unk 102`.

### 12.3 What these numbers do and do not show

- One author wrote the rules and both label sets. The labels are not an independent human
  annotation, and the fixture is not a sample of real traffic. Expect lower real-world recall,
  mostly as `unknown` on unusual phrasings, which is the failure mode the precedence is designed
  for. The first-run precision of 1.000 on the two early-career classes is the figure that matters
  for NFR-3.
- CI thresholds (`career-level.evaluation.spec.ts`) are the contract, not the current score:
  precision ≥ 0.95 and recall ≥ 0.90 on `internship` and `new_grad`, accuracy ≥ 0.90, checked on
  the whole fixture **and** on the held-out part alone. A further test asserts that no gold
  non-early-career case is ever labelled `internship` / `new_grad`.
- The next honest step is a sample of real `/api/jobs/search` titles labelled by someone else
  (open issue).

### 12.4 Cost (NFR-2)

30,000 jobs, each with a fixture title and a 3.2 KB description, in plain Node 24 on the shared
build workstation (Xeon E5-1660 v3, **89% CPU load from other agents' builds at the time**):
**2.7–3.1 s** (about 90–100 µs/job; roughly 12 µs title + 60 µs description). That misses the 2 s
target on a loaded machine and was not re-measured idle. CI does not assert the NFR itself. A wall-clock bound on shared runners flakes: the same 30,000 jobs
took 13.4 s inside a fully parallel jest run. CI instead keeps load-robust tripwires (§8). The
throughput one was an absolute < 2 ms/job, 20-30x the real cost, so a 10x regression stayed green;
since the second review it is a ratio against a same-process reference workload (§8), which a 4x
slowdown fails (a 3x one sits at the bound). A reviewer's independent measurement: 30,000 jobs with ~3 KB descriptions in
1.8-2.2 s at 44% machine load (0.06-0.07 ms/job), titles only 0.3 s. The first
implementation took 24 s under jest. The fixes were: no `String.prototype.matchAll` (it clones the
RegExp on every call), literal-needle gates before every rule, one alternation pass over the
description instead of ~30 `includes` scans, and a whitespace pass that no longer rewrites every
single space.

The 2 s NFR concerns throughput; the event loop is protected separately. Since the review fixes,
classification yields every 10 ms (§7.3), so even a 13 s pass under load no longer blocks
`/health` — it only costs CPU. Measured on the slow-classifier test: a 300-job, ≥ 300 ms pass let
the probe tick on every chunk. A remaining cost: every page of a cached `?paginate=true` search
re-classifies the whole deduplicated set (the filter needs every verdict to count pages).
Scoping classification to the output window when no filter is set needs the controller to resolve
the page window before `aggregateRaw`; that controller block is being rewritten by the NDJSON lane,
so it is left to the integration of the two branches (with the cache off by default, every page
request already pays a full fan-out that dwarfs classification).

### 12.5 Review regressions (2026-09-25)

A code review probed the rules with titles the fixture did not cover and found three defect
classes, all of which put non-early-career jobs into the `internship` class Hust filters on (or
an assistant into `executive`):

| Defect | Examples (before → after) |
| ------ | ------------------------- |
| A season + year alone marked an internship and outranked every explicit level | *Audit Associate - Fall 2026*, *Assurance Staff - Fall 2026*, *Adjunct Faculty - Spring 2026*, *Winter 2026 Ski Instructor* `internship` → `unknown`; *Senior Software Engineer (Fall 2026)* `internship` → `senior`; *Director of Marketing - Summer 2026* `internship` → `director` |
| The "someone else is the executive" guard covered only president / chief / CxO | *Executive Assistant to the VP of Sales*, *… to the Founder*, *Assistant to the Director*, *Administrative Assistant to the Head of School* `executive`/`director` → `unknown`; *Founder's Associate*, *Founders Office Associate* `executive` → `unknown` |
| The co-op guard read only the word after the cue | *Food Co-op Cashier*, *Co-op Cashier* `internship` → `unknown` |

The fixes are in §7.5 (*Season + year*, *Someone else's title*, row 1 co-op guards). The 32 probe
titles and controls are the fixture's *review regressions* part. While fixing them one held-out case
regressed silently (*Front of House Manager* fell to `unknown`, a bare `of` read as a holder) and
every threshold stayed green, so the evaluation spec now also pins the current result: any
misclassification not listed in its `KNOWN_MISSES` fails CI (the list is empty).

Whole fixture after the fixes: **555 cases, 555 correct** (`internship` 90/90, `new_grad` 62/62,
precision and recall 1.000 on every class). The held-out first-run figure in §12.1 remains the
honest generalisation estimate; these numbers are by construction.

### 12.6 Second review (2026-09-25)

A second review booted the real app and probed the classifier with oversized and markup-heavy
inputs. Findings and fixes:

| Finding | Fix |
| ------- | --- |
| The GraphQL `careerLevels` filter failed **open** in production: the global `ValidationPipe` (`whitelist: true`) also runs on GraphQL `@Args`, and `SearchJobsInput` had no class-validator decorators, so the pipe stripped every field. `careerLevels: ["principal"]` returned the unfiltered set; `["intern"]` returned 200. `searchTerm`, `location`, `siteType`, … never reached `JobsService` either, so every GraphQL search ran keyword-less with defaults (this part predates Spec 1730). | Every `SearchJobsInput` field is decorated (FR-9); one `createGlobalValidationPipe()` factory for `main.ts` and the tests; an integration suite sends real requests through that pipe on GraphQL and REST (§8). `country` and `descriptionFormat` now reach `JobsService` too, and keep the lenient GraphQL rules Spec 1689 put on `develop` (integration decision, 2026-09-25): `country` takes a `Country` value, a country name or alias, or an ISO alpha-2 code (`DE` → `GERMANY`) and is resolved by `resolveSearchCountry` **before** any plugin sees it, so Indeed / Glassdoor domain lookup never gets an unknown value; an unrecognised country is dropped with a warning, not rejected. `descriptionFormat` is any string; a value outside `markdown` / `html` / `plain` reaches the plugins as-is, and they leave the description unconverted, as for `html`. An earlier cut of this branch rejected values outside the REST enums with `BAD_REQUEST`; it was dropped because it would break the `DE`-style codes GraphQL has always documented, and resolving first already removes the risk it guarded against. The pipe suite pins both rules. |
| `employmentType` / `jobLevel` went through the super-linear title analysis uncapped: ~1.1 s for a 60 KB value, ~21 s for 240 KB, inside one synchronous call that chunked classification cannot yield out of. | `analyzeTitle` caps its own input (300 characters, word boundary), so no caller can bypass it; `experienceRange` is capped at 120; reasons quote at most ~60 characters of a source field (FR-3). |
| *Senior Partner Manager*, *Senior Partner Solutions Architect*, *Senior Partner Engineer, Google Cloud* and three more came out `executive`/high. | `senior partner` fires only when *partner* is the head noun; `partner marketing` is an IC-manager prefix (§7.5 rows 3 and 5). Six titles plus six controls added to the fixture. |
| A bare season + year was `internship`/**medium**, though many such titles are new-grad / quant / banking start dates. | Always low confidence (§7.5 *Season + year*, Q-105 item 10). |
| The description window was 4,500 **raw** characters, stripped afterwards: tag-heavy HTML lost all visible text, and a cut inside a tag leaked its attribute text. | Up to three raw windows (4.5 / 16 / 64 KB) until 3,000 visible characters are found; an open tag at the window edge is dropped; the tag regex is linear on `<` floods (FR-3). |
| The throughput tripwire (< 2 ms/job) was 20-30x the real cost. | Ratio against a same-process reference workload (§8, §12.4). |
| Merge hazard: a call rebuilt as `aggregateRaw(raw, { dedup, persist })` (the NDJSON lane's shared `runSearch()`) silently drops the filter for JSON and NDJSON. | `careerLevels` is a required key of `AggregateRawOptions` (§7.3). The integrator must still keep `careerLevels: input.careerLevels` in `runSearch()` and add an NDJSON test that sends `careerLevels` and counts the job lines. |

Whole fixture after these fixes: **567 cases, 567 correct**; the held-out titles: 174/174 (the
first-run figure in §12.1 remains the honest generalisation estimate).
