/**
 * Shared helpers for the fork spec-number range registry (`.specify/ranges.json`).
 *
 * The registry reserves a disjoint band of spec numbers per fork so that each
 * fork only ever mints numbers inside its own lane. This module is the single
 * source of truth used by both:
 *   - `scripts/next-spec-number.ts` (allocate the next number in the local band)
 *   - `scripts/docs-lint.ts`        (CI guard: bands disjoint, no spec outside
 *                                     any registered band)
 *
 * Zero runtime deps — plain fs + small string parsing, matching docs-lint.ts.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export interface SpecRange {
  fork: string;
  repo: string;
  start: number;
  end: number;
}

export interface RangesFile {
  ranges: SpecRange[];
}

/**
 * Load `.specify/ranges.json`. Returns `null` when the file does not exist
 * (so callers can treat the registry as optional), or throws when it exists
 * but is malformed.
 */
export async function loadRanges(repoRoot: string): Promise<SpecRange[] | null> {
  const p = path.join(repoRoot, '.specify', 'ranges.json');
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<RangesFile>;
  return Array.isArray(parsed.ranges) ? parsed.ranges : [];
}

/**
 * Normalize a git remote URL to `owner/repo` (lowercased), tolerating proxy
 * prefixes, ssh/https schemes, and a trailing `.git`. Returns `null` when the
 * URL has no recognizable `owner/repo` tail.
 *
 *   https://github.com/ever-jobs/ever-jobs.git            -> ever-jobs/ever-jobs
 *   git@github.com:MakeDeeply/ever-jobs.git               -> makedeeply/ever-jobs
 *   https://proxy.example/proxy/github.com/Foo/bar.git    -> foo/bar
 */
export function parseOriginRepo(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/\.git$/i, '');
  s = s.replace(/^git@[^:]+:/i, ''); // ssh: host:owner/repo
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme://
  const segs = s.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[segs.length - 2];
  const repo = segs[segs.length - 1];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** Find the band reserved for a given `owner/repo` (case-insensitive). */
export function findRangeForRepo(
  ranges: SpecRange[],
  repo: string,
): SpecRange | null {
  const key = repo.toLowerCase();
  return ranges.find((r) => r.repo.toLowerCase() === key) ?? null;
}

/** Parse the leading integer from a spec directory name, e.g. `5008-foo` -> 5008. */
export function extractSpecNumber(dirName: string): number | null {
  const m = dirName.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

export function inRange(n: number, r: SpecRange): boolean {
  return n >= r.start && n <= r.end;
}

/** The band that contains `n`, or `null` if no registered band does. */
export function rangeForNumber(ranges: SpecRange[], n: number): SpecRange | null {
  return ranges.find((r) => inRange(n, r)) ?? null;
}

/** Human-readable list of overlapping-band pairs (empty when disjoint). */
export function findOverlaps(ranges: SpecRange[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      if (a.start <= b.end && b.start <= a.end) {
        issues.push(
          `range "${a.fork}" [${a.start}-${a.end}] overlaps "${b.fork}" [${b.start}-${b.end}]`,
        );
      }
    }
  }
  return issues;
}

/**
 * Next number to mint inside a band: `max(existing numbers in band) + 1`, or
 * the band start when the band is empty. The caller must check the result does
 * not exceed `range.end` (band exhaustion).
 */
export function nextNumberInRange(existing: number[], r: SpecRange): number {
  const inBand = existing.filter((n) => inRange(n, r));
  return inBand.length ? Math.max(...inBand) + 1 : r.start;
}

/** Spec-directory numbers under `.specify/specs/` (unsorted, dedup not applied). */
export async function listSpecNumbers(repoRoot: string): Promise<number[]> {
  const dir = path.join(repoRoot, '.specify', 'specs');
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nums: number[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const n = extractSpecNumber(e.name);
    if (n !== null) nums.push(n);
  }
  return nums;
}
