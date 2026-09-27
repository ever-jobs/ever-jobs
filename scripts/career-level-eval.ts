/**
 * career-level-eval — print the career-level classifier's evaluation report (Spec 1730).
 *
 * Runs `classifyCareerLevel` over the labelled fixture and prints accuracy, per-class
 * precision/recall, the confusion matrix and every misclassified case as Markdown, ready to paste
 * into `.specify/specs/1730-career-level-classifier/spec.md` §12. The CI gate lives in
 * `career-level.evaluation.spec.ts`; this script only renders the numbers.
 *
 * Usage:
 *   npx ts-node --project tsconfig.base.json -r tsconfig-paths/register scripts/career-level-eval.ts [all|design|holdout]
 */

import { classifyCareerLevel } from '@ever-jobs/career-level-classifier';

import {
  CAREER_LEVEL_CONTEXT_CASES,
  CAREER_LEVEL_FIXTURE,
  CAREER_LEVEL_HOLDOUT_CASES,
  CAREER_LEVEL_TITLE_CASES,
} from '../packages/plugins/career-level-classifier/__tests__/fixtures/career-level.fixture';
import {
  evaluate,
  formatEvaluationMarkdown,
} from '../packages/plugins/career-level-classifier/__tests__/support/evaluate';

const which = process.argv[2] ?? 'all';
const cases =
  which === 'design'
    ? [...CAREER_LEVEL_TITLE_CASES, ...CAREER_LEVEL_CONTEXT_CASES]
    : which === 'holdout'
      ? CAREER_LEVEL_HOLDOUT_CASES
      : CAREER_LEVEL_FIXTURE;

process.stdout.write(`Set: ${which}\n\n${formatEvaluationMarkdown(evaluate(cases, classifyCareerLevel))}\n`);
