# Spec: 1730 — Career-Level Classifier (intern / new-grad / seniority)

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 1730                               |
| Slug           | career-level-classifier            |
| Status         | done                               |
| Owner          | agent                              |
| Created        | 2026-09-24                         |
| Last updated   | 2026-09-24                         |
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
| FR-3  | Inputs: `title` (primary), `description` (first 3,000 characters after tag stripping, secondary), source `jobType`, `employmentType`, `jobLevel`, `experienceRange`. | must |
| FR-4  | Title signals beat structured source fields, which beat description signals. A lower-priority signal that disagrees by ≥ 2 rungs lowers confidence one step; a structured field that agrees raises it one step. | must |
| FR-5  | `unknown` (confidence `low`) when no signal is found anywhere. | must |
| FR-6  | Applied in `JobsAggregator.aggregateRaw` after dedup (and on the no-dedup / no-engine paths), once per returned job, before the response is shaped — so JSON, pagination, CSV, NDJSON and GraphQL all see it. Not applied in the controller. | must |
| FR-7  | `EVER_JOBS_CLASSIFY_CAREER_LEVEL` (default `true`); `false` → `careerLevel` is absent from every job. | must |
| FR-8  | Optional `ScraperInputDto.careerLevels?: string[]`; unknown values are a 400 (class-validator `@IsIn`). When non-empty, only jobs whose level is in the set are returned. Applied after classification. The filter is honoured even when FR-7 disabled attachment (the level is computed transiently) — see Q-106. | must |
| FR-9  | GraphQL: `JobPostGql.careerLevel` (`CareerLevelGql { level, confidence, reasons }`) and `SearchJobsInput.careerLevels: [String!]` with the same validation. | should |
| FR-10 | Source `jobType` / `jobLevel` / `experienceRange` are never mutated. | must |
| FR-11 | A labelled fixture of ≥ 250 titles (+ description / structured-field cases) is evaluated in CI with per-class precision/recall thresholds. | must |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Cost per job | O(title + 3,000 description chars); no allocation proportional to the full description |
| NFR-2  | Throughput | 30,000 jobs (typical keyword-less fan-out) classified in < 2 s on one core (measured by a test) |
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
`careerLevels: input.careerLevels`.

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
| 1 | `internship` | `intern(s)`, `internship(s)`, `extern(ship)`, `co-op`/`coop`, `summer analyst/associate/intern/student/clerk`, *season + year* (`Summer 2026`, `Fall '26`), `working student`, `werkstudent`, `student worker/assistant/researcher/…`, `praktikant/praktikum`, `stagiaire`, `becario`, `pasante`, `prácticas`, `estagiário`, `tirocinante`, `thesis`, industrial/year/summer `placement`, `year in industry`, `spring week`, `graduate research/teaching assistant`, `graduate assistant`, `undergraduate research/student`, 实习, インターン, 인턴 | never `internal`, `international`, `internet`, `interne`, `internist`, `cooperative`; co-op followed by retail nouns (`food`, `store`, `funeral`, `pharmacy`, …); season+year with `camp`, `seasonal`, `lifeguard`, `pool`, `start`; **program-admin context** (below) |
| 2 | `new_grad` | `new grad(uate)`, `NCG`, `recent grad(uate)`, `university/college/campus grad/graduate/hire`, `early career(s)`, `early in career`, `class of 20xx`, `fresher(s)`, `graduate` + role/program noun (`Graduate Engineer`, `Graduate Programme`, `Graduate Nurse`), trailing `… Graduate`, `20xx graduate`, `nurse resident/residency`, `rotational program` | `post-graduate`; `graduate school/studies/admissions/medical`; program-admin context |
| 3 | `executive` | `vice president`, `VP`, `SVP`, `EVP`, `AVP`, `president`, `chief … officer`, `CEO/CFO/CTO/COO/CIO/CMO/CISO/CHRO`, other `chief …`, `executive director`, `managing director`, `managing/general/founding/senior/equity partner`, bare `Partner`, `founder`/`co-founder` | **bank corporate title**: VP/AVP together with an IC role noun (`Vice President, Software Engineer`) → `senior`; `chief of staff` → `director`; `business/HR/talent/finance… partner`, `account/sales executive`, `executive assistant` never executive |
| 4 | `director` | `director`, `head of`, `chief of staff`, school `principal` / `assistant principal` | `funeral director` |
| 5 | `manager` | `manager`/`mgr` (not an IC-manager compound), `supervisor`, `foreman`, `team/shift/crew lead(er)`, `head chef/coach` | IC-manager compounds: `product`, `program`, `project`, `account`, `case`, `community`, `customer/client success`, `relationship`, `portfolio`, `partner`, `territory`, `category`, `campaign`, `content`, `engagement`, `product marketing` + manager |
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

**Program-admin context.** An intern / new-grad cue describes the *program the role administers*,
not the role itself, when (a) an admin noun (`recruiter`, `coordinator`, `manager`,
`director`, `specialist`, `partner`, `advisor`, `liaison`, `administrator`, `officer`,
`lead`, `admissions`, `relations`, `outreach`, …) follows it within three tokens of the same
segment (`manager` counts only when not part of an IC-manager compound other than
`program`), (b) it is preceded by `of`/`for` in a title that also names an admin/leadership
noun (`Head of Early Careers`), (c) it is plural and the title names an admin/leadership noun
(`Director, Internships`), or (d) the title names a recruiting role (`recruiter`,
`talent acquisition`, `admissions`, …) in a different segment (`Campus Recruiter - New Grad`).
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
| `careerLevels` contains a value outside `CAREER_LEVELS` | 400 (REST `ValidationPipe`) / `BadRequestException` (GraphQL) |
| Classifier throws (must not happen) | aggregator logs a warning and returns the jobs unclassified |

## 8. Test Plan

- **Unit — rules** (`packages/plugins/career-level-classifier/__tests__/career-level.rules.spec.ts`):
  one table per class, every guard from §7.5 as a negative case, numerals and ranges, structured
  fields, description cues and incidental mentions, confidence adjustment, determinism,
  robustness to `null`/empty/garbage input.
- **Evaluation** (`career-level.evaluation.spec.ts` + fixture `fixtures/career-level.fixture.ts`,
  ≥ 250 labelled titles + structured/description cases): per-class precision/recall and the
  confusion matrix; CI thresholds: precision ≥ 0.95 on `internship` and `new_grad`, recall
  ≥ 0.90 on both, overall accuracy ≥ 0.90.
- **Performance**: 30,000 synthetic jobs with 3 KB descriptions in < 2 s.
- **Service / module**: `classifyBatch` preserves order; the module binds the token.
- **Aggregator wiring** (`apps/api/src/jobs/__tests__/jobs.aggregator.career-level.spec.ts`):
  every returned job gets `careerLevel` on the dedup, no-dedup and no-engine paths; toggle off →
  absent; `careerLevels` filter keeps only matching jobs, updates `outputCount`, reports
  `careerLevelFilteredOut`, does not mutate the raw (cached) array, and still works with the
  toggle off; `aggregate()` reads `input.careerLevels`; source `jobType`/`jobLevel` untouched.
- **DTO validation**: `careerLevels` with an unknown value fails `class-validator`.
- **GraphQL resolver**: filter passed through; unknown value rejected.

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

## 11. References

- `packages/plugins/legitimacy-detector` (Spec 740) — the pure/explainable feature-plugin pattern
  this follows.
- `apps/api/src/jobs/jobs.aggregator.ts` — wiring point.
- Evaluation results: `evaluation.md` in this folder (regenerate with
  `npx ts-node --project tsconfig.base.json -r tsconfig-paths/register scripts/career-level-eval.ts`).
