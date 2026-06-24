/**
 * Unit tests for the fork spec-number range registry helpers
 * (`scripts/spec-ranges.ts`) and the `next-spec-number` allocator.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  extractSpecNumber,
  findOverlaps,
  findRangeForRepo,
  inRange,
  loadRanges,
  nextNumberInRange,
  parseOriginRepo,
  rangeForNumber,
  SpecRange,
} from '../spec-ranges';
import { computeNextSpecNumber } from '../next-spec-number';

const BANDS: SpecRange[] = [
  { fork: 'ever-jobs', repo: 'ever-jobs/ever-jobs', start: 1, end: 4999 },
  { fork: 'makedeeply', repo: 'MakeDeeply/ever-jobs', start: 5000, end: 5999 },
];

async function makeRepo(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ever-jobs-ranges-'));
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  return root;
}

async function rmRf(p: string | null): Promise<void> {
  if (!p) return;
  await fs.rm(p, { recursive: true, force: true });
}

describe('parseOriginRepo', () => {
  it('parses https URLs with .git suffix', () => {
    expect(parseOriginRepo('https://github.com/ever-jobs/ever-jobs.git')).toBe(
      'ever-jobs/ever-jobs',
    );
  });

  it('parses ssh URLs', () => {
    expect(parseOriginRepo('git@github.com:MakeDeeply/ever-jobs.git')).toBe(
      'makedeeply/ever-jobs',
    );
  });

  it('tolerates a proxy prefix and no .git suffix', () => {
    expect(
      parseOriginRepo('https://git-manager.example/proxy/github.com/Foo/Bar'),
    ).toBe('foo/bar');
  });

  it('returns null for unusable input', () => {
    expect(parseOriginRepo('')).toBeNull();
    expect(parseOriginRepo('just-one-segment')).toBeNull();
  });
});

describe('findRangeForRepo', () => {
  it('matches case-insensitively on repo', () => {
    expect(findRangeForRepo(BANDS, 'makedeeply/ever-jobs')?.fork).toBe(
      'makedeeply',
    );
    expect(findRangeForRepo(BANDS, 'ever-jobs/ever-jobs')?.fork).toBe(
      'ever-jobs',
    );
  });

  it('returns null when no band matches', () => {
    expect(findRangeForRepo(BANDS, 'acme/ever-jobs')).toBeNull();
  });
});

describe('extractSpecNumber', () => {
  it('reads the leading integer', () => {
    expect(extractSpecNumber('5008-ashby-field-name-fallbacks')).toBe(5008);
    expect(extractSpecNumber('006-foo')).toBe(6);
  });

  it('returns null without a leading number', () => {
    expect(extractSpecNumber('memory')).toBeNull();
  });
});

describe('inRange / rangeForNumber', () => {
  it('respects inclusive bounds', () => {
    expect(inRange(5000, BANDS[1])).toBe(true);
    expect(inRange(5999, BANDS[1])).toBe(true);
    expect(inRange(6000, BANDS[1])).toBe(false);
  });

  it('finds the containing band or null', () => {
    expect(rangeForNumber(BANDS, 750)?.fork).toBe('ever-jobs');
    expect(rangeForNumber(BANDS, 5008)?.fork).toBe('makedeeply');
    expect(rangeForNumber(BANDS, 6000)).toBeNull();
  });
});

describe('findOverlaps', () => {
  it('returns empty for disjoint bands', () => {
    expect(findOverlaps(BANDS)).toEqual([]);
  });

  it('flags overlapping bands', () => {
    const bad: SpecRange[] = [
      { fork: 'a', repo: 'a/x', start: 1, end: 5000 },
      { fork: 'b', repo: 'b/x', start: 5000, end: 5999 },
    ];
    expect(findOverlaps(bad)).toHaveLength(1);
    expect(findOverlaps(bad)[0]).toContain('overlaps');
  });
});

describe('nextNumberInRange', () => {
  it('returns max-in-band + 1', () => {
    expect(nextNumberInRange([5001, 5008, 5017, 750], BANDS[1])).toBe(5018);
  });

  it('returns band start when the band has no specs', () => {
    expect(nextNumberInRange([1, 2, 786], BANDS[1])).toBe(5000);
  });

  it('ignores numbers from other bands', () => {
    // ever-jobs band: highest in-band is 786 -> 787, not 5018
    expect(nextNumberInRange([786, 5001, 5017], BANDS[0])).toBe(787);
  });
});

describe('loadRanges', () => {
  it('returns null when the registry is absent', async () => {
    let root: string | null = null;
    try {
      root = await makeRepo({ 'README.md': '# x\n' });
      expect(await loadRanges(root)).toBeNull();
    } finally {
      await rmRf(root);
    }
  });

  it('parses the ranges array', async () => {
    let root: string | null = null;
    try {
      root = await makeRepo({
        '.specify/ranges.json': JSON.stringify({ ranges: BANDS }),
      });
      const r = await loadRanges(root);
      expect(r).toHaveLength(2);
      expect(r?.[1].fork).toBe('makedeeply');
    } finally {
      await rmRf(root);
    }
  });
});

describe('computeNextSpecNumber', () => {
  const prev = process.env.SPEC_FORK_REPO;
  afterEach(() => {
    if (prev === undefined) delete process.env.SPEC_FORK_REPO;
    else process.env.SPEC_FORK_REPO = prev;
  });

  it('allocates inside the local fork band', async () => {
    let root: string | null = null;
    try {
      root = await makeRepo({
        '.specify/ranges.json': JSON.stringify({ ranges: BANDS }),
        '.specify/specs/786-upstream/spec.md': '# x\n',
        '.specify/specs/5001-ours/spec.md': '# x\n',
        '.specify/specs/5017-ours-last/spec.md': '# x\n',
      });
      process.env.SPEC_FORK_REPO = 'makedeeply/ever-jobs';
      expect(await computeNextSpecNumber(root)).toBe(5018);
      process.env.SPEC_FORK_REPO = 'ever-jobs/ever-jobs';
      expect(await computeNextSpecNumber(root)).toBe(787);
    } finally {
      await rmRf(root);
    }
  });

  it('throws when the fork has no reserved band', async () => {
    let root: string | null = null;
    try {
      root = await makeRepo({
        '.specify/ranges.json': JSON.stringify({ ranges: BANDS }),
      });
      process.env.SPEC_FORK_REPO = 'acme/ever-jobs';
      await expect(computeNextSpecNumber(root)).rejects.toThrow(
        /No reserved range/,
      );
    } finally {
      await rmRf(root);
    }
  });

  it('throws when the band is exhausted', async () => {
    let root: string | null = null;
    try {
      root = await makeRepo({
        '.specify/ranges.json': JSON.stringify({
          ranges: [{ fork: 'tiny', repo: 'tiny/x', start: 9000, end: 9000 }],
        }),
        '.specify/specs/9000-only/spec.md': '# x\n',
      });
      process.env.SPEC_FORK_REPO = 'tiny/x';
      await expect(computeNextSpecNumber(root)).rejects.toThrow(/exhausted/);
    } finally {
      await rmRf(root);
    }
  });
});
