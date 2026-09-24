import { CAREER_LEVELS, type CareerLevel, type CareerLevelInput, type CareerLevelVerdict } from '@ever-jobs/models';

import type { CareerLevelCase } from '../fixtures/career-level.fixture';

/** Per-class precision / recall over a labelled fixture. */
export interface ClassMetrics {
  level: CareerLevel;
  /** Gold cases of this class. */
  support: number;
  /** Predictions of this class. */
  predicted: number;
  truePositives: number;
  /** `NaN` when the class was never predicted. */
  precision: number;
  /** `NaN` when the class has no gold cases. */
  recall: number;
}

export interface EvaluationError {
  input: CareerLevelInput;
  expected: CareerLevel;
  actual: CareerLevel;
  reasons: string[];
}

export interface EvaluationResult {
  total: number;
  correct: number;
  accuracy: number;
  perClass: ClassMetrics[];
  /** confusion[gold][predicted] = count. */
  confusion: Record<CareerLevel, Record<CareerLevel, number>>;
  errors: EvaluationError[];
}

/** Run `classify` over every case and compute accuracy, per-class metrics and the confusion matrix. */
export function evaluate(
  cases: ReadonlyArray<CareerLevelCase>,
  classify: (input: CareerLevelInput) => CareerLevelVerdict,
): EvaluationResult {
  const confusion = Object.fromEntries(
    CAREER_LEVELS.map((gold) => [gold, Object.fromEntries(CAREER_LEVELS.map((p) => [p, 0]))]),
  ) as Record<CareerLevel, Record<CareerLevel, number>>;
  const errors: EvaluationError[] = [];
  let correct = 0;
  for (const c of cases) {
    const verdict = classify(c.input);
    confusion[c.expected][verdict.level] += 1;
    if (verdict.level === c.expected) correct += 1;
    else errors.push({ input: c.input, expected: c.expected, actual: verdict.level, reasons: verdict.reasons });
  }
  const perClass = CAREER_LEVELS.map((level): ClassMetrics => {
    const support = CAREER_LEVELS.reduce((n, p) => n + confusion[level][p], 0);
    const predicted = CAREER_LEVELS.reduce((n, g) => n + confusion[g][level], 0);
    const truePositives = confusion[level][level];
    return {
      level,
      support,
      predicted,
      truePositives,
      precision: predicted ? truePositives / predicted : Number.NaN,
      recall: support ? truePositives / support : Number.NaN,
    };
  });
  return { total: cases.length, correct, accuracy: cases.length ? correct / cases.length : Number.NaN, perClass, confusion, errors };
}

const pct = (x: number): string => (Number.isNaN(x) ? 'n/a' : x.toFixed(3));
const ABBR: Readonly<Record<CareerLevel, string>> = {
  internship: 'int',
  new_grad: 'ng',
  entry: 'ent',
  mid: 'mid',
  senior: 'sen',
  staff: 'stf',
  principal: 'prn',
  manager: 'mgr',
  director: 'dir',
  executive: 'exe',
  unknown: 'unk',
};

/** Markdown report: summary, per-class table, confusion matrix (rows = gold, columns = predicted). */
export function formatEvaluationMarkdown(result: EvaluationResult): string {
  const lines: string[] = [];
  lines.push(
    `Cases: **${result.total}** — correct: **${result.correct}** — accuracy: **${pct(result.accuracy)}**`,
    '',
    '| Level | Support | Predicted | TP | Precision | Recall |',
    '| ----- | ------: | --------: | -: | --------: | -----: |',
  );
  for (const m of result.perClass) {
    lines.push(`| \`${m.level}\` | ${m.support} | ${m.predicted} | ${m.truePositives} | ${pct(m.precision)} | ${pct(m.recall)} |`);
  }
  lines.push('', 'Confusion matrix (rows = gold label, columns = prediction):', '');
  lines.push(`| gold \\ pred | ${CAREER_LEVELS.map((l) => ABBR[l]).join(' | ')} |`);
  lines.push(`| --- | ${CAREER_LEVELS.map(() => '--:').join(' | ')} |`);
  for (const gold of CAREER_LEVELS) {
    lines.push(`| \`${gold}\` | ${CAREER_LEVELS.map((p) => (result.confusion[gold][p] ? String(result.confusion[gold][p]) : '·')).join(' | ')} |`);
  }
  if (result.errors.length) {
    lines.push('', 'Misclassified:', '');
    for (const e of result.errors) {
      lines.push(`- ${JSON.stringify(e.input.title ?? '')} — gold \`${e.expected}\`, got \`${e.actual}\` (${e.reasons.join('; ')})`);
    }
  }
  return lines.join('\n');
}
