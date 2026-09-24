import { classifyCareerLevel } from '../src/career-level.rules';
import {
  CAREER_LEVEL_CONTEXT_CASES,
  CAREER_LEVEL_FIXTURE,
  CAREER_LEVEL_HOLDOUT_CASES,
  CAREER_LEVEL_TITLE_CASES,
} from './fixtures/career-level.fixture';
import { evaluate, formatEvaluationMarkdown, type EvaluationResult } from './support/evaluate';

/**
 * Fixture evaluation with CI thresholds (Spec 1730, FR-11 / NFR-3).
 *
 * Thresholds are the spec's contract, not the current score: precision ≥ 0.95 on the two classes
 * early-career users filter on, recall ≥ 0.90 on both, and ≥ 0.90 overall accuracy. The report is
 * attached to the failure message so a regression names the titles it broke.
 */
function metric(result: EvaluationResult, level: string, key: 'precision' | 'recall'): number {
  return result.perClass.find((m) => m.level === level)![key];
}

function expectThresholds(result: EvaluationResult): void {
  const report = formatEvaluationMarkdown(result);
  const checks: Array<[string, number, number]> = [
    ['internship precision', metric(result, 'internship', 'precision'), 0.95],
    ['new_grad precision', metric(result, 'new_grad', 'precision'), 0.95],
    ['internship recall', metric(result, 'internship', 'recall'), 0.9],
    ['new_grad recall', metric(result, 'new_grad', 'recall'), 0.9],
    ['accuracy', result.accuracy, 0.9],
  ];
  const failed = checks.filter(([, value, min]) => !(value >= min));
  if (failed.length) {
    throw new Error(
      `Career-level thresholds not met: ${failed.map(([n, v, m]) => `${n} ${v.toFixed(3)} < ${m}`).join(', ')}\n\n${report}`,
    );
  }
}

describe('career-level classifier — fixture evaluation (Spec 1730)', () => {
  it('the fixture is large enough and covers every class', () => {
    expect(CAREER_LEVEL_TITLE_CASES.length + CAREER_LEVEL_HOLDOUT_CASES.length).toBeGreaterThanOrEqual(250);
    expect(CAREER_LEVEL_CONTEXT_CASES.length).toBeGreaterThanOrEqual(10);
    const result = evaluate(CAREER_LEVEL_FIXTURE, classifyCareerLevel);
    for (const m of result.perClass) {
      expect({ level: m.level, support: m.support }).toEqual({ level: m.level, support: expect.any(Number) });
      expect(m.support).toBeGreaterThanOrEqual(5);
    }
  });

  it('meets the thresholds on the whole fixture', () => {
    expectThresholds(evaluate(CAREER_LEVEL_FIXTURE, classifyCareerLevel));
  });

  it('meets the thresholds on the held-out titles alone', () => {
    expectThresholds(evaluate(CAREER_LEVEL_HOLDOUT_CASES, classifyCareerLevel));
  });

  it('never labels a gold non-early-career title as internship or new_grad in the tricky-negative set', () => {
    const negatives = CAREER_LEVEL_FIXTURE.filter(
      (c) => c.expected !== 'internship' && c.expected !== 'new_grad',
    );
    const leaks = negatives
      .map((c) => ({ title: c.input.title, got: classifyCareerLevel(c.input).level }))
      .filter((r) => r.got === 'internship' || r.got === 'new_grad');
    expect(leaks).toEqual([]);
  });
});

describe('career-level classifier — cost (Spec 1730, NFR-2)', () => {
  it('classifies 30,000 jobs with ~3 KB descriptions quickly', () => {
    const titles = CAREER_LEVEL_TITLE_CASES.map((c) => c.input.title ?? '');
    const paragraph =
      'We are looking for an engineer to join our team. You will design, build and operate services ' +
      'used by millions of customers, collaborate with product and design, and mentor others. ' +
      'Requirements: 3+ years of experience with TypeScript or Go; strong communication skills. ';
    const description = paragraph.repeat(Math.ceil(3200 / paragraph.length));
    const inputs = Array.from({ length: 30_000 }, (_, i) => ({ title: titles[i % titles.length], description }));

    const started = process.hrtime.bigint();
    let classified = 0;
    for (const input of inputs) {
      if (classifyCareerLevel(input).level) classified += 1;
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(classified).toBe(30_000);
    // Generous CI bound (shared runners); the spec records the measured figure.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
