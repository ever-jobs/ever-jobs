/**
 * Career-level classifier contract (Spec 1730, cross-repo contract C7).
 *
 * A deterministic, explainable, in-process signal: given what a posting says about itself
 * (title first, then structured source fields, then the opening of the description), classify
 * the career level it targets — internship, new-grad, entry … executive — with a confidence and
 * short human-readable reasons. Implementations are registered as NestJS providers under
 * {@link CAREER_LEVEL_CLASSIFIER_TOKEN}. Pure + in-memory — never throws, no network, no clock.
 *
 * The source-provided `jobType` / `jobLevel` / `experienceRange` fields are inputs only; a
 * classifier never mutates them.
 */

/** DI token used to register the active career-level classifier plugin. */
export const CAREER_LEVEL_CLASSIFIER_TOKEN = 'CAREER_LEVEL_CLASSIFIER';

/**
 * Every level a verdict can carry, from the most junior to the most senior, with `unknown`
 * last. Individual-contributor rungs run `internship → principal`; management rungs are
 * `manager → director → executive`.
 */
export const CAREER_LEVELS = [
  'internship',
  'new_grad',
  'entry',
  'mid',
  'senior',
  'staff',
  'principal',
  'manager',
  'director',
  'executive',
  'unknown',
] as const;

/** One of {@link CAREER_LEVELS}. */
export type CareerLevel = (typeof CAREER_LEVELS)[number];

/** How strongly the evidence supports the level. */
export const CAREER_LEVEL_CONFIDENCES = ['high', 'medium', 'low'] as const;

/** One of {@link CAREER_LEVEL_CONFIDENCES}. */
export type CareerLevelConfidence = (typeof CAREER_LEVEL_CONFIDENCES)[number];

/** Per-posting classification, attached to `JobPostDto.careerLevel`. */
export interface CareerLevelVerdict {
  /** The classified level; `unknown` when nothing in the posting states one. */
  level: CareerLevel;
  /** `high` for an explicit title keyword, `low` for description-only or conflicting evidence. */
  confidence: CareerLevelConfidence;
  /** Short, human-readable reasons naming the rule(s) that fired (at most five). */
  reasons: string[];
}

/** The facts the classifier reasons over — all already present on a `JobPostDto`. */
export interface CareerLevelInput {
  /** Posting title (primary signal). */
  title?: string | null;
  /** Posting description; only the opening ~3,000 characters are read. */
  description?: string | null;
  /** Source-provided job types (`JobType` values, e.g. `internship`). */
  jobType?: ReadonlyArray<string> | null;
  /** Source-provided employment type (ATS free text, e.g. `Intern`, `Full-time`). */
  employmentType?: string | null;
  /** Source-provided seniority (LinkedIn vocabulary, e.g. `Entry level`, `Mid-Senior level`). */
  jobLevel?: string | null;
  /** Source-provided experience range (e.g. `0-2 Yrs`, `Fresher`). */
  experienceRange?: string | null;
}

/**
 * Career-level classifier contract.
 *
 * Implementations MUST be pure (deterministic, no I/O), never throw, and preserve input order in
 * {@link ICareerLevelClassifier.classifyBatch}.
 */
export interface ICareerLevelClassifier {
  /** Classify a single posting. */
  classify(input: CareerLevelInput): CareerLevelVerdict;
  /**
   * Classify many postings; results align to input order (one verdict per input). The jobs
   * aggregator calls this on small slices of the result set, yielding to the event loop between
   * slices, so an implementation must not assume it sees the whole set in one call.
   */
  classifyBatch(inputs: ReadonlyArray<CareerLevelInput>): CareerLevelVerdict[];
}

const CAREER_LEVEL_SET: ReadonlySet<string> = new Set<string>(CAREER_LEVELS);

/** Type guard: is `value` one of {@link CAREER_LEVELS}? */
export function isCareerLevel(value: unknown): value is CareerLevel {
  return typeof value === 'string' && CAREER_LEVEL_SET.has(value);
}
