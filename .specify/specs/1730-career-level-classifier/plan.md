# Plan: 1730 — Career-Level Classifier (intern / new-grad / seniority)

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Created      | 2026-09-24 |
| Last updated | 2026-09-24 |

## 1. Approach

A new **feature plugin** `career-level-classifier`, shaped exactly like `legitimacy-detector`
(Spec 740): a pure rule engine (`classifyCareerLevel`) wrapped by an `@Injectable` service bound
under a public DI token (`CAREER_LEVEL_CLASSIFIER_TOKEN`). Consumers inject by token, so a
future model-backed classifier can replace it without touching callers.

The engine is table-driven regex over a normalised title, split into segments so that guards can
reason about *which* noun a cue modifies ("Intern Program Manager" vs "Program Manager Intern").
Structured source fields and a bounded description scan only fill in when the title is silent,
and otherwise only move the confidence.

Wiring happens in exactly one place — `JobsAggregator.aggregateRaw` — after dedup and before the
result leaves the aggregator. Every caller that shapes a response (REST JSON/CSV, GraphQL, and the
NDJSON stream another lane is adding) goes through `aggregateRaw`, so they all inherit the field.
The request filter rides in `AggregateOptions.careerLevels`; the only caller changes are passing
`careerLevels: input.careerLevels` through.

## 2. Phases

### Phase 1 — Contracts (models)
- `career-level-classifier.interface.ts`: token, `CAREER_LEVELS`, types, `ICareerLevelClassifier`,
  `isCareerLevel()`.
- `JobPostDto.careerLevel`, `ScraperInputDto.careerLevels` (`@IsIn` each).
- Exit: type-checks; DTO validation rejects unknown levels.

### Phase 2 — Plugin + rules
- `packages/plugins/career-level-classifier/{package.json,tsconfig.json,src/*}`.
- Rules per spec §7.5; service + module.
- Path alias + jest mapper.
- Exit: rule unit tests green.

### Phase 3 — Evaluation fixture
- ≥ 250 labelled titles + structured/description cases; evaluation test with thresholds;
  `scripts/career-level-eval.ts` prints the confusion matrix for the spec.
- Exit: thresholds met; numbers recorded in spec §12.

### Phase 4 — Wiring
- Aggregator: optional classifier + ConfigService injection; classify after dedup on every path;
  filter; `careerLevelFilteredOut`.
- `configuration.ts`: `careerLevel.classify` ← `EVER_JOBS_CLASSIFY_CAREER_LEVEL`.
- `JobsModule` imports `CareerLevelClassifierModule`.
- Controller + resolver pass `careerLevels` through (one line each); GraphQL types.
- Exit: aggregator wiring tests green; existing aggregator/controller/resolver tests unchanged.

### Phase 5 — Docs
- README (request parameter, response schema, configuration, a short "Career level" section),
  `.env.example`, `docs/index.md`, `docs/log.md`, `docs/questions.md` (Q-105, Q-106).

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/models` | new interface file; `JobPostDto.careerLevel`; `ScraperInputDto.careerLevels` |
| `packages/plugins/career-level-classifier` | NEW feature plugin (rules, service, module, tests, fixture) |
| `apps/api/src/jobs` | aggregator wiring; module import; controller/resolver pass-through; GraphQL types |
| `apps/api/src/config/configuration.ts` | `careerLevel.classify` |
| `tsconfig.base.json`, `jest.config.js` | alias + mapper |
| `scripts/career-level-eval.ts` | evaluation report generator (dev only) |
| docs | README, `.env.example`, index, log, questions |

## 4. Risks

| Risk | Mitigation |
| ---- | ---------- |
| False-positive internship/new-grad labels mislead early-career users | precedence + guards, precision threshold in CI, `reasons[]` for triage |
| Cost on 20–30k-job keyword-less fan-outs | precompiled regexes, description capped at 3,000 chars, perf test |
| Merge conflicts with parallel lanes editing the same files (controller, aggregator, DTOs) | aggregator change isolated in a new wrapper + private method; controller/resolver change is one options field |
| Mutating cached raw job objects | classification is deterministic, so a cached object always carries the same value; the filter never mutates the raw array |
| NDJSON path (other lane) forgets to pass `careerLevels` | documented in the spec §7.3 and the final report; the field itself is attached regardless |
| A merge with the NDJSON lane (which also wraps `aggregateRaw` to stamp `dedupKey`) drops one wrapper | integration recipe in tasks T18: one public `aggregateRaw` = dedupAndPersist → dedupKey stamp → career level; one shared controller call passes `careerLevels` |
| A synchronous classification pass starves `/health` on a 30k-job result | cooperative chunks with a 10 ms yield budget (review fix T15), liveness test with a `setImmediate` probe |
