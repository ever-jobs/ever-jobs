import { classifyCareerLevel } from '../src/career-level.rules';
import {
  CAREER_LEVEL_CONTEXT_CASES,
  CAREER_LEVEL_FIXTURE,
  CAREER_LEVEL_HOLDOUT_CASES,
  CAREER_LEVEL_REVIEW_REGRESSION_CASES,
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

  /**
   * The thresholds above are loose on purpose, so on their own they let a rule change silently
   * break a case that used to pass (one did during the 2026-09-25 review fixes: "Front of House
   * Manager" fell to `unknown` and every threshold stayed green). This gate pins the current
   * result: a case the rules are *known* to miss goes in KNOWN_MISSES with its reason; anything
   * else that is misclassified is a regression.
   */
  it('has no misclassification outside the documented known misses (regression gate)', () => {
    const KNOWN_MISSES: ReadonlyMap<string, string> = new Map<string, string>([]);
    const errors = evaluate(CAREER_LEVEL_FIXTURE, classifyCareerLevel).errors
      .filter((e) => !KNOWN_MISSES.has(e.input.title ?? ''))
      .map((e) => ({ title: e.input.title, expected: e.expected, actual: e.actual, reasons: e.reasons }));
    expect(errors).toEqual([]);
  });

  it('the review regressions are classified exactly as labelled', () => {
    const result = evaluate(CAREER_LEVEL_REVIEW_REGRESSION_CASES, classifyCareerLevel);
    expect(result.total).toBeGreaterThanOrEqual(30);
    expect(result.errors.map((e) => `${e.input.title}: gold ${e.expected}, got ${e.actual}`)).toEqual([]);
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

/**
 * Cost tripwires (Spec 1730, NFR-2). Wall-clock assertions on shared CI runners flake, so these
 * bound what a *regression* looks like rather than restating the NFR: the NFR figure itself is
 * measured directly and recorded in spec §12.4 (~90–100 µs/job on a loaded workstation; 30,000
 * jobs took 13.4 s inside a fully parallel jest run on the same machine).
 */
describe('career-level classifier — cost tripwires (Spec 1730, NFR-2)', () => {
  const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

  it('average cost per job with a ~3 KB description stays under 2 ms', () => {
    const titles = CAREER_LEVEL_TITLE_CASES.map((c) => c.input.title ?? '');
    const paragraph =
      'We are looking for an engineer to join our team. You will design, build and operate services ' +
      'used by millions of customers, collaborate with product and design, and mentor others. ' +
      'Requirements: 3+ years of experience with TypeScript or Go; strong communication skills. ';
    const description = paragraph.repeat(Math.ceil(3200 / paragraph.length));
    const n = 5_000;
    const inputs = Array.from({ length: n }, (_, i) => ({ title: titles[i % titles.length], description }));

    const started = process.hrtime.bigint();
    let classified = 0;
    for (const input of inputs) {
      if (classifyCareerLevel(input).level) classified += 1;
    }
    const perJobMs = ms(started) / n;

    expect(classified).toBe(n);
    expect(perJobMs).toBeLessThan(2);
  });

  it('pathological inputs cannot trigger catastrophic regex backtracking', () => {
    const adversarial: Array<{ title: string; description?: string }> = [
      { title: 'senior '.repeat(800), description: 'years '.repeat(1000) },
      { title: 'intern program manager '.repeat(200), description: '5 '.repeat(3000) },
      { title: 'a'.repeat(5000), description: `${'experience of '.repeat(400)}years` },
      { title: 'Engineer I/II/III/IV/V '.repeat(200), description: 'this is a '.repeat(600) },
      { title: 'co-op '.repeat(700), description: `${'as a '.repeat(1500)}intern` },
      { title: '- , ( ) / | : ; '.repeat(400), description: '<b>'.repeat(2000) },
      // Descriptions are scanned up to MAX_DESCRIPTION_SCAN_CHARS (64 KB) when markup hides the
      // text: "<" with no ">" must not make the tag strip quadratic over that window.
      { title: 'Engineer', description: '<b'.repeat(40_000) },
      { title: 'Engineer', description: `${'<div style="color:#333"><span>'.repeat(8_000)}0-1 years of experience` },
      { title: 'Engineer', description: '&amp'.repeat(20_000) },
    ];
    for (const input of adversarial) {
      const started = process.hrtime.bigint();
      classifyCareerLevel(input);
      expect({ title: input.title.slice(0, 20), ms: ms(started) < 250 }).toEqual({
        title: input.title.slice(0, 20),
        ms: true,
      });
    }
  });

  /**
   * The title is capped (MAX_TITLE_CHARS) because the title analysis is super-linear in the
   * input length. `employmentType` / `jobLevel` go through the same analysis and
   * `experienceRange` through its own regexes; all three are scraped third-party strings, so an
   * oversized value must be capped too (Spec 1730 review: a 60 KB `jobLevel` took ~1.1 s and a
   * 240 KB one ~21 s inside a single synchronous call, which no chunking can yield out of).
   */
  it('over-long structured source fields are capped like the title', () => {
    const junk = 'senior intern manager, director - lead / staff engineer ii; '.repeat(1_000); // ~60 KB
    const adversarial: Array<[string, Record<string, string>]> = [
      ['employmentType', { employmentType: junk }],
      ['jobLevel', { jobLevel: junk }],
      ['experienceRange', { experienceRange: `${'1 to '.repeat(12_000)}years` }],
      ['all fields', { title: junk, employmentType: junk, jobLevel: junk, experienceRange: junk, description: junk }],
    ];
    for (const [name, input] of adversarial) {
      const started = process.hrtime.bigint();
      const verdict = classifyCareerLevel(input);
      const elapsed = ms(started);
      expect({ name, fast: elapsed < 250, longestReason: Math.max(...verdict.reasons.map((r) => r.length)) <= 160 })
        .toEqual({ name, fast: true, longestReason: true });
    }
  });
});
