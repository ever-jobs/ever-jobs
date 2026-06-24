/**
 * next-spec-number — print the next available spec number for the current fork.
 *
 * Replaces the spec-kit default of "global max + 1" with a band-scoped
 * "max within MY fork's reserved range + 1", so that each fork (identified by
 * its `origin` remote) only ever mints numbers inside the band reserved for it
 * in `.specify/ranges.json`. This is what keeps fork numbering disjoint even
 * after bidirectional merges — see `.specify/specs/787-fork-spec-range-reservation/`.
 *
 * Usage:
 *   npm run spec:next            # prints e.g. 5018 in MakeDeeply/ever-jobs
 *   ts-node scripts/next-spec-number.ts [repoRoot]
 *
 * Fork identity is read from `git remote get-url origin`, overridable with the
 * `SPEC_FORK_REPO=owner/repo` env var (for mirrors / detached checkouts / CI).
 */

import { execSync } from 'child_process';
import * as path from 'path';

import {
  findRangeForRepo,
  listSpecNumbers,
  loadRanges,
  nextNumberInRange,
  parseOriginRepo,
} from './spec-ranges';

export function originRepoFromGit(repoRoot: string): string | null {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseOriginRepo(url);
  } catch {
    return null;
  }
}

function resolveForkRepo(repoRoot: string): string | null {
  const override = process.env.SPEC_FORK_REPO;
  if (override && override.trim()) return override.trim().toLowerCase();
  return originRepoFromGit(repoRoot);
}

export async function computeNextSpecNumber(repoRoot: string): Promise<number> {
  const ranges = await loadRanges(repoRoot);
  if (!ranges || ranges.length === 0) {
    throw new Error(
      'No .specify/ranges.json found (or it has no ranges) — cannot determine a fork band.',
    );
  }
  const repo = resolveForkRepo(repoRoot);
  if (!repo) {
    throw new Error(
      'Could not determine the origin repo. Set SPEC_FORK_REPO=owner/repo to override.',
    );
  }
  const band = findRangeForRepo(ranges, repo);
  if (!band) {
    throw new Error(
      `No reserved range for "${repo}" in .specify/ranges.json. Add a row for this fork first.`,
    );
  }
  const next = nextNumberInRange(await listSpecNumbers(repoRoot), band);
  if (next > band.end) {
    throw new Error(
      `Band "${band.fork}" [${band.start}-${band.end}] is exhausted — reserve another range.`,
    );
  }
  return next;
}

function isCliEntry(): boolean {
  try {
    if (typeof require !== 'undefined' && require.main === module) return true;
  } catch {
    /* not CJS — fall through */
  }
  const entry = process.argv[1] ?? '';
  return (
    entry.endsWith('next-spec-number.ts') || entry.endsWith('next-spec-number.js')
  );
}

if (isCliEntry()) {
  const repoRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : process.cwd();
  computeNextSpecNumber(repoRoot)
    .then((n) => {
      // eslint-disable-next-line no-console
      console.log(String(n));
    })
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`next-spec-number: ${err.message}`);
      process.exit(1);
    });
}
