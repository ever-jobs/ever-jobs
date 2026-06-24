/**
 * Unit tests for `scripts/docs-lint.ts`. Covers the five Spec-002 §7.1 checks
 * plus parser corner cases (code fences, inline code, fragment/query/line
 * suffixes, /-rooted vs ../ paths, frontmatter heuristics).
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  checkFrontmatter,
  extractLinks,
  formatResult,
  lintDocs,
  parseLogHeaders,
} from '../docs-lint';

async function makeRepo(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ever-jobs-doc-lint-'));
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

describe('docs-lint helpers', () => {
  describe('extractLinks', () => {
    it('extracts inline links', () => {
      const links = extractLinks('hello [a](./a.md) world');
      expect(links).toEqual([{ href: './a.md', line: 1 }]);
    });

    it('extracts multiple links across lines', () => {
      const links = extractLinks('[a](./a.md)\n[b](./b.md)\n');
      expect(links).toHaveLength(2);
      expect(links[0]).toEqual({ href: './a.md', line: 1 });
      expect(links[1]).toEqual({ href: './b.md', line: 2 });
    });

    it('skips links inside ``` fences', () => {
      const body = '```ts\n[a](./missing.md)\n```\n[b](./real.md)';
      const links = extractLinks(body);
      expect(links).toEqual([{ href: './real.md', line: 4 }]);
    });

    it('skips links inside ~~~ fences', () => {
      const body = '~~~\n[a](./missing.md)\n~~~';
      const links = extractLinks(body);
      expect(links).toEqual([]);
    });

    it('skips links inside inline code', () => {
      const body = 'see `[a](./missing.md)` for an example';
      const links = extractLinks(body);
      expect(links).toEqual([]);
    });

    it('extracts links whose link text contains inline code', () => {
      const body = '[`/AGENTS.md`](../AGENTS.md)';
      const links = extractLinks(body);
      expect(links).toEqual([{ href: '../AGENTS.md', line: 1 }]);
    });

    it('handles links with title attributes', () => {
      const body = '[a](./a.md "Title")';
      const links = extractLinks(body);
      expect(links).toEqual([{ href: './a.md', line: 1 }]);
    });
  });

  describe('parseLogHeaders', () => {
    it('parses date + run number', () => {
      const e = parseLogHeaders('## 2026-04-26 — Scheduled run #8 (foo)\nbody\n');
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ date: '2026-04-26', runNumber: 8 });
    });

    it('parses headers without a run number', () => {
      const e = parseLogHeaders('## 2026-04-26 — initial bootstrap\n');
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ date: '2026-04-26', runNumber: null });
    });

    it('returns empty for files with no log headers', () => {
      expect(parseLogHeaders('# Title\nbody\n')).toEqual([]);
    });

    it('records the file line number', () => {
      const e = parseLogHeaders(
        '# Log\n\n## 2026-04-26 — run #2\n\nfoo\n## 2026-04-26 — run #1\n',
      );
      expect(e[0].line).toBe(3);
      expect(e[1].line).toBe(6);
    });
  });

  describe('checkFrontmatter', () => {
    it('passes when an H1 + metadata table is present', () => {
      const body = '# Spec\n\n| Field | Value |\n| --- | --- |\n| ID | 1 |\n';
      expect(checkFrontmatter(body)).toBe(true);
    });

    it('fails when only an H1 with no table follows', () => {
      const body = '# Spec\n\nA plain paragraph with no metadata table.\n';
      expect(checkFrontmatter(body)).toBe(false);
    });

    it('fails when no H1 is present', () => {
      const body = '## Sub\n\n| Field | Value |\n| --- | --- |\n';
      expect(checkFrontmatter(body)).toBe(false);
    });
  });
});

describe('lintDocs', () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    await rmRf(tempRoot);
    tempRoot = null;
  });

  it('returns ok for a minimal compliant repo', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.ok).toBe(true);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('flags broken internal links', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n[a](./missing.md)\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.ok).toBe(false);
    expect(r.brokenLinks).toEqual([
      { from: 'docs/index.md:2', to: './missing.md' },
    ]);
  });

  it('skips external + anchor-only links', async () => {
    tempRoot = await makeRepo({
      'docs/index.md':
        '# Index\n[a](https://example.com)\n[b](#sec)\n[c](mailto:x@y.z)\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('strips :line suffix when resolving link targets', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n[a](./a.md)\n[b](./b.md:42)\n',
      'docs/a.md': '# A\n',
      'docs/b.md': '# B\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('strips fragment + query when resolving link targets', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n[a](./a.md#section)\n[b](./a.md?foo=bar)\n',
      'docs/a.md': '# A\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('flags unindexed docs', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
      'docs/orphan.md': '# Orphan\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.unindexedDocs).toEqual(['docs/orphan.md']);
  });

  it('exempts log.md, questions.md, and templates from the indexed-doc check', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
      'docs/log.md': '# Log\n',
      'docs/questions.md': '# Q\n',
      '.specify/templates/spec.template.md': '# Tpl\n',
      '.specify/README.md': '# Specify\n',
      '.specify/memory/constitution.md': '# C\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.unindexedDocs).toEqual([]);
  });

  it('detects duplicate log entries', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
      'docs/log.md':
        '# Log\n\n## 2026-04-26 — run #2\n\nfoo\n\n## 2026-04-26 — run #2\n\nbar\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.duplicateLogEntries).toHaveLength(1);
    expect(r.duplicateLogEntries[0]).toContain('2026-04-26#2');
  });

  it('detects out-of-order log entries (oldest at top)', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
      'docs/log.md':
        '# Log\n\n## 2026-01-01 — run #1\n\nold\n\n## 2026-04-26 — run #2\n\nnew\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.outOfOrderLogEntries.length).toBeGreaterThan(0);
  });

  it('passes when log entries are newest-at-top by date and by run number', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
      'docs/log.md':
        '# Log\n\n## 2026-04-26 — run #3\n\n3\n\n## 2026-04-26 — run #2\n\n2\n\n## 2026-04-25 — run #1\n\n1\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.outOfOrderLogEntries).toEqual([]);
    expect(r.duplicateLogEntries).toEqual([]);
  });

  it('flags spec.md and plan.md missing the H1+table frontmatter (tasks.md is exempt)', async () => {
    tempRoot = await makeRepo({
      'docs/index.md':
        '# Index\n[s](../.specify/specs/006-foo/spec.md)\n[p](../.specify/specs/006-foo/plan.md)\n[t](../.specify/specs/006-foo/tasks.md)\n',
      '.specify/specs/006-foo/spec.md': '# Spec\nNo metadata.\n',
      '.specify/specs/006-foo/plan.md':
        '# Plan\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      // tasks.md intentionally has no metadata table — should NOT be flagged
      // because the lint scope was narrowed in run #11 to spec.md + plan.md.
      '.specify/specs/006-foo/tasks.md': 'just a paragraph, no h1\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.missingFrontmatter).toEqual([
      '.specify/specs/006-foo/spec.md',
    ]);
  });

  it('resolves /-rooted links from the repo root', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n[a](/AGENTS.md)\n',
      'AGENTS.md': '# Agents\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('resolves ../-rooted links from docs/', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n[a](../AGENTS.md)\n',
      'AGENTS.md': '# Agents\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('ignores broken links inside fenced code blocks', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n```\n[a](./missing.md)\n```\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.brokenLinks).toHaveLength(0);
  });

  it('completes in well under 5 s on a 100-doc tree (NFR-1)', async () => {
    const layout: Record<string, string> = { 'docs/index.md': '# Index\n' };
    for (let i = 0; i < 100; i++) {
      layout[`docs/file${i}.md`] = `# F${i}\n[idx](./index.md)\n`;
      layout['docs/index.md'] += `- [F${i}](./file${i}.md)\n`;
    }
    tempRoot = await makeRepo(layout);
    const start = Date.now();
    const r = await lintDocs(tempRoot);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(r.ok).toBe(true);
  });

  it('passes when every spec number falls in a registered band', async () => {
    tempRoot = await makeRepo({
      'docs/index.md':
        '# Index\n[s](../.specify/specs/5008-foo/spec.md)\n[p](../.specify/specs/5008-foo/plan.md)\n[t](../.specify/specs/5008-foo/tasks.md)\n',
      '.specify/ranges.json': JSON.stringify({
        ranges: [
          { fork: 'ever-jobs', repo: 'ever-jobs/ever-jobs', start: 1, end: 4999 },
          { fork: 'makedeeply', repo: 'MakeDeeply/ever-jobs', start: 5000, end: 5999 },
        ],
      }),
      '.specify/specs/5008-foo/spec.md':
        '# Spec\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      '.specify/specs/5008-foo/plan.md':
        '# Plan\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      '.specify/specs/5008-foo/tasks.md': '# Tasks\n- [ ] do it\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.outOfBandSpecs).toEqual([]);
    expect(r.overlappingRanges).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('flags a spec number outside every registered band', async () => {
    tempRoot = await makeRepo({
      'docs/index.md':
        '# Index\n[s](../.specify/specs/9001-foo/spec.md)\n[p](../.specify/specs/9001-foo/plan.md)\n[t](../.specify/specs/9001-foo/tasks.md)\n',
      '.specify/ranges.json': JSON.stringify({
        ranges: [
          { fork: 'makedeeply', repo: 'MakeDeeply/ever-jobs', start: 5000, end: 5999 },
        ],
      }),
      '.specify/specs/9001-foo/spec.md':
        '# Spec\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      '.specify/specs/9001-foo/plan.md':
        '# Plan\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      '.specify/specs/9001-foo/tasks.md': '# Tasks\n- [ ] do it\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.outOfBandSpecs).toHaveLength(1);
    expect(r.outOfBandSpecs[0]).toContain('9001-foo');
    expect(r.ok).toBe(false);
  });

  it('flags overlapping bands in ranges.json', async () => {
    tempRoot = await makeRepo({
      'docs/index.md': '# Index\n',
      '.specify/ranges.json': JSON.stringify({
        ranges: [
          { fork: 'a', repo: 'a/x', start: 1, end: 5000 },
          { fork: 'b', repo: 'b/x', start: 5000, end: 5999 },
        ],
      }),
    });
    const r = await lintDocs(tempRoot);
    expect(r.overlappingRanges).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it('skips the band checks entirely when ranges.json is absent', async () => {
    tempRoot = await makeRepo({
      'docs/index.md':
        '# Index\n[s](../.specify/specs/9001-foo/spec.md)\n[p](../.specify/specs/9001-foo/plan.md)\n[t](../.specify/specs/9001-foo/tasks.md)\n',
      '.specify/specs/9001-foo/spec.md':
        '# Spec\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      '.specify/specs/9001-foo/plan.md':
        '# Plan\n\n| Field | Value |\n| --- | --- |\n| Spec | s |\n',
      '.specify/specs/9001-foo/tasks.md': '# Tasks\n- [ ] do it\n',
    });
    const r = await lintDocs(tempRoot);
    expect(r.outOfBandSpecs).toEqual([]);
    expect(r.overlappingRanges).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('formatResult', () => {
  it('emits the green-tick line when ok', () => {
    const out = formatResult({
      brokenLinks: [],
      unindexedDocs: [],
      duplicateLogEntries: [],
      outOfOrderLogEntries: [],
      missingFrontmatter: [],
      overlappingRanges: [],
      outOfBandSpecs: [],
      ok: true,
    });
    expect(out).toContain('Doc-lint passed');
  });

  it('emits one section per non-empty issue list', () => {
    const out = formatResult({
      brokenLinks: [{ from: 'docs/a.md:1', to: './missing.md' }],
      unindexedDocs: ['docs/orphan.md'],
      duplicateLogEntries: ['docs/log.md:5 duplicate of line 2 (2026-04-26#2)'],
      outOfOrderLogEntries: [
        'docs/log.md:8 (2026-04-26#2) is newer than line 5 (2026-04-26#3) — newest must be at top',
      ],
      missingFrontmatter: ['.specify/specs/006-foo/spec.md'],
      overlappingRanges: ['range "a" [1-5000] overlaps "b" [5000-5999]'],
      outOfBandSpecs: ['9001-foo (number 9001 is outside every reserved band)'],
      ok: false,
    });
    expect(out).toContain('1 broken link(s)');
    expect(out).toContain('1 doc(s) not linked');
    expect(out).toContain('1 duplicate log entry');
    expect(out).toContain('newest-at-top');
    expect(out).toContain('missing H1 + metadata table');
    expect(out).toContain('overlapping fork range');
    expect(out).toContain('outside every reserved range');
  });
});
